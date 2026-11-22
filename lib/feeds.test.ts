import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./live/public-fetch", () => ({ fetchPublicSource: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
const { lookup, request } = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("undici", () => ({
  fetch: request,
  buildConnector: vi.fn(),
  Agent: class {
    close = vi.fn();
    destroy = vi.fn();
  },
}));

import { fetchPublicSource } from "./live/public-fetch";
import { sql } from "@/lib/db";
import {
  describeFeedError,
  extractArticleImage,
  extractFeedLink,
  extractItemImage,
  feedParser,
  ingestFeed,
  resolveFeedUrl,
  FeedFetchError,
  type IngestableFeed,
} from "@/lib/feeds";

const sqlMock = sql as unknown as Mock;
let parseURL: Mock;

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
function useDb(inserts: unknown[][] = [], storedHashes: string[] = []) {
  const queue = [...inserts];
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("SELECT dedup_hash")) return storedHashes.map(dedup_hash => ({ dedup_hash }));
    if (query.includes("INSERT INTO news_items")) return queue.shift() ?? [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(fetchPublicSource).mockReset().mockRejectedValue(new Error("no article network in unit tests"));
  parseURL = vi.spyOn(feedParser, "parseURL").mockRejectedValue(new Error("no feed network in unit tests"));
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

    // First item: full fields, pubDate converted to a Date, no image in the payload.
    expect(inserts[0].slice(1)).toEqual([
      7,
      "ws1",
      "guid-a",
      "https://example.com/story-a",
      "Story A",
      "snippet",
      null,
      new Date(item.pubDate),
      JSON.stringify(item),
      createHash("sha256")
        .update("https://example.com/story-a|Story A")
        .digest("hex"),
    ]);

    // Second item: no guid (falls back to the link) and no pubDate.
    const [, , guid, , , , , pubDate] = inserts[1].slice(1);
    expect(guid).toBe("https://example.com/story-b");
    expect(pubDate).toBeNull();
  });

  it("extracts the thumbnail at ingest and stores it with the item", async () => {
    const withImage = {
      link: "https://example.com/story-a",
      title: "Story A",
      enclosure: { url: "https://cdn.example.com/cover.jpg", type: "image/jpeg" },
    };
    parseURL.mockResolvedValue({ title: "Feed", items: [withImage] });
    useDb([[{ id: 1 }]]);

    await ingestFeed(feed, { correlationId: "c1", trigger: "cron" });

    const insert = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("INSERT INTO news_items")
    );
    expect(insert!.slice(1)[6]).toBe("https://cdn.example.com/cover.jpg");
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

describe("extractItemImage", () => {
  it("prefers an image enclosure", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        enclosure: { url: "https://cdn.example.com/cover.jpg", type: "image/jpeg" },
      })
    ).toBe("https://cdn.example.com/cover.jpg");
  });

  it("accepts an enclosure with an image extension and no type", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        enclosure: { url: "https://cdn.example.com/cover.png?w=800" },
      })
    ).toBe("https://cdn.example.com/cover.png?w=800");
  });

  it("ignores non-image enclosures and falls through to the content image", () => {
    const payload = {
      link: "https://example.com/story",
      enclosure: { url: "https://cdn.example.com/episode.mp3", type: "audio/mpeg" },
      "content:encoded": '<p>hi <img src="https://cdn.example.com/lead.webp"></p>',
    };
    expect(extractItemImage(payload)).toBe("https://cdn.example.com/lead.webp");
  });

  it("picks the first image in a media:content array, skipping video", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        "media:content": [
          { $: { url: "https://cdn.example.com/clip.mp4", type: "video/mp4" } },
          { $: { url: "https://cdn.example.com/photo.jpg", medium: "image" } },
        ],
      })
    ).toBe("https://cdn.example.com/photo.jpg");
  });

  it("trusts media:thumbnail without type or extension", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        "media:thumbnail": [{ $: { url: "https://cdn.example.com/thumb" } }],
      })
    ).toBe("https://cdn.example.com/thumb");
  });

  it("digs into media:group", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        "media:group": [
          { "media:thumbnail": [{ $: { url: "https://cdn.example.com/group.jpg" } }] },
        ],
      })
    ).toBe("https://cdn.example.com/group.jpg");
  });

  it("resolves relative and protocol-relative srcs against the item link", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        content: '<img src="/img/lead.jpg">',
      })
    ).toBe("https://example.com/img/lead.jpg");
    expect(
      extractItemImage({
        link: "https://example.com/story",
        content: '<img src="//cdn.example.com/lead.jpg">',
      })
    ).toBe("https://cdn.example.com/lead.jpg");
  });

  it("skips data URIs and unresolvable srcs", () => {
    const payload = {
      content: '<img src="data:image/gif;base64,R0lGOD"><img src="/x.jpg">',
    };
    expect(extractItemImage(payload)).toBeNull();
    expect(
      extractItemImage({
        link: "https://example.com/story",
        content: '<img src="data:image/gif;base64,R0lGOD"><img src="/x.jpg">',
      })
    ).toBe("https://example.com/x.jpg");
  });

  it("decodes entities in content img srcs", () => {
    expect(
      extractItemImage({
        link: "https://example.com/story",
        "content:encoded": '<img src="https://cdn.example.com/a.jpg?w=1&amp;h=2">',
      })
    ).toBe("https://cdn.example.com/a.jpg?w=1&h=2");
  });

  it("returns null when there is no usable image", () => {
    expect(extractItemImage({ link: "https://example.com/story", title: "No image" })).toBeNull();
    expect(extractItemImage(null)).toBeNull();
    expect(extractItemImage("junk")).toBeNull();
  });
});

