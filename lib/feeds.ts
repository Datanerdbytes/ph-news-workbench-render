import Parser from 'rss-parser';
import crypto from 'crypto';
import { sql } from '@/lib/db';

const FEED_TIMEOUT_MS = 15_000;
const FEED_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; PhNewsWorkbench/1.0; +https://ph-news-workbench.onrender.com)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
};

export const feedParser = new Parser({
  headers: { ...FEED_HEADERS },
  timeout: FEED_TIMEOUT_MS,
  maxRedirects: 5,
});

/** Error carrying a user-facing message about why a feed URL could not be read. */
export class FeedFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FeedFetchError';
    this.status = status;
  }
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Translate a feed fetch/parse failure into a message we can show the user.
 * rss-parser rejects with strings like "Status code 403" or "Request timed
 * out after …ms"; Node fetch failures carry codes like ENOTFOUND in `cause`.
 */
export function describeFeedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);

  if (/status code 40[13]/i.test(raw)) {
    return 'The site refused the request (HTTP 401/403). Some news sites block automated feed readers, so their feeds cannot be added.';
  }
  if (/status code (404|410)/i.test(raw)) {
    return 'No feed was found at this URL (HTTP 404). Double-check the URL — if you pasted a website address, try its feed URL (often /feed or /rss).';
  }
  if (/status code 5\d\d/i.test(raw)) {
    return 'The site had a server error. It may be down — try again later.';
  }
  if (/status code/i.test(raw)) {
    return `The site rejected the request (${raw.replace(/^status code /i, 'HTTP ')}).`;
  }
  if (/timed out|timeout/i.test(raw) || /ETIMEDOUT/.test(code)) {
    return `The site took too long to respond (timed out after ${FEED_TIMEOUT_MS / 1000}s). Try again later.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return 'That site could not be reached. Check the URL for typos.';
  }
  if (/ECONNREFUSED|ECONNRESET|EPROTO|CERT/.test(code)) {
    return 'The connection to the site failed. The site may be down or misconfigured.';
  }
  if (/too many redirects/i.test(raw)) {
    return 'The site redirected too many times. The feed URL may be misconfigured.';
  }
  if (/invalid xml|unable to parse|unclosed|not recognized as rss/i.test(raw)) {
    return 'This URL did not return a valid RSS/Atom feed. If you pasted a website address, try its feed URL (often /feed or /rss).';
  }
  return 'Could not read the feed. Please check the URL and ensure it is a valid RSS/Atom feed.';
}

function describeFetchFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if ((error as { name?: string })?.name === 'TimeoutError' || /timeout|timed out/i.test(raw)) {
    return `The site took too long to respond (timed out after ${FEED_TIMEOUT_MS / 1000}s). Try again later.`;
  }
  const code = errorCode(error);
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return 'That site could not be reached. Check the URL for typos.';
  }
  if (/ECONNREFUSED|ECONNRESET|EPROTO|CERT/.test(code)) {
    return 'The connection to the site failed. The site may be down or misconfigured.';
  }
  return 'The site could not be reached. Check the URL and try again.';
}

/** Read at most `maxBytes` of the response body as text — enough for sniffing without buffering whole pages. */
async function readBodyHead(res: Response, maxBytes = 256 * 1024): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // a partial body is enough for sniffing
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'");
}

export function extractFeedLink(html: string, baseUrl: string): string | null {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const markup = tag[0];
    if (!/rel\s*=\s*["']?alternate["']?/i.test(markup)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(markup)) continue;
    const href = markup.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeHtmlAttr(href), baseUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch the given URL once and work out what should actually be parsed.
 * Returns the URL unchanged when it already serves XML; when it is an HTML
 * page, returns the feed URL advertised in <link rel="alternate"> tags, or
 * the original URL when nothing is advertised. Throws FeedFetchError with a
 * user-facing message when the site is unreachable or refuses the request.
 */
export async function resolveFeedUrl(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: FEED_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeedFetchError(describeFetchFailure(error));
  }
  if (res.status >= 400) {
    throw new FeedFetchError(describeFeedError(new Error(`Status code ${res.status}`)), res.status);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (/xml|rss|atom/i.test(contentType)) return url;

  const head = await readBodyHead(res);
  if (/^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(head)) return url;

  return extractFeedLink(head, url) ?? url;
}

export type IngestableFeed = {
  id: number;
  workspace_id: string;
  url: string;
  title: string | null;
};

/**
 * Fetch one feed and insert its new items. Updates the feed row with the
 * fetched-at timestamp and clears or sets error_message, then rethrows on
 * failure so callers can decide how to surface it.
 */
export async function ingestFeed(
  feed: IngestableFeed,
  opts: { correlationId: string; trigger: 'cron' | 'manual' | 'initial' }
): Promise<{ ingested: number; skipped: number }> {
  const { correlationId, trigger } = opts;

  try {
    const parsedFeed = await feedParser.parseURL(feed.url);

    // Update feed title if we got a better one
    if (parsedFeed.title && parsedFeed.title.trim() && parsedFeed.title.trim() !== feed.title) {
      await sql`UPDATE feeds SET title = ${parsedFeed.title.trim()} WHERE id = ${feed.id}`;
    }

    let ingested = 0;
    let skipped = 0;

    for (const item of parsedFeed.items ?? []) {
      const link = item.link ?? '';
      const title = item.title ?? '';
      const guid = item.guid ?? link;
      const dedupHash = crypto.createHash('sha256').update(`${link}|${title}`).digest('hex');

      const res = await sql`
        INSERT INTO news_items (feed_id, workspace_id, guid, link, title, summary, published_at, raw_payload, dedup_hash)
        VALUES (${feed.id}, ${feed.workspace_id}, ${guid}, ${link}, ${title}, ${item.contentSnippet ?? ''}, ${item.pubDate ? new Date(item.pubDate) : null}, ${JSON.stringify(item)}, ${dedupHash})
        ON CONFLICT (workspace_id, dedup_hash) DO NOTHING
        RETURNING id
      `;

      if (res.length) ingested++; else skipped++;
    }

    await sql`
      UPDATE feeds
      SET last_fetched_at = now(),
          error_message = NULL
      WHERE id = ${feed.id}
    `;

    console.log(JSON.stringify({
      route: 'ingest',
      correlationId,
      trigger,
      event: 'feed_ok',
      workspaceId: feed.workspace_id,
      feedId: feed.id,
      url: feed.url,
      ingested,
      skipped,
    }));

    return { ingested, skipped };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = describeFeedError(error);

    await sql`
      UPDATE feeds
      SET error_message = ${errorMessage},
          last_fetched_at = now()
      WHERE id = ${feed.id}
    `;

    console.error(JSON.stringify({
      route: 'ingest',
      correlationId,
      trigger,
      event: 'feed_error',
      workspaceId: feed.workspace_id,
      feedId: feed.id,
      url: feed.url,
      error: rawMessage,
    }));

    throw error;
  }
}
