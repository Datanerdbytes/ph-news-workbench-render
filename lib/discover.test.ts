import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISCOVER_TOPICS,
  DiscoverSearchError,
  getTopic,
  normalizeDiscoverFeed,
  resetDiscoverCacheForTests,
  searchFeeds,
} from "./discover";

const rawFeed = {
  feedId: "feed/https://techcrunch.com/feed/",
  title: "TechCrunch",
  description: "Reporting on the business of technology.",
  website: "https://techcrunch.com/",
  subscribers: 1_340_140,
  visualUrl: "https://storage.test/visual.webp",
  iconUrl: "https://storage.test/icon.png",
  language: "en",
  score: 62,
  valid: true,
};

describe("getTopic", () => {
  it("resolves curated topics by slug", () => {
    expect(getTopic("philippines")?.label).toBe("Philippines");
    expect(getTopic("tech")?.query).toBe("tech");
    expect(getTopic("nope")).toBeNull();
  });

  it("keeps slugs unique", () => {
    const slugs = DISCOVER_TOPICS.map((topic) => topic.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("normalizeDiscoverFeed", () => {
  it("strips the feed/ prefix and maps the card fields", () => {
    expect(normalizeDiscoverFeed(rawFeed)).toEqual({
      feedUrl: "https://techcrunch.com/feed/",
      title: "TechCrunch",
      description: "Reporting on the business of technology.",
      siteUrl: "https://techcrunch.com/",
      subscribers: 1_340_140,
      iconUrl: "https://storage.test/visual.webp",
      language: "en",
    });
  });

  it("falls back to the feed origin for the site and the domain for the title", () => {
    const source = normalizeDiscoverFeed({
      feedId: "feed/https://example.com/rss.xml",
      title: "  ",
      subscribers: -5,
    });
    expect(source).toMatchObject({
      feedUrl: "https://example.com/rss.xml",
      title: "example.com",
      siteUrl: "https://example.com",
      subscribers: 0,
    });
  });

  it("returns null for unusable results", () => {
    expect(normalizeDiscoverFeed({ ...rawFeed, valid: false })).toBeNull();
    expect(normalizeDiscoverFeed({ feedId: "feed/not-a-url" })).toBeNull();
    expect(normalizeDiscoverFeed({ title: "No feed id" })).toBeNull();
    expect(normalizeDiscoverFeed(null)).toBeNull();
    expect(normalizeDiscoverFeed("junk")).toBeNull();
  });
});

describe("searchFeeds", () => {
  beforeEach(() => {
    resetDiscoverCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [rawFeed] }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    resetDiscoverCacheForTests();
    vi.unstubAllGlobals();
  });

  it("searches the index and returns normalized sources", async () => {
    const sources = await searchFeeds("tech", 5);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v3/search/feeds?query=tech&count=5"),
      expect.anything(),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].feedUrl).toBe("https://techcrunch.com/feed/");
  });

  it("serves repeated queries from the cache without refetching", async () => {
    await searchFeeds("tech", 5);
    await searchFeeds("tech", 5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats queries case-insensitively for caching", async () => {
    await searchFeeds("Tech", 5);
    await searchFeeds("TECH", 5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list for a blank query without fetching", async () => {
    expect(await searchFeeds("   ")).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws a user-facing error when the index fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    await expect(searchFeeds("tech")).rejects.toThrow(DiscoverSearchError);
  });
});
