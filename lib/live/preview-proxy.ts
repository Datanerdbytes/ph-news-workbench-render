/**
 * Client-safe helpers for the live preview proxy — imported by client
 * components, so this file must never import Node built-ins. The server-only
 * SSRF guard lives in ./preview-proxy.server.
 */

/**
 * Whether a playable URL is an HLS manifest. googlevideo hands out
 * manifests whose `.m3u8` can sit in the pathname (`…/file/index.m3u8?…`)
 * or inside the query (`…?…%2Fplaylist.m3u8…`), so check both.
 */
export function isHlsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.toLowerCase().includes('.m3u8') ||
      parsed.search.toLowerCase().includes('.m3u8')
    );
  } catch {
    return false;
  }
}

/**
 * The same-origin URL hls.js and native HLS should load instead of a
 * cross-origin manifest/segment: GET /api/live/preview?url=<encoded>.
 */
export function proxyUrl(target: string): string {
  return `/api/live/preview?url=${encodeURIComponent(target)}`;
}

/**
 * Rewrite an HLS playlist so every resource inside it is fetched through
 * the preview proxy instead of the (CORS-less) origin: URI lines resolve
 * against the manifest URL, and every `URI="…"` attribute on a tag line
 * (`EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-MEDIA`, `EXT-X-I-FRAME-STREAM-INF`, …)
 * is rewritten in place. Comments without URIs and blank lines pass
 * through untouched, and CRLF/LF line endings are preserved.
 */
export function rewritePlaylist(body: string, baseUrl: string): string {
  // Split keeping each line's ending attached, so LF vs CRLF survives.
  return body
    .split(/(?<=\n)/)
    .map((line) => rewritePlaylistLine(line, baseUrl))
    .join('');
}

const TRAILING_EOL = /(?:\r?\n)$/;

function rewritePlaylistLine(line: string, baseUrl: string): string {
  const eol = TRAILING_EOL.exec(line)?.[0] ?? '';
  const content = line.slice(0, line.length - eol.length);

  let rewritten = content;
  if (content.startsWith('#')) {
    // Tag line: rewrite only the URI="…" attribute values.
    rewritten = content.replace(/URI="([^"]*)"/g, (attribute, uri: string) => {
      const proxied = proxiedResource(uri, baseUrl);
      return proxied === null ? attribute : `URI="${proxied}"`;
    });
  } else if (content.trim() !== '') {
    // A bare URI line — resolve and wrap it, keeping any side whitespace.
    const target = content.trim();
    const proxied = proxiedResource(target, baseUrl);
    if (proxied !== null) {
      const start = content.indexOf(target);
      const end = start + target.length;
      rewritten = content.slice(0, start) + proxied + content.slice(end);
    }
  }
  return rewritten + eol;
}

/**
 * Resolve a playlist URI against the manifest URL and wrap it for the
 * proxy. Returns null (leave the URI verbatim) when the value is empty,
 * does not resolve, or points at a scheme the proxy cannot serve —
 * rewriting a `data:` key into an HTTP round-trip would break playback.
 */
function proxiedResource(uri: string, baseUrl: string): string | null {
  if (!uri) return null;
  try {
    const resolved = new URL(uri, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return proxyUrl(resolved.href);
  } catch {
    return null;
  }
}
