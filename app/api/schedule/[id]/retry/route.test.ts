import { beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock, requireWorkspaceMock, recordEventMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
  recordEventMock: vi.fn(),
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
vi.mock("@/lib/schedule-events", () => ({ recordScheduleEvent: recordEventMock }));

import { POST } from "./route";

const access = { user: { id: "u1" }, workspace: { id: "ws1" } };
const failedPost = {
  id: 51,
  workspace_id: "ws1",
  news_item_id: 7,
  status: "failed",
  attempts: 3,
  kind: "video",
};

function retry() {
  return POST(
    new Request("http://localhost/api/schedule/51/retry", { method: "POST" }),
    { params: Promise.resolve({ id: "51" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  recordEventMock.mockResolvedValue(undefined);
});

describe("POST /api/schedule/[id]/retry", () => {
  it("requires authentication", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const res = await retry();

    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or foreign post", async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await retry();

    expect(res.status).toBe(404);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a post that is not failed", async () => {
    sqlMock.mockResolvedValueOnce([{ ...failedPost, status: "scheduled" }]);

    const res = await retry();

    expect(res.status).toBe(400);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("atomically reclaims the same scheduled avatar and resets only an unstarted failed row", async () => {
    sqlMock
      .mockResolvedValueOnce([failedPost])
      .mockResolvedValueOnce([{ id: 51 }]);

    const res = await retry();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, status: "scheduled" });
    const query = (sqlMock.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("workspace_id =");
    expect(query).toContain("facebook_post_id IS NULL");
    expect(query).toContain("publish_started_at IS NULL");
    expect(query).toContain("FOR UPDATE");
    expect(query).toContain("UPDATE avatar_jobs");
    expect(query).toContain("publish_state = 'scheduled'");
    expect(query).toContain("avatar_jobs.blob_url = eligible.image_url");
    expect(query).toContain("'/compose/avatars/' || avatar_jobs.id || '/'");
    expect(query).toContain("publish_started_at = NULL");
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "retrying", scheduledPostId: 51 })
    );
  });

  it("returns 409 without recording a retry when the atomic reclaim loses", async () => {
    sqlMock
      .mockResolvedValueOnce([failedPost])
      .mockResolvedValueOnce([]);

    const res = await retry();

    expect(res.status).toBe(409);
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
