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

function row(id: number) {
  return {
    id,
    title: `Story ${id}`,
    summary: null,
    link: `https://example.com/${id}`,
    created_at: "2026-11-13T00:00:00Z",
    draft_id: null,
    status: "pending",
  };
}

function queryText(call: unknown[]) {
  return (call[0] as string[]).join("?");
}

beforeEach(() => {
  sqlMock.mockReset();
  requireWorkspaceMock.mockReset();
  requireWorkspaceMock.mockResolvedValue(access);
});

describe("GET /api/items", () => {
  it("scopes the list and the stat totals to the rolling queue window", async () => {
    sqlMock
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([{ total: 1, pending: 1, drafted: 0, published: 0 }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/items"));
    expect(res.status).toBe(200);

    expect(sqlMock).toHaveBeenCalledTimes(3);
    for (const call of sqlMock.mock.calls) {
      // The workspace filter and the window filter must both apply to the
      // news_items scan inside each query.
      expect(queryText(call)).toContain("n.workspace_id = ?");
      expect(queryText(call)).toContain("* interval '1 day'");
      expect(call.slice(1)).toContain(30); // QUEUE_WINDOW_DAYS
    }
  });

  it("attaches feed fields to rows and per-source counts to the payload", async () => {
    sqlMock
      .mockResolvedValueOnce([
        { ...row(1), feed_id: 7, feed_title: "RAPPLER" },
      ])
      .mockResolvedValueOnce([{ total: 1, pending: 1, drafted: 0, published: 0 }])
      .mockResolvedValueOnce([
        { feed_id: 7, total: 6, pending: 2, drafted: 2, published: 2 },
      ]);

    const res = await GET(new Request("http://localhost/api/items"));
    const data = await res.json();

    expect(data.rows[0].feed_id).toBe(7);
    expect(data.rows[0].feed_title).toBe("RAPPLER");
    expect(data.feedCounts).toEqual([
      { feed_id: 7, total: 6, pending: 2, drafted: 2, published: 2 },
    ]);
  });

  it("returns a single story in item mode without the window filters", async () => {
    sqlMock.mockResolvedValueOnce([row(5)]);

    const res = await GET(new Request("http://localhost/api/items?item=5"));
    const data = await res.json();

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].id).toBe(5);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(queryText(sqlMock.mock.calls[0])).toContain("n.id = ?");
  });

  it("paginates with the before cursor and reports hasMore", async () => {
    sqlMock
      .mockResolvedValueOnce([row(5), row(4), row(3)]) // limit + 1
      .mockResolvedValueOnce([{ total: 3, pending: 3, drafted: 0, published: 0 }]);

    const res = await GET(new Request("http://localhost/api/items?limit=2&before=3"));
    const data = await res.json();

    expect(data.rows).toHaveLength(2);
    expect(data.rows.map((r: { id: number }) => r.id)).toEqual([5, 4]);
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).toBe(4);
  });

  it("returns the totals row as counts", async () => {
    sqlMock
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([{ total: 12, pending: 8, drafted: 3, published: 1 }]);

    const res = await GET(new Request("http://localhost/api/items"));
    const data = await res.json();

    expect(data.counts).toEqual({ total: 12, pending: 8, drafted: 3, published: 1 });
  });

  it("falls back to page-derived zeroed counts when the totals query is empty", async () => {
    sqlMock.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/items"));
    const data = await res.json();

    expect(data.counts).toEqual({ total: 1, pending: 0, drafted: 0, published: 0 });
  });
});