describe("extractArticleImage", () => {
  it("reads og:image regardless of attribute order and quoting", () => {
    expect(
      extractArticleImage(
        `<html><head><meta content="https://cdn.test/og.jpg" property="og:image"></head>`,
      ),
    ).toBe("https://cdn.test/og.jpg");
    expect(
      extractArticleImage(
        `<meta name='twitter:image' content='https://cdn.test/tw.jpg'>`,
      ),
    ).toBe("https://cdn.test/tw.jpg");
  });

  it("prefers og:image over twitter:image and secure_url", () => {
    const html =
      `<meta property="og:image:secure_url" content="https://cdn.test/secure.jpg">` +
      `<meta name="twitter:image" content="https://cdn.test/tw.jpg">` +
      `<meta property="og:image" content="https://cdn.test/og.jpg">`;
    expect(extractArticleImage(html)).toBe("https://cdn.test/og.jpg");
  });

  it("returns null without image meta", () => {
    expect(extractArticleImage("<meta name='description' content='hi'>")).toBeNull();
    expect(extractArticleImage("")).toBeNull();
  });
});

describe("ingestFeed og:image fallback", () => {
  it("fetches the story page's og:image when the feed provides no image", async () => {
    parseURL.mockResolvedValue({
      title: "Feed",
      items: [{ link: "https://techcrunch.test/story", title: "Story" }],
    });
    vi.mocked(fetchPublicSource).mockResolvedValue(
      new Response(
        `<html><head><title>t</title>` +
          `<meta property="og:image" content="https://cdn.test/og.jpg?w=1&amp;h=2">` +
          `</head></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );
    useDb([[{ id: 1 }]]);

    await ingestFeed(feed, { correlationId: "c1", trigger: "cron" });

    expect(fetchPublicSource).toHaveBeenCalledWith(
      "https://techcrunch.test/story",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const insert = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("INSERT INTO news_items"),
    );
    expect(insert!.slice(1)[6]).toBe("https://cdn.test/og.jpg?w=1&h=2");
  });

  it("skips stored hashes in this workspace before looking up article images", async () => {
    const freshItem = { link: "https://example.com/fresh", title: "Fresh" };
    parseURL.mockResolvedValue({ items: [item, freshItem] });
    const storedHash = createHash("sha256").update(`${item.link}|${item.title}`).digest("hex");
    useDb([[{ id: 1 }]], [storedHash]);

    await expect(ingestFeed(feed, { correlationId: "c1", trigger: "cron" }))
      .resolves.toEqual({ ingested: 1, skipped: 1 });
    expect(fetchPublicSource).toHaveBeenCalledTimes(1);
    expect(fetchPublicSource).toHaveBeenCalledWith(freshItem.link, expect.anything());
    const lookup = sqlMock.mock.calls.find(([strings]) => strings.join(" ").includes("SELECT dedup_hash"));
    expect(lookup?.[0].join(" ")).toContain("WHERE workspace_id = ");
    expect(lookup?.slice(1)).toEqual(["ws1", [storedHash, expect.any(String)]]);
  });

  it("does not fetch any page when the feed already provides images", async () => {
    parseURL.mockResolvedValue({
      title: "Feed",
      items: [
        {
          link: "https://example.com/story",
          title: "Story",
          enclosure: { url: "https://cdn.test/cover.jpg", type: "image/jpeg" },
        },
      ],
    });
    useDb([[{ id: 1 }]]);

    await ingestFeed(feed, { correlationId: "c1", trigger: "cron" });

    expect(fetchPublicSource).not.toHaveBeenCalled();
    const insert = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("INSERT INTO news_items"),
    );
    expect(insert!.slice(1)[6]).toBe("https://cdn.test/cover.jpg");
  });

  it("stores null when the story page has no og meta", async () => {
    parseURL.mockResolvedValue({
      title: "Feed",
      items: [{ link: "https://example.com/story", title: "Story" }],
    });
    vi.mocked(fetchPublicSource).mockResolvedValue(
      new Response("<html><head><title>plain</title></head></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    useDb([[{ id: 1 }]]);

    await ingestFeed(feed, { correlationId: "c1", trigger: "cron" });

    const insert = sqlMock.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join(" ").includes("INSERT INTO news_items"),
    );
    expect(insert!.slice(1)[6]).toBeNull();
  });
});

describe("feed URL transport", () => {
  beforeEach(async () => {
    vi.mocked(feedParser.parseURL).mockRestore();
    const actual = await vi.importActual<typeof import("./live/public-fetch")>("./live/public-fetch");
    vi.mocked(fetchPublicSource).mockImplementation(actual.fetchPublicSource);
    lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    request.mockReset();
  });

  const xml = '<rss version="2.0"><channel><title>Public feed</title><item><title>A story</title></item></channel></rss>';

  it.each(["http", "https"])("parses XML fetched over public %s", async (scheme) => {
    const url = `${scheme}://news.example/feed`;
    request.mockResolvedValue(new Response(xml));
    await expect(feedParser.parseURL(url)).resolves.toMatchObject({
      title: "Public feed",
      items: [{ title: "A story" }],
    });
    expect(request).toHaveBeenCalledWith(url, expect.objectContaining({
      redirect: "manual",
      dispatcher: expect.any(Object),
    }));
  });

  it.each([resolveFeedUrl, feedParser.parseURL])("rejects a destination with mixed DNS answers before connecting", async (read) => {
    lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(read("https://news.example/feed")).rejects.toThrow(/non-public/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([resolveFeedUrl, feedParser.parseURL])("rejects a non-public redirect before following it", async (read) => {
    request.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { location: "https://internal.example/feed" },
    }));
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(read("https://news.example/feed")).rejects.toThrow(/non-public/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-public feed advertised by an HTML page", async () => {
    request.mockResolvedValueOnce(new Response(
      '<link rel="alternate" type="application/rss+xml" href="https://internal.example/feed">',
      { headers: { "content-type": "text/html" } },
    ));
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(resolveFeedUrl("https://news.example/")).rejects.toThrow(/non-public/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resolves relative advertised links against the final public page", async () => {
    request.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { location: "https://news.example/latest/" },
    })).mockResolvedValueOnce(new Response(
      '<link rel="alternate" type="application/rss+xml" href="feed.xml">',
      { headers: { "content-type": "text/html" } },
    ));
    await expect(resolveFeedUrl("https://old.example/")).resolves.toBe("https://news.example/latest/feed.xml");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns the URL unchanged when it already serves XML", async () => {
    request.mockResolvedValue(
      new Response("<rss><channel/></rss>", { headers: { "content-type": "application/rss+xml" } })
    );
    await expect(resolveFeedUrl("https://example.com/feed.xml")).resolves.toBe(
      "https://example.com/feed.xml"
    );
  });

  it("discovers the advertised feed on an HTML page", async () => {
    const html =
      `<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"></head>` +
      `<body>hi</body></html>`;
    request.mockResolvedValue(
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    );
    await expect(resolveFeedUrl("https://example.com/")).resolves.toBe("https://example.com/feed/");
  });

  it("returns the original URL when the page advertises nothing", async () => {
    request.mockResolvedValue(
      new Response("<html><body>plain</body></html>", { headers: { "content-type": "text/html" } })
    );
    await expect(resolveFeedUrl("https://example.com/")).resolves.toBe("https://example.com/");
  });

  it("sniffs XML served with a non-XML content type", async () => {
    request.mockResolvedValue(
      new Response('<?xml version="1.0"?><rss version="2.0"><channel/></rss>', {
        headers: { "content-type": "application/octet-stream" },
      })
    );
    await expect(resolveFeedUrl("https://example.com/feed")).resolves.toBe(
      "https://example.com/feed"
    );
  });

  it("throws a user-facing error on 403", async () => {
    request.mockResolvedValue(new Response("blocked", { status: 403 }));
    const error = await resolveFeedUrl("https://example.com/feed/").catch((e) => e);
    expect(error).toBeInstanceOf(FeedFetchError);
    expect(error.message).toMatch(/refused the request/);
  });

  it("throws a user-facing error on DNS failure", async () => {
    lookup.mockRejectedValue(new Error("DNS failure"));
    const error = await resolveFeedUrl("https://nope.example/").catch((e) => e);
    expect(error).toBeInstanceOf(FeedFetchError);
    expect(error.message).toMatch(/could not look up/);
  });
});
