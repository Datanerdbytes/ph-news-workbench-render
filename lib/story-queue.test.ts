import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchQueuePage, type QueuePage } from "./story-queue";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

describe("fetchQueuePage", () => {
  it("maps the API response and keys feed counts by feed id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          rows: [{ id: 1, title: "Story", feed_id: 7, feed_title: "RAPPLER" }],
          nextCursor: 1,
          hasMore: true,
          counts: { total: 10, pending: 4, drafted: 3, published: 3 },
          feedCounts: [
            { feed_id: 7, total: 6, pending: 2, drafted: 2, published: 2 },
            { feed_id: null, total: 4, pending: 2, drafted: 1, published: 1 },
          ],
        }),
      ),
    );

    const page = await fetchQueuePage();
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].feed_title).toBe("RAPPLER");
    expect(page.nextCursor).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.counts.total).toBe(10);
    expect(page.feedCounts["7"]).toEqual({
      total: 6,
      pending: 2,
      drafted: 2,
      published: 2,
    });
    // Feed-less stories belong to "All" only — no null key leaks in.
    expect(Object.keys(page.feedCounts)).toEqual(["7"]);
  });

  it("requests the next page with the cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ rows: [], nextCursor: null, hasMore: false, counts: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchQueuePage(42);
    expect(fetchMock).toHaveBeenCalledWith("/api/items?before=42", {
      cache: "no-store",
    });
  });

  it("throws on a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));
    await expect(fetchQueuePage()).rejects.toThrow(
      "Could not load the news feed"
    );
  });

  it("fills missing counts and pagination fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rows: [] })));
    const page: QueuePage = await fetchQueuePage();
    expect(page.counts).toEqual({
      total: 0,
      pending: 0,
      drafted: 0,
      published: 0,
    });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.feedCounts).toEqual({});
  });
});
