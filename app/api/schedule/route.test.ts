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

import { POST } from "./route";

const sqlMockTyped = sqlMock as unknown as Mock;
const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

function queryText(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join(" ");
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
});
