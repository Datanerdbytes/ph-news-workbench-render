import { beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock, requireWorkspaceMock } = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: (fragment: string) => fragment });
  return {
    sqlMock: sql,
    requireWorkspaceMock: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));

import { GET } from "./route";

const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

function queryText(call: unknown[]) {
  return (call[0] as string[]).join("?");
}

const totalsRow = {
  drafts: 3,
  published: 1,
  scheduled: 2,
  scheduled_published: 4,
  linked_published: 2,
  failed: 0,
  tokens: 10,
  cost: 0.5,
};

const dailyRow = {
  day: "2026-11-15",
  drafts: 1,
  published: 0,
  scheduled: 0,
  failed: 0,
};

const facebookRow = {
  platform: "facebook",
  total: 10,
  post: 4,
  reel: 3,
  live: 1,
  story: 2,
  total_30d: 5,
};

/** The three queries the endpoint runs, in order. */
function mockQueries(platformRows: unknown[]) {
  sqlMock
    .mockResolvedValueOnce([totalsRow])
    .mockResolvedValueOnce([dailyRow])
    .mockResolvedValueOnce(platformRows);
}

beforeEach(() => {
  sqlMock.mockReset();
  requireWorkspaceMock.mockReset();
  requireWorkspaceMock.mockResolvedValue(access);
});

describe("GET /api/analytics", () => {
  it("derives the platform from source and kind, and scopes it to the workspace", async () => {
    mockQueries([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    expect(res.status).toBe(200);

    expect(sqlMock).toHaveBeenCalledTimes(3);

    // The platform query is the third one.
    const platformQuery = sqlMock.mock.calls[2];
    const text = queryText(platformQuery);

    // Only published rows count.
    expect(text).toContain("status = 'published'");
    expect(text).toContain("workspace_id = ?");
    expect(platformQuery.slice(1)).toContain("ws1");

    // The derivation the scheduler already branches on.
    expect(text).toContain("source = 'facebook'");
    expect(text).toContain("source = 'local' AND kind <> 'instagram-post'");
    expect(text).toContain("source = 'youtube'");
    expect(text).toContain("source = 'tiktok'");
    expect(text).toContain("kind = 'instagram-post'");

    // Feed posts are 'post' + 'photo'; only Instagram counts its own
    // 'instagram-post' rows as posts.
    expect(text).toContain("kind IN ('post', 'photo')");
    expect(text).toContain("platform = 'instagram' AND kind = 'instagram-post'");

    // The 30-day hint rides on updated_at — publish time has no column.
    expect(text).toContain("updated_at > now() - interval '30 days'");
  });

  it("returns the published counts per platform", async () => {
    mockQueries([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    const data = await res.json();

    expect(data.platforms).toEqual([
      {
        platform: "facebook",
        published: { total: 10, post: 4, reel: 3, live: 1, story: 2 },
        published30d: { total: 5 },
      },
      {
        platform: "instagram",
        published: { total: 0, post: 0, reel: 0, live: 0, story: 0 },
        published30d: { total: 0 },
      },
      {
        platform: "youtube",
        published: { total: 0, post: 0, reel: 0, live: 0, story: 0 },
        published30d: { total: 0 },
      },
      {
        platform: "tiktok",
        published: { total: 0, post: 0, reel: 0, live: 0, story: 0 },
        published30d: { total: 0 },
      },
    ]);
  });

  it("keeps the workspace totals and the daily series alongside the platforms", async () => {
    mockQueries([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    const data = await res.json();

    expect(data.totals).toEqual({
      drafts: 3,
      // 1 published draft + 4 published posts − 2 that also flipped their
      // draft: one publish, counted once.
      published: 3,
      scheduled: 2,
      failed: 0,
      tokens: 10,
      cost: 0.5,
    });
    expect(data.daily).toEqual([dailyRow]);
  });

  it("counts a post that did not publish a draft on its own", async () => {
    // Nothing links a published post to a published draft — no overlap to
    // subtract, so every post counts.
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ ...totalsRow, linked_published: 0 }])
      .mockResolvedValueOnce([dailyRow])
      .mockResolvedValueOnce([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    const data = await res.json();

    expect(data.totals.published).toBe(5);
  });

  it("dates published bars by the mirrored post, not the draft it flipped", async () => {
    mockQueries([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    expect(res.status).toBe(200);

    // The daily series is the second query.
    const text = queryText(sqlMock.mock.calls[1]);

    // Immediate publishes insert a 'published' scheduled_posts row; the chart
    // reads that row's scheduled_for. Drafts only contribute their creation day.
    expect(text).toContain("date_trunc('day', scheduled_for");
    expect(text).toContain("FROM scheduled_posts");
    expect(text.match(/status = 'published'/g)).toHaveLength(1);
  });

  it("dates a late publish by when it went out, not by its slot", async () => {
    mockQueries([facebookRow]);

    await GET(new Request("http://localhost/api/analytics"));
    const text = queryText(sqlMock.mock.calls[1]);

    // The local worker sends after the slot and leaves scheduled_for behind;
    // the published event records the send time. The published bucket reads
    // that event and range-filters on it.
    expect(text).toContain("FROM scheduled_post_events e");
    expect(text).toContain("e.event = 'published'");
    expect(text).toContain("min(e.created_at)");
    expect(text).toContain("sent.published_at >= now() - make_interval");
    // A publish with no recorded event still counts, on its slot day.
    expect(text).toContain("coalesce(");
  });

  it("draws every outcome from its own status bucket", async () => {
    mockQueries([facebookRow]);

    await GET(new Request("http://localhost/api/analytics"));
    const text = queryText(sqlMock.mock.calls[1]);

    expect(text).toContain("status = 'scheduled'");
    expect(text).toContain("status = 'failed'");
  });

  it("buckets days in Manila rather than UTC", async () => {
    mockQueries([facebookRow]);

    await GET(new Request("http://localhost/api/analytics"));
    const text = queryText(sqlMock.mock.calls[1]);

    // One for each bucket: drafts, published, scheduled, failed.
    expect(text.match(/AT TIME ZONE 'Asia\/Manila'/g)).toHaveLength(4);
  });

  it("binds the requested range and defaults invalid values to 14 days", async () => {
    mockQueries([facebookRow]);
    await GET(new Request("http://localhost/api/analytics?days=30"));
    expect(sqlMock.mock.calls[1].slice(1)).toContain(30);

    sqlMock.mockReset();
    mockQueries([facebookRow]);
    await GET(new Request("http://localhost/api/analytics?days=15"));
    expect(sqlMock.mock.calls[1].slice(1)).toContain(14);
  });

  it("passes failed counts through in the daily series", async () => {
    sqlMock.mockReset();
    const daily = [
      { day: "2026-11-17", drafts: 0, published: 3, scheduled: 1, failed: 2 },
    ];
    sqlMock
      .mockResolvedValueOnce([totalsRow])
      .mockResolvedValueOnce(daily)
      .mockResolvedValueOnce([facebookRow]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    const data = await res.json();

    expect(data.daily).toEqual(daily);
  });

  it("zero-fills every platform when nothing has been published yet", async () => {
    mockQueries([]);

    const res = await GET(new Request("http://localhost/api/analytics"));
    const data = await res.json();

    expect(data.platforms).toHaveLength(4);
    for (const platform of data.platforms) {
      expect(platform.published).toEqual({
        total: 0,
        post: 0,
        reel: 0,
        live: 0,
        story: 0,
      });
      expect(platform.published30d).toEqual({ total: 0 });
    }
  });

  it("rejects an unauthenticated request", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/analytics"));

    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
