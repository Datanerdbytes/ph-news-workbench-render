// Discover Sources: topic taxonomy + normalized feed search. The search
// proxies Feedly's public feed-search endpoint (their web app's own index —
// it works unauthenticated and carries subscriber counts, icons, and site
// metadata), cached server-side so the Discover page stays fast and polite.

export type DiscoverTopic = {
  slug: string;
  label: string;
  /** Search terms used to scope the feed index for this topic. */
  query: string;
  blurb: string;
};

export const DISCOVER_TOPICS: DiscoverTopic[] = [
  {
    slug: "philippines",
    label: "Philippines",
    query: "Philippines news",
    blurb: "National headlines, politics, and current events",
  },
  {
    slug: "tech",
    label: "Tech",
    query: "tech",
    blurb: "Gadgets, platforms, and the industry behind them",
  },
  {
    slug: "ai",
    label: "AI",
    query: "artificial intelligence",
    blurb: "Models, research, and AI in the real world",
  },
  {
    slug: "startups",
    label: "Startups",
    query: "startups",
    blurb: "Founders, funding rounds, and product launches",
  },
  {
    slug: "cybersecurity",
    label: "Cybersecurity",
    query: "cybersecurity",
    blurb: "Breaches, vulnerabilities, and defense",
  },
  {
    slug: "business",
    label: "Business",
    query: "business finance news",
    blurb: "Markets, companies, and the economy",
  },
  {
    slug: "world",
    label: "World",
    query: "world news",
    blurb: "Global headlines beyond your region",
  },
  {
    slug: "science",
    label: "Science",
    query: "science",
    blurb: "Discoveries, space, and the natural world",
  },
  {
    slug: "health",
    label: "Health",
    query: "health",
    blurb: "Public health, medicine, and wellness",
  },
  {
    slug: "sports",
    label: "Sports",
    query: "sports",
    blurb: "Scores, transfers, and league stories",
  },
  {
    slug: "entertainment",
    label: "Entertainment",
    query: "entertainment",
    blurb: "Film, TV, music, and internet culture",
  },
  {
    slug: "design",
    label: "Design",
    query: "design",
    blurb: "Interfaces, branding, and craft",
  },
];

export const DEFAULT_DISCOVER_QUERY = "news";

export function getTopic(slug: string): DiscoverTopic | null {
  return DISCOVER_TOPICS.find(topic => topic.slug === slug) ?? null;
}

export type DiscoverSource = {
  feedUrl: string;
  title: string;
  description: string;
  siteUrl: string;
  subscribers: number;
  iconUrl: string | null;
  language: string | null;
};

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Map one raw Feedly search result to a DiscoverSource. Returns null for
 * results we cannot use (no usable feed URL, marked invalid).
 */
export function normalizeDiscoverFeed(raw: unknown): DiscoverSource | null {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!source || source.valid === false) return null;

  // feedId is "feed/<feed-url>" — the part after the prefix is what our
  // add-source flow ingests.
  const feedId = typeof source.feedId === "string" ? source.feedId : "";
  const feedUrl = feedId.startsWith("feed/") ? feedId.slice("feed/".length) : feedId;
  if (!isHttpUrl(feedUrl)) return null;

  const iconCandidate =
    [source.visualUrl, source.iconUrl, source.coverUrl].find(isHttpUrl) ?? null;
  const description =
    typeof source.description === "string" ? source.description.trim() : "";

  return {
    feedUrl,
    title:
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : domainOf(feedUrl),
    description,
    siteUrl: isHttpUrl(source.website)
      ? source.website
      : (() => {
          try {
            return new URL(feedUrl).origin;
          } catch {
            return feedUrl;
          }
        })(),
    subscribers:
      typeof source.subscribers === "number" && Number.isFinite(source.subscribers)
        ? Math.max(0, Math.floor(source.subscribers))
        : 0,
    iconUrl: iconCandidate,
    language: typeof source.language === "string" ? source.language : null,
  };
}

const SEARCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

const searchCache = new Map<string, { expires: number; sources: DiscoverSource[] }>();

/** @internal Test-only: reset the in-memory search cache between cases. */
export function resetDiscoverCacheForTests(): void {
  searchCache.clear();
}

/** Error carrying a user-facing message for Discover search failures. */
export class DiscoverSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverSearchError";
  }
}

/**
 * Search the feed index for publications matching a topic or free-text
 * query. Results are cached per (query, count) for CACHE_TTL_MS so repeated
 * topic visits and pagination do not re-hit the upstream index.
 */
export async function searchFeeds(
  query: string,
  count = 12,
): Promise<DiscoverSource[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const clamped = Math.min(Math.max(1, Math.floor(count) || 12), 25);
  const cacheKey = `${trimmed.toLowerCase()}::${clamped}`;

  const cached = searchCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.sources;

  let raw: unknown;
  try {
    const url = `https://feedly.com/v3/search/feeds?query=${encodeURIComponent(trimmed)}&count=${clamped}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new DiscoverSearchError(
        "The source index didn't respond. Try again in a moment.",
      );
    }
    raw = await res.json();
  } catch (error) {
    if (error instanceof DiscoverSearchError) throw error;
    throw new DiscoverSearchError(
      "Couldn't reach the source index. Check the connection and try again.",
    );
  }

  const results =
    raw !== null && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).results)
      ? ((raw as Record<string, unknown>).results as unknown[])
      : [];
  const sources = results
    .map(normalizeDiscoverFeed)
    .filter((source): source is DiscoverSource => source !== null);

  // Opportunistic prune, then cap by dropping the oldest entries.
  const now = Date.now();
  for (const [key, value] of searchCache) {
    if (value.expires <= now) searchCache.delete(key);
  }
  while (searchCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
  searchCache.set(cacheKey, { expires: now + CACHE_TTL_MS, sources });

  return sources;
}
