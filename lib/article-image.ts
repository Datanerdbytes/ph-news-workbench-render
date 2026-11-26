import { fetchPublicSource } from './live/public-fetch.ts';

const ARTICLE_TIMEOUT_MS = 8_000;
const ARTICLE_MAX_BYTES = 128 * 1024;
const MAX_ARTICLE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const ARTICLE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; PhNewsWorkbench/1.0; +https://ph-news-workbench.onrender.com)',
  Accept: 'text/html, */*;q=0.8',
};

/** Read only the bounded prefix that can contain the article metadata. */
async function readBodyHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = 0;
  let text = '';
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
  } catch {
    // a partial body is enough for sniffing
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

export function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'");
}

/**
 * Resolve a candidate image URL to an absolute http(s) URL. Skips data:/blob:
 * URIs (base64 payloads would bloat the column and never lazy-load well) and
 * relative paths we cannot anchor to a base URL.
 */
export function toAbsoluteImageUrl(url: string, base: string | null): string | null {
  const cleaned = decodeHtmlAttr(url.trim());
  if (!cleaned || /^data:|^blob:|^javascript:/i.test(cleaned)) return null;
  try {
    const resolved = new URL(cleaned, base ?? undefined);
    return (resolved.protocol === 'http:' || resolved.protocol === 'https:') ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/**
 * og:image (or twitter:image) from an article page's markup. Prefers the
 * plain og:image; the twitter variant and secure_url are fallbacks.
 */
export function extractArticleImage(html: string): string | null {
  let best: { rank: number; content: string } | null = null;
  for (const markup of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = markup[0];
    const key = tag
      .match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.toLowerCase();
    if (!key) continue;
    const rank =
      key === 'og:image'
        ? 0
        : key === 'twitter:image' || key === 'twitter:image:src'
          ? 1
          : key === 'og:image:secure_url'
            ? 2
            : -1;
    if (rank === -1) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!content) continue;
    if (!best || rank < best.rank) best = { rank, content };
    if (best.rank === 0) break;
  }
  return best?.content ?? null;
}

export type PublicDocument = {
  status: number;
  contentType: string;
  finalUrl: string;
  text: string;
};

/**
 * Fetch a document through the pinned public transport, following redirects
 * hop by hop so every destination re-runs the public-address policy. Reads at
 * most `opts.maxBytes` of the body; bodies whose content type does not match
 * `opts.acceptContentTypes` (when given) are cancelled unread. Returns null
 * when the transport, the policy, or the redirect chain fails; callers map
 * `status` to messages.
 */
export async function fetchPublicDocument(
  url: string,
  opts: {
    headers: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    maxRedirects?: number;
    acceptContentTypes?: RegExp;
  },
): Promise<PublicDocument | null> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const maxRedirects = opts.maxRedirects ?? MAX_ARTICLE_REDIRECTS;
  let currentUrl = url;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const res = await fetchPublicSource(currentUrl, {
        headers: opts.headers,
        signal,
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location || redirects === maxRedirects) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      // Error bodies are cancelled unread — callers only need the status,
      // and a rejected stream may never resolve a read.
      if (res.status >= 400) {
        await res.body?.cancel().catch(() => {});
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          finalUrl: res.url || currentUrl,
          text: '',
        };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (opts.acceptContentTypes && !opts.acceptContentTypes.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        return {
          status: res.status,
          contentType,
          finalUrl: res.url || currentUrl,
          text: '',
        };
      }
      const text = await readBodyHead(res, opts.maxBytes);
      return {
        status: res.status,
        contentType,
        // The pinned transport wraps streaming bodies, which clears Response.url.
        finalUrl: res.url || currentUrl,
        text,
      };
    }
  } catch {
    // Blocked, unreachable, or malformed destinations have no document.
  }
  return null;
}

/**
 * Best-effort metadata lookup for both ingestion and migration. Every hop
 * passes through the public-source policy and its pinned socket connector.
 */
export async function fetchArticleImage(url: string): Promise<string | null> {
  const doc = await fetchPublicDocument(url, {
    headers: ARTICLE_HEADERS,
    timeoutMs: ARTICLE_TIMEOUT_MS,
    maxBytes: ARTICLE_MAX_BYTES,
    acceptContentTypes: /text\/html/i,
  });
  if (!doc || doc.status >= 400) {
    return null;
  }
  const raw = extractArticleImage(doc.text);
  return raw ? toAbsoluteImageUrl(raw, doc.finalUrl) : null;
}
