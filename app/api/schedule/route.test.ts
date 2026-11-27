import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { sqlMock, requireWorkspaceMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/schedule-events", () => ({ recordScheduleEvent: vi.fn() }));
vi.mock("@/lib/avatar/media", () => ({
  isAvatarCompositeUrl: vi.fn(),
  assertAvatarCompositeUrl: vi.fn(),
}));

import { recordScheduleEvent } from "@/lib/schedule-events";
import {
  assertAvatarCompositeUrl,
  isAvatarCompositeUrl,
} from "@/lib/avatar/media";
import { POST } from "./route";

const sqlMockTyped = sqlMock as unknown as Mock;
const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

function queryText(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join(" ");
}

function statementCalls() {
  return sqlMockTyped.mock.calls.filter((call) =>
    /^(WITH|SELECT|INSERT|UPDATE|DELETE)\b/.test(queryText(call).trim())
  );
}

/** Dispatch mocked results by SQL marker, mirroring the route's queries. */
function useDb(overrides: {
  newsItem?: unknown[];
  draft?: unknown[];
  page?: unknown[];
  insert?: unknown[];
} = {}) {
  sqlMockTyped.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("INSERT INTO scheduled_posts")) {
      return overrides.insert ?? [{ id: 1, news_item_id: null, scheduled_for: "", status: "scheduled" }];
    }
    if (query.includes("FROM facebook_pages")) return overrides.page ?? [];
    if (query.includes("FROM drafts")) return overrides.draft ?? [];
    if (query.includes("FROM news_items")) return overrides.newsItem ?? [];
    return [];
  });
}

