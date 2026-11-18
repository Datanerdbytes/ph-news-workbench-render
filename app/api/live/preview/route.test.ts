import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const { fetchMock, lookupMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireWorkspace: vi.fn(),
  unauthorized: () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
// assertPublicUrl runs for real here — only DNS is mocked out.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { requireWorkspace } from '@/lib/session';
import { GET } from './route';

const requireWorkspaceMock = requireWorkspace as unknown as Mock;

const access = {
  user: { id: 'u1' },
  workspace: { id: 'ws_1', role: 'owner' },
};

/** Queue the addresses DNS reports for each hostname the route resolves. */
function resolveTo(...addresses: string[]) {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  );
}

/** A 200 whose body streams the given chunks, counting upstream reads. */
function streamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
) {
  let reads = 0;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
  return {
    response: new Response(body, { status: 200, headers }),
    reads: () => reads,
  };
}

function textResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers });
}

function redirectResponse(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function previewRequest(target: string | null) {
  const suffix = target === null ? '' : `?url=${encodeURIComponent(target)}`;
  return new Request(`http://localhost:3000/api/live/preview${suffix}`);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  requireWorkspaceMock.mockReset();
  requireWorkspaceMock.mockResolvedValue(access);
  lookupMock.mockReset();
  // Default the SSRF guard open — each test narrows it on purpose.
  resolveTo('93.184.216.34');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MANIFEST_URL = 'https://manifest.example/live/master.m3u8';

describe('GET /api/live/preview', () => {
  it('returns 401 without a workspace session and never fetches', async () => {
    requireWorkspaceMock.mockResolvedValueOnce(null);

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the url query parameter is missing', async () => {
    const res = await GET(previewRequest(null));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 with the friendly SSRF message for private hosts', async () => {
    resolveTo('10.1.2.3');

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('private');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sniffs a playlist, rewrites its URIs, and serves it as a manifest', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
          'video/720p.m3u8',
          '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/live/key"',
          'seg0.ts',
        ].join('\n'),
        { 'content-type': 'application/x-mpegurl' }
      )
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://manifest.example/live/video/720p.m3u8')}`
    );
    expect(text).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://manifest.example/live/seg0.ts')}`
    );
    expect(text).toContain(
      `URI="/api/live/preview?url=${encodeURIComponent('https://keys.example/live/key')}"`
    );
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, {
      redirect: 'manual',
    });
  });

  it('streams binary bodies through chunk by chunk, buffering nothing extra', async () => {
    const { response: upstream, reads } = streamingResponse(
      [
        new Uint8Array([0x47, 0x40, 0x00, 0x10]),
        new Uint8Array([0x47, 0x41, 0x00, 0x30, 0x01, 0x02]),
        new Uint8Array([0x47, 0x42, 0x00, 0x50]),
      ],
      { 'content-type': 'video/mp2t' }
    );
    fetchMock.mockResolvedValueOnce(upstream);

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The upstream was NOT drained before responding: at most the sniffed
    // chunk plus one HWM-1 prefetch pull were consumed, never the whole
    // body (a buffering implementation would have pulled all 4 times).
    expect(reads()).toBeLessThan(4);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(Array.from(first.value!)).toEqual([0x47, 0x40, 0x00, 0x10]);
    const second = await reader.read();
    expect(Array.from(second.value!)).toEqual([
      0x47, 0x41, 0x00, 0x30, 0x01, 0x02,
    ]);
    const third = await reader.read();
    expect(Array.from(third.value!)).toEqual([0x47, 0x42, 0x00, 0x50]);
    const done = await reader.read();
    expect(done.done).toBe(true);
    // Everything was pulled exactly once — streamed, not buffered.
    expect(reads()).toBe(4);
  });

  it('follows redirects, re-validating each hop against the SSRF guard', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse('/next/playlist.m3u8'))
      .mockResolvedValueOnce(
        textResponse('#EXTM3U\nseg1.ts\n', {
          'content-type': 'application/vnd.apple.mpegurl',
        })
      );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://manifest.example/next/playlist.m3u8',
      { redirect: 'manual' }
    );
    // The rewrite base is the final URL of the chain.
    const text = await res.text();
    expect(text).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://manifest.example/next/seg1.ts')}`
    );
  });

  it('refuses a redirect that bounces at a private host', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('http://localhost:8080/secret'));
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('private');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after more than three redirect hops', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(redirectResponse(`${MANIFEST_URL}?hop=`))
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('redirect');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns 502 with a friendly message when the upstream fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('The stream could not be reached for preview.');
    expect(body.error).not.toContain('fetch failed');
  });

  it('returns 502 when the upstream answers with an error status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 403 }));

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'The stream could not be reached for preview.',
    });
  });

  it('returns 502 when the upstream body is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });
});
