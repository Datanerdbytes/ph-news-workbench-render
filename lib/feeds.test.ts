import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = vi.fn();
  },
}));

import { sql } from "@/lib/db";
import {
  describeFeedError,
  extractFeedLink,
  feedParser,
  ingestFeed,
  resolveFeedUrl,
  FeedFetchError,
  type IngestableFeed,
} from "@/lib/feeds";

const sqlMock = sql as unknown as Mock;
const parseURL = feedParser.parseURL as unknown as Mock;

const feed: IngestableFeed = {
  id: 7,
  workspace_id: "ws1",
  url: "https://example.com/rss.xml",
  title: "Old Title",
};

const item = {
  link: "https://example.com/story-a",
  title: "Story A",
  guid: "guid-a",
  contentSnippet: "snippet",
  pubDate: "Mon, 02 Nov 2026 10:00:00 GMT",
};

/**
 * Queue one result per `INSERT INTO news_items` call: rows mean the item was
 * new (RETURNING id fired), an empty array means the dedup conflict skipped it.
 */
function useDb(inserts: unknown[][] = []) {
  const queue = [...inserts];
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("INSERT INTO news_items")) return queue.shift() ?? [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestFeed", () => {
  it("counts inserted rows as ingested and conflicts as skipped", async () => {
    parseURL.mockResolvedValue({ title: "Feed", items: [item, item, item] });
    useDb([[{ id: 1 }], [], [{ id: 2 }]]);

    await expect(
      ingestFeed(feed, { correlationId: "c1", trigger: "cron" })
    ).resolves.toEqual({ ingested: 2, skipped: 1 });

    const finalUpdate = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("last_fetched_at")
    );
    expect(finalUpdate).toBeDefined();
  });

  it("updates the feed title only when the feed provides a better one", async () => {
    parseURL.mockResolvedValue({ title: "  Fresh Title  ", items: [] });
    await ingestFeed(feed, { correlationId: "c1", trigger: "manual" });

    const titleUpdate = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("SET title")
    );
    expect(titleUpdate![1]).toBe("Fresh Title");

    parseURL.mockResolvedValue({ title: " Old Title ", items: [] });
    sqlMock.mockClear();
    useDb();
    await ingestFeed(feed, { correlationId: "c2", trigger: "manual" });
    expect(
      sqlMock.mock.calls.some((call) =>
        (call[0] as TemplateStringsArray).join(" ").includes("SET title")
      )
    ).toBe(false);
  });

  it("hashes link|title for dedup and falls back for missing fields", async () => {
    parseURL.mockResolvedValue({
      items: [item, { link: "https://example.com/story-b", title: "Story B" }],
    });

    await ingestFeed(feed, { correlationId: "c1", trigger: "initial" });

    const inserts = sqlMock.mock.calls.filter((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("INSERT INTO news_items")
    );

    // First item: full fields, pubDate converted to a Date.
    expect(inserts[0].slice(1)).toEqual([
      7,
      "ws1",
      "guid-a",
      "https://example.com/story-a",
      "Story A",
      "snippet",
      new Date(item.pubDate),
      JSON.stringify(item),
      createHash("sha256")
        .update("https://example.com/story-a|Story A")
        .digest("hex"),
    ]);

    // Second item: no guid (falls back to the link) and no pubDate.
    const [, , guid, , , , pubDate] = inserts[1].slice(1);
    expect(guid).toBe("https://example.com/story-b");
    expect(pubDate).toBeNull();
  });

  it("records a user-facing error on the feed row and rethrows the raw one", async () => {
    parseURL.mockRejectedValue(new Error("network down"));

    await expect(
      ingestFeed(feed, { correlationId: "c1", trigger: "cron" })
    ).rejects.toThrow("network down");

    const errorUpdate = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("error_message")
    );
    expect(errorUpdate![1]).toMatch(/Could not read the feed/);
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("network down");
  });
});

describe("describeFeedError", () => {
  it.each([
    [new Error("Status code 403"), /refused the request/],
    [new Error("Status code 404"), /HTTP 404/],
    [new Error("Status code 404"), /\/feed or \/rss/],
    [new Error("Status code 503"), /server error/],
    [new Error("Status code 429"), /HTTP 429/],
    [new Error("Request timed out after 15000ms"), /timed out/],
    [new Error("Too many redirects"), /redirected too many times/],
    [new Error("Unclosed root tag"), /did not return a valid RSS\/Atom feed/],
    [new Error("Feed not recognized as RSS 1 or 2."), /did not return a valid RSS\/Atom feed/],
  ])("maps %s to a specific message", (error, expected) => {
    expect(describeFeedError(error)).toMatch(expected);
  });

  it("maps DNS failures to a typo hint", () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    expect(describeFeedError(error)).toMatch(/could not be reached/);
  });

  it("maps connection failures to a retry hint", () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(describeFeedError(error)).toMatch(/connection .* failed/);
  });

  it("falls back to a generic message", () => {
    expect(describeFeedError(new Error("something else"))).toMatch(/Could not read the feed/);
  });
});

describe("extractFeedLink", () => {
  it("resolves a relative advertised feed URL and ignores other links", () => {
    const html =
      `<html><head><link rel="stylesheet" href="/style.css">` +
      `<link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/"></head></html>`;
    expect(extractFeedLink(html, "https://example.com/")).toBe("https://example.com/feed/");
  });

  it("handles attribute order, single quotes and entities", () => {
    const html = `<LINK HREF='/a.rss?x=1&amp;y=2' TYPE='application/atom+xml' REL='alternate'>`;
    expect(extractFeedLink(html, "https://example.com/")).toBe(
      "https://example.com/a.rss?x=1&y=2"
    );
  });

  it("returns null for pages without a feed link", () => {
    expect(extractFeedLink(`<link rel="stylesheet" href="/s.css">`, "https://example.com/")).toBeNull();
  });
});

describe("resolveFeedUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the URL unchanged when it already serves XML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<rss><channel/></rss>", { headers: { "content-type": "application/rss+xml" } })
    ));
    await expect(resolveFeedUrl("https://example.com/feed.xml")).resolves.toBe(
      "https://example.com/feed.xml"
    );
  });

  it("discovers the advertised feed on an HTML page", async () => {
    const html =
      `<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"></head>` +
      `<body>hi</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    ));
    await expect(resolveFeedUrl("https://example.com/")).resolves.toBe("https://example.com/feed/");
  });

  it("returns the original URL when the page advertises nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>plain</body></html>", { headers: { "content-type": "text/html" } })
    ));
    await expect(resolveFeedUrl("https://example.com/")).resolves.toBe("https://example.com/");
  });

  it("sniffs XML served with a non-XML content type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response('<?xml version="1.0"?><rss version="2.0"><channel/></rss>', {
        headers: { "content-type": "application/octet-stream" },
      })
    ));
    await expect(resolveFeedUrl("https://example.com/feed")).resolves.toBe(
      "https://example.com/feed"
    );
  });

  it("throws a user-facing error on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("blocked", { status: 403 })));
    const error = await resolveFeedUrl("https://example.com/feed/").catch((e) => e);
    expect(error).toBeInstanceOf(FeedFetchError);
    expect(error.message).toMatch(/refused the request/);
  });

  it("throws a user-facing error on DNS failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      })
    ));
    const error = await resolveFeedUrl("https://nope.example/").catch((e) => e);
    expect(error).toBeInstanceOf(FeedFetchError);
    expect(error.message).toMatch(/could not be reached/);
  });
});