beforeEach(() => {
  sqlMockTyped.mockReset();
  requireWorkspaceMock.mockReset();
  requireWorkspaceMock.mockResolvedValue(access);
  vi.mocked(isAvatarCompositeUrl).mockReturnValue(false);
  vi.mocked(assertAvatarCompositeUrl).mockResolvedValue(undefined);
});

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/schedule", () => {
  it("links a story only after verifying it belongs to the workspace", async () => {
    useDb({ newsItem: [{ id: 5 }], draft: [{ id: 9 }] });

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      newsItemId: 5,
      draftId: 9,
    });
    expect(res.status).toBe(201);

    // Both verified identifiers reach the INSERT.
    const insert = sqlMockTyped.mock.calls.find((call) =>
      queryText(call).includes("INSERT INTO scheduled_posts")
    );
    expect(insert![1]).toBe("ws1");
    expect(insert![2]).toBe(5);
    expect(insert![3]).toBe(9);
  });

  it("rejects a foreign newsItemId with 404 and never inserts", async () => {
    useDb({ newsItem: [], draft: [{ id: 9 }] });

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      newsItemId: 999,
    });
    expect(res.status).toBe(404);

    const inserted = sqlMockTyped.mock.calls.some((call) =>
      queryText(call).includes("INSERT INTO scheduled_posts")
    );
    expect(inserted).toBe(false);
  });

  it("rejects a foreign draftId with 404 and never inserts", async () => {
    useDb({ newsItem: [{ id: 5 }], draft: [] });

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      newsItemId: 5,
      draftId: 999,
    });
    expect(res.status).toBe(404);

    const inserted = sqlMockTyped.mock.calls.some((call) =>
      queryText(call).includes("INSERT INTO scheduled_posts")
    );
    expect(inserted).toBe(false);
  });

  it("stores null identifiers when none are supplied", async () => {
    useDb({});

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(res.status).toBe(201);

    const insert = sqlMockTyped.mock.calls.find((call) =>
      queryText(call).includes("INSERT INTO scheduled_posts")
    );
    // No ownership lookup ran and the identifiers are null.
    expect(sqlMockTyped.mock.calls.some((call) => queryText(call).includes("FROM news_items"))).toBe(false);
    expect(insert![2]).toBeNull();
    expect(insert![3]).toBeNull();
  });

  it("schedules a video by storing its URL with kind video", async () => {
    useDb({ newsItem: [{ id: 5 }] });

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      newsItemId: 5,
      videoUrl: "https://store.example/video.mp4",
      imageUrls: ["https://store.example/should-be-ignored.png"],
    });
    expect(res.status).toBe(201);

    const insert = sqlMockTyped.mock.calls.find((call) =>
      queryText(call).includes("INSERT INTO scheduled_posts")
    );
    expect(insert![5]).toBe("https://store.example/video.mp4");
    expect(insert![6]).toBeNull();
    expect(insert![8]).toBe("video");
  });

  it("atomically claims an avatar and inserts its database URL in one statement", async () => {
    useDb({});
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();

    const res = await post({
      text: "hello",
      scheduledFor,
      avatarJobId: "avatar-1",
      videoUrl: "https://store.example/avatar.mp4",
    });

    expect(res.status).toBe(201);
    expect(statementCalls()).toHaveLength(1);
    const claimInsert = statementCalls()[0];
    const query = queryText(claimInsert);
    expect(query).toContain("WITH claimed_avatar AS");
    expect(query).toContain("UPDATE avatar_jobs");
    expect(query).toContain("publish_state = 'scheduled'");
    expect(query).toContain("status = 'completed' AND publish_state = 'ready'");
    expect(
      sqlMockTyped.mock.calls.some((call) =>
        queryText(call).includes("AND blob_url =")
      )
    ).toBe(true);
    expect(query).toContain("INSERT INTO scheduled_posts");
    expect(query).not.toContain("claimed_avatar.blob_url");
    expect(query).toContain("claimed_avatar.id");
    expect(claimInsert[1]).toBe("avatar-1");
    expect(claimInsert[2]).toBe("ws1");
    expect(claimInsert).toContain("https://store.example/avatar.mp4");
    expect(claimInsert[9]).toBeNull();
    expect(claimInsert[10]).toBe(scheduledFor);
    expect(recordScheduleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduled",
        metadata: expect.objectContaining({ avatarJobId: "avatar-1" }),
      })
    );
  });

  it("validates and durably stores a composite instead of the source avatar URL", async () => {
    useDb({});
    const compositeUrl =
      "https://store.example/compose/avatars/avatar-1/avatar-composite.mp4";
    vi.mocked(isAvatarCompositeUrl).mockReturnValue(true);

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      avatarJobId: "avatar-1",
      videoUrl: compositeUrl,
    });

    expect(res.status).toBe(201);
    expect(assertAvatarCompositeUrl).toHaveBeenCalledWith("avatar-1", compositeUrl);
    const statements = statementCalls();
    expect(statements).toHaveLength(1);
    const claimInsert = statements[0];
    const query = queryText(claimInsert);
    expect(query).not.toContain("claimed_avatar.blob_url");
    expect(claimInsert).toContain(compositeUrl);
    expect(
      sqlMockTyped.mock.calls.some((call) =>
        queryText(call).includes("AND blob_url =")
      )
    ).toBe(false);
    expect(vi.mocked(assertAvatarCompositeUrl).mock.invocationCallOrder[0]).toBeLessThan(
      sqlMockTyped.mock.invocationCallOrder[sqlMockTyped.mock.calls.indexOf(claimInsert)]
    );
  });

  it("rejects an unverified composite before the atomic claim", async () => {
    useDb({});
    vi.mocked(isAvatarCompositeUrl).mockReturnValue(true);
    vi.mocked(assertAvatarCompositeUrl).mockRejectedValue(new Error("not staged"));

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      avatarJobId: "avatar-1",
      videoUrl: "https://store.example/compose/avatars/avatar-1/missing.mp4",
    });

    expect(res.status).toBe(400);
    expect(sqlMockTyped).not.toHaveBeenCalled();
  });

  it("returns 409 without an event when the atomic avatar claim inserts no row", async () => {
    useDb({ insert: [] });

    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      avatarJobId: "avatar-stale",
      videoUrl: "https://store.example/avatar.mp4",
    });

    expect(res.status).toBe(409);
    expect(statementCalls()).toHaveLength(1);
    expect(recordScheduleEvent).not.toHaveBeenCalled();
  });

  it("requires a video URL before claiming an avatar", async () => {
    const res = await post({
      text: "hello",
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      avatarJobId: "avatar-1",
    });

    expect(res.status).toBe(400);
    expect(sqlMockTyped).not.toHaveBeenCalled();
  });
});
