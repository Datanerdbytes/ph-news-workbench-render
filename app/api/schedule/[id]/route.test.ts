import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sqlMock,
  requireWorkspaceMock,
  recordEventMock,
  resolvePageTokenMock,
  rescheduleMock,
  heldMock,
} = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
  recordEventMock: vi.fn(),
  resolvePageTokenMock: vi.fn(),
  rescheduleMock: vi.fn(),
  heldMock: vi.fn(),
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
vi.mock("@/lib/schedule-events", () => ({
  recordScheduleEvent: recordEventMock,
}));
vi.mock("@/lib/facebook", () => ({
  cancelFacebookScheduledPost: vi.fn(),
  isFacebookStillScheduled: heldMock,
  rescheduleFacebookScheduledPost: rescheduleMock,
}));
vi.mock("@/lib/facebook-page-token", () => ({
  resolvePageToken: resolvePageTokenMock,
}));

import { DELETE, PATCH } from "./route";

const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

const localRow = {
  id: 51,
  workspace_id: "ws1",
  news_item_id: 7,
  kind: "post",
  source: "local",
  status: "scheduled",
  scheduled_for: "2026-11-20T09:00:00.000Z",
  facebook_post_id: null,
  facebook_post_ids: null,
  page_id: null,
};

const NEW_TIME = "2026-11-21T02:30:00.000Z";

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/schedule/51", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function params(id = "51") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  requireWorkspaceMock.mockResolvedValue(access);
  recordEventMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PATCH /api/schedule/[id]", () => {
  it("moves a workspace-scheduled post and records the event", async () => {
    sqlMock
      .mockResolvedValueOnce([localRow])
      .mockResolvedValueOnce([{ id: 51 }])
      .mockResolvedValueOnce([{ id: 51, scheduled_for: NEW_TIME }]);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ id: 51, scheduled_for: NEW_TIME });
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rescheduled",
        source: "calendar",
        scheduledPostId: 51,
        metadata: { from: localRow.scheduled_for, to: NEW_TIME },
      })
    );
    // The claim flips the row out of 'scheduled' for the duration, pinned to
    // the time that was read; the finish writes the new time and flips back.
    const claimText = (sqlMock.mock.calls[1][0] as string[]).join("?");
    expect(claimText).toContain("status = 'rescheduling'");
    expect(sqlMock.mock.calls[1]).toContain(localRow.scheduled_for);
    const finishCall = sqlMock.mock.calls[2];
    const finishText = (finishCall[0] as string[]).join("?");
    expect(finishText).toContain("status = 'scheduled'");
    expect(finishText).toContain("scheduled_for =");
    expect(finishCall).toContain(NEW_TIME);
  });

  it("refuses platforms that cannot move an accepted schedule", async () => {
    sqlMock.mockResolvedValueOnce([{ ...localRow, source: "youtube" }]);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toContain("YouTube is holding this post");
    expect(data.error).toContain("Cancel it");
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  describe("Facebook-held rows", () => {
    const facebookRow = {
      ...localRow,
      source: "facebook",
      facebook_post_id: "vid9",
      page_id: "pg1",
      facebook_post_ids: [
        { id: "vid9", ok: true, page: { id: "pg1", name: "The Daily Buzz" } },
      ],
    };
    const NEW_UNIX = Math.floor(Date.parse(NEW_TIME) / 1000);

    beforeEach(() => {
      resolvePageTokenMock.mockResolvedValue("tok");
      heldMock.mockResolvedValue(true);
      rescheduleMock.mockResolvedValue(undefined);
    });

    it("claims the row before moving Facebook and records the event", async () => {
      sqlMock
        .mockResolvedValueOnce([facebookRow])
        .mockResolvedValueOnce([{ id: 51 }])
        .mockResolvedValueOnce([{ id: 51, scheduled_for: NEW_TIME }]);

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());

      expect(res.status).toBe(200);
      // The claim lands before the first Graph call and the finish after the
      // last one, so no competing request can read the in-flight time.
      expect(sqlMock.mock.invocationCallOrder[1]).toBeLessThan(
        rescheduleMock.mock.invocationCallOrder[0]
      );
      expect(rescheduleMock.mock.invocationCallOrder[0]).toBeLessThan(
        sqlMock.mock.invocationCallOrder[2]
      );
      expect(resolvePageTokenMock).toHaveBeenCalledWith("ws1", "pg1");
      expect(rescheduleMock).toHaveBeenCalledWith("vid9", "tok", NEW_UNIX, "pg1");
      expect(recordEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "rescheduled" })
      );
    });

    it("refuses while another request holds the claim", async () => {
      sqlMock.mockResolvedValueOnce([
        { ...facebookRow, status: "rescheduling" },
      ]);

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.error).toContain("being rescheduled right now");
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(sqlMock).toHaveBeenCalledTimes(1);
    });

    it("refuses a second reschedule before it reaches Facebook", async () => {
      sqlMock
        .mockResolvedValueOnce([facebookRow])
        .mockResolvedValueOnce([]);

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.error).toContain("changed while it was being rescheduled");
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(recordEventMock).not.toHaveBeenCalled();
    });

    it("keeps the old time and drops the claim when Facebook refuses", async () => {
      sqlMock
        .mockResolvedValueOnce([facebookRow])
        .mockResolvedValueOnce([{ id: 51 }]);
      rescheduleMock.mockRejectedValue(new Error("(#10) permission denied"));

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.error).toContain("Facebook refused to move this item");
      expect(data.error).toContain("(#10) permission denied");
      // Read, claim, then release — no event for a move that never happened.
      expect(sqlMock).toHaveBeenCalledTimes(3);
      const releaseText = (sqlMock.mock.calls[2][0] as string[]).join("?");
      expect(releaseText).toContain("status = 'scheduled'");
      expect(releaseText).toContain("status = 'rescheduling'");
      expect(recordEventMock).not.toHaveBeenCalled();
    });

    it("reports when Facebook already released the item", async () => {
      sqlMock
        .mockResolvedValueOnce([facebookRow])
        .mockResolvedValueOnce([{ id: 51 }]);
      heldMock.mockResolvedValue(false);

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.error).toContain("no longer holds this item");
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(sqlMock).toHaveBeenCalledTimes(3);
    });

    it("updates the row and warns when only some Pages took the new time", async () => {
      sqlMock
        .mockResolvedValueOnce([
          {
            ...facebookRow,
            facebook_post_ids: [
              { id: "vid9", ok: true, page: { id: "pg1", name: "Page A" } },
              { id: "vid10", ok: true, page: { id: "pg2", name: "Page B" } },
            ],
          },
        ])
        .mockResolvedValueOnce([{ id: 51 }])
        .mockResolvedValueOnce([{ id: 51, scheduled_for: NEW_TIME }]);
      rescheduleMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("(#10) permission denied"));

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.scheduled_for).toBe(NEW_TIME);
      expect(data.warning).toContain("It did move on 1 of 2 Pages");
      expect(data.warning).toContain("(#10) permission denied");
      expect(recordEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: "rescheduled" })
      );
    });

    it("refuses a time beyond Facebook's 29-day cap before calling Graph", async () => {
      sqlMock.mockResolvedValueOnce([facebookRow]);

      const res = await PATCH(
        patchRequest({ scheduledFor: "2026-12-16T08:00:00.000Z" }),
        params()
      );
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain("29 days");
      expect(resolvePageTokenMock).not.toHaveBeenCalled();
      expect(rescheduleMock).not.toHaveBeenCalled();
    });

    it("keeps the old time when a Page token cannot even be read", async () => {
      sqlMock
        .mockResolvedValueOnce([facebookRow])
        .mockResolvedValueOnce([{ id: 51, scheduled_for: NEW_TIME }]);
      resolvePageTokenMock.mockRejectedValueOnce(new Error("connection reset"));

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(409);
      expect(data.error).toContain("could not be read");
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(sqlMock).toHaveBeenCalledTimes(3);
    });

    it("updates the row and warns when a later Page token lookup throws", async () => {
      sqlMock
        .mockResolvedValueOnce([
          {
            ...facebookRow,
            facebook_post_ids: [
              { id: "vid9", ok: true, page: { id: "pg1", name: "Page A" } },
              { id: "vid10", ok: true, page: { id: "pg2", name: "Page B" } },
            ],
          },
        ])
        .mockResolvedValueOnce([{ id: 51 }])
        .mockResolvedValueOnce([{ id: 51, scheduled_for: NEW_TIME }]);
      resolvePageTokenMock
        .mockResolvedValueOnce("tok")
        .mockRejectedValueOnce(new Error("connection reset"));

      const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.scheduled_for).toBe(NEW_TIME);
      expect(data.warning).toContain("It did move on 1 of 2 Pages");
      expect(data.warning).toContain("could not be read");
    });
  });

  it("refuses a time outside the scheduling window before touching the row", async () => {
    const res = await PATCH(
      patchRequest({ scheduledFor: "2026-11-16T08:05:00.000Z" }),
      params()
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("10 minutes");
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("rejects a missing time", async () => {
    const res = await PATCH(patchRequest({}), params());
    expect(res.status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("refuses to move a post that is no longer scheduled", async () => {
    sqlMock.mockResolvedValueOnce([{ ...localRow, status: "published" }]);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Only a scheduled post can be rescheduled.",
    });
  });

  it("answers 404 for another workspace's post", async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    expect(res.status).toBe(404);
  });

  it("refuses when the row changed mid-flight", async () => {
    sqlMock.mockResolvedValueOnce([localRow]).mockResolvedValueOnce([]);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    expect(res.status).toBe(409);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("requires a workspace", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ scheduledFor: NEW_TIME }), params());
    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/schedule/[id]", () => {
  it("refuses while a reschedule holds the row", async () => {
    sqlMock.mockResolvedValueOnce([{ ...localRow, status: "rescheduling" }]);

    const res = await DELETE(
      new Request("http://localhost/api/schedule/51", { method: "DELETE" }),
      params()
    );
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toContain("being rescheduled right now");
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
