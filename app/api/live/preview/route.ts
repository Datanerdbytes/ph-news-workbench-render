import { rewritePlaylist } from '@/lib/live/preview-proxy';
import { fetchPublicSource } from '@/lib/live/public-fetch';
import {
  assertPublicSourceUrl,
  NetworkPolicyError,
} from '@/lib/live/public-network';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

const PLAYLIST_TAG = '#EXTM3U';
const MAX_REDIRECTS = 3;
const MAX_SNIFF_BYTES = 1_048_576;
/** Binary bodies start streaming once this small prefix is proven inert. */
const BINARY_PREFIX_BYTES = 65_536;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};

export async function GET(request: Request): Promise<Response> {
  // Read before the try so the failure log below can name the upstream host.
  const target = new URL(request.url).searchParams.get('url');
  try {
    const access = await requireWorkspace(request);
    if (!access) return secureResponse(unauthorized());

    if (!target) {
      return errorResponse('A stream URL is required to preview.', 400);
    }

    return await streamPreview(target, request.signal);
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      return errorResponse(error.message, 400);
    }
    // The client gets a generic 502 by design; this log keeps the cause
    // diagnosable server-side. Only the upstream host is logged, never the
    // target itself — signed media links have no business in logs.
    console.error(
      JSON.stringify({
        route: 'live/preview',
        event: 'upstream_failed',
        host: hostOf(target),
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return errorResponse('The stream could not be reached for preview.', 502);
  }
}

function hostOf(target: string | null): string | null {
  if (!target) return null;
  try {
    return new URL(target).host;
  } catch {
    return null;
  }
}

async function streamPreview(
  target: string,
  signal: AbortSignal
): Promise<Response> {
  let url = await assertPublicSourceUrl(target);
  let redirects = 0;
  let response: Response;

  // Manual redirects: every hop is re-validated through the full policy and
  // dispatched on a freshly pinned connection — a public manifest cannot
  // bounce the proxy at localhost, the metadata service, or a rebinding host.
  for (;;) {
    response = await fetchPublicSource(url, { signal });
    if (!isRedirect(response.status)) break;
    await cancelBody(response);
    if (redirects >= MAX_REDIRECTS) {
      throw new NetworkPolicyError(
        'This link redirects too many times to preview.'
      );
    }
    redirects += 1;
    const location = response.headers.get('location');
    if (!location) {
      throw new NetworkPolicyError(
        'This link redirects without a destination, so it cannot be previewed.'
      );
    }
    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      throw new NetworkPolicyError(
        'This link redirects to an invalid destination, so it cannot be previewed.'
      );
    }
    url = await assertPublicSourceUrl(next);
  }

  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`Upstream preview responded ${response.status}.`);
  }
  if (!response.body) throw new Error('Upstream preview sent an empty body.');

  return classifyAndStream(response, url);
}

/**
 * Sniffs the bounded prefix of the upstream body. Playlists are collected
 * (≤1 MiB), rewritten, and served as `application/vnd.apple.mpegurl`.
 * Everything else streams through FORCED to `application/octet-stream` with
 * the sandbox CSP and `nosniff` — an upstream response can never carry
 * active content (HTML/SVG/JS) into this origin, whatever its declared
 * content-type claims.
 */
async function classifyAndStream(
  response: Response,
  baseUrl: string
): Promise<Response> {
  const reader = response.body!.getReader();
  const declaredType = response.headers.get('content-type') ?? '';
  const declaredPlaylist = isPlaylistType(declaredType);
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let playlist = false;

  try {
    if (looksActiveContentType(declaredType)) {
      await reader.cancel();
      throw new Error('Upstream preview returned active content.');
    }

    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;
      const prefix = concatBytes(buffered, bufferedBytes);
      if (looksActiveMarkup(decodeBytes(prefix))) {
        await reader.cancel();
        throw new Error('Upstream preview returned active content.');
      }

      const text = decodeBytes(prefix);
      if (isPlaylistText(text)) playlist = true;
      if (playlist && bufferedBytes > MAX_SNIFF_BYTES) {
        await reader.cancel();
        throw new Error('Upstream playlist is too large.');
      }

      // Active-markup scanning always runs on the bounded prefix. Once the
      // prefix is proven inert and the body is not a playlist, start
      // streaming immediately — a segment need not wait for the full window.
      if (looksActiveMarkup(text)) {
        await reader.cancel();
        throw new Error('Upstream preview returned active content.');
      }
      if (!playlist && bufferedBytes >= BINARY_PREFIX_BYTES) {
        return binaryResponse(reader, buffered);
      }
    }

    const bytes = concatBytes(buffered, bufferedBytes);
    const text = decodeBytes(bytes);
    if (looksActiveMarkup(text)) {
      throw new Error('Upstream preview returned active content.');
    }
    if (!isPlaylistText(text) && looksActiveJs(text)) {
      throw new Error('Upstream preview returned active content.');
    }
    if (isPlaylistText(text)) {
      return safeResponse(
        rewritePlaylist(decodeBytes(bytes), baseUrl),
        'application/vnd.apple.mpegurl'
      );
    }
    if (declaredPlaylist) {
      // A playlist MIME without the HLS marker is never reflected as text.
      return safeResponse(
        bytes.buffer as ArrayBuffer,
        'application/octet-stream'
      );
    }
    return safeResponse(bytes.buffer as ArrayBuffer, 'application/octet-stream');
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The upstream body may already be closed.
    }
    throw error;
  }
}

function binaryResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[]
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index++]!);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return safeResponse(stream, 'application/octet-stream');
}

function safeResponse(
  body: BodyInit | ReadableStream<Uint8Array>,
  contentType: string
): Response {
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': contentType,
    },
  });
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(message: string, status: number): Response {
  const response = safeResponse(
    JSON.stringify({ error: message }),
    'application/json'
  );
  return new Response(response.body, { status, headers: response.headers });
}

function isPlaylistText(text: string): boolean {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^\s+/, '')
    .startsWith(PLAYLIST_TAG);
}

function isPlaylistType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl' ||
    type === 'audio/mpegurl'
  );
}

function looksActiveContentType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    type === 'text/html' ||
    type === 'application/xhtml+xml' ||
    type === 'image/svg+xml' ||
    type === 'text/xml' ||
    type === 'application/xml' ||
    type === 'application/javascript' ||
    type === 'text/javascript' ||
    type === 'application/ecmascript' ||
    type === 'text/ecmascript' ||
    type === 'application/x-javascript'
  );
}

/**
 * Markup patterns run against EVERY body — playlists included — so an
 * attacker cannot smuggle HTML/SVG/script tags inside a playlist-shaped
 * response.
 */
function looksActiveMarkup(text: string): boolean {
  const normalized = text.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  return /(?:<!doctype\s+html|<html(?:\s|>)|<script(?:\s|>)|<svg(?:\s|>)|<\?xml(?:\s|>)|<iframe(?:\s|>)|<object(?:\s|>)|<embed(?:\s|>))/i.test(
    normalized
  );
}

/**
 * JS-keyword patterns run only against NON-playlist bodies: playlist URIs
 * legitimately contain words like "outlet", which must not trip the keyword
 * heuristic. Word boundaries keep the patterns from matching substrings.
 */
function looksActiveJs(text: string): boolean {
  const normalized = text.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  return /(?:['"]use strict['"]|\b(?:const|var|function|class|import|export)\b\s|\b(?:window|document|globalThis|alert)\b\s*[.(])/i.test(
    normalized
  );
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Draining a rejected body is best-effort only.
  }
}
