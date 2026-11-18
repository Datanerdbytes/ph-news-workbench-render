import { NextResponse } from 'next/server';
import { rewritePlaylist } from '@/lib/live/preview-proxy';
import {
  assertPublicUrl,
  PreviewProxyError,
} from '@/lib/live/preview-proxy.server';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** A playlist body opens with this exact tag — that is the sniff. */
const PLAYLIST_TAG = '#EXTM3U';

/** Redirect hops allowed before the chain is called a loop. */
const MAX_REDIRECTS = 3;

/**
 * GET /api/live/preview?url=… — CORS-safe streaming preview proxy.
 *
 * googlevideo HLS (manifests and segments) sends no
 * `Access-Control-Allow-Origin`, so hls.js in Chrome/Firefox cannot load it
 * cross-origin. This signed-in route fetches server-side and streams the
 * bytes back same-origin: playlists are rewritten so every nested URI (the
 * variants, keys, maps, and segments) points back at this route, and
 * segments pass through as a stream — the first chunk is sniffed to decide
 * which, and only that chunk is ever held in memory.
 */
export async function GET(request: Request) {
  // Streaming arbitrary URLs through the origin is signed-in only — the
  // same guard as /api/live/resolve.
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const target = new URL(request.url).searchParams.get('url');
  if (!target) {
    return NextResponse.json(
      { error: 'A stream URL is required to preview.' },
      { status: 400 }
    );
  }

  try {
    return await streamPreview(target);
  } catch (error) {
    if (error instanceof PreviewProxyError) {
      // Friendly by construction: bad input, private hosts, redirect loops.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Anything else is the upstream side of the proxy (fetch threw, empty
    // body, non-2xx) — the raw cause never reaches the client.
    return NextResponse.json(
      { error: 'The stream could not be reached for preview.' },
      { status: 502 }
    );
  }
}

async function streamPreview(target: string): Promise<Response> {
  // Manual redirects: every hop is re-run through the SSRF guard, so a
  // public manifest cannot bounce the proxy at localhost or the metadata
  // service.
  let url = await assertPublicUrl(target);
  let redirects = 0;
  let response: Response;
  for (;;) {
    response = await fetch(url, { redirect: 'manual' });
    if (!isRedirect(response.status)) break;
    await drainBody(response);
    if (redirects >= MAX_REDIRECTS) {
      throw new PreviewProxyError(
        'This link redirects too many times to preview.'
      );
    }
    redirects += 1;
    const location = response.headers.get('location');
    if (!location) {
      throw new PreviewProxyError(
        'This link redirects without a destination, so it cannot be previewed.'
      );
    }
    url = await assertPublicUrl(new URL(location, url).href);
  }

  if (!response.ok) {
    await drainBody(response);
    throw new Error(`Upstream preview responded ${response.status}.`);
  }
  const body = response.body;
  if (!body) {
    throw new Error('Upstream preview sent an empty body.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  if (first.done) {
    throw new Error('Upstream preview sent an empty body.');
  }

  // Sniff the first chunk: a manifest opens with #EXTM3U, anything else is
  // segment bytes. TextDecoder strips the BOM, and replacement characters
  // in binary chunks simply never match the tag.
  const head = decoder.decode(first.value, { stream: true });
  if (head.startsWith(PLAYLIST_TAG)) {
    // Manifests are kilobytes of text, so collecting them fully is fine.
    const text = await readAllText(reader, head, decoder);
    return new Response(rewritePlaylist(text, url), {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
      },
    });
  }

  // Segment (or any other bytes): stream through verbatim — emit the
  // sniffed chunk first, then pull the rest on demand. Nothing beyond the
  // first chunk is buffered, no matter how large the segment is.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        controller.error(cause);
      }
    },
    cancel() {
      // The player went away mid-segment; stop pulling upstream too.
      void reader.cancel();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type':
        response.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}

async function readAllText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: string,
  decoder: TextDecoder
): Promise<string> {
  let text = head;
  for (;;) {
    const next = await reader.read();
    if (next.done) return text + decoder.decode();
    text += decoder.decode(next.value, { stream: true });
  }
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

/** Best-effort cancel of a body we are not forwarding (redirect hops). */
async function drainBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Draining a rejected body is best-effort only.
  }
}
