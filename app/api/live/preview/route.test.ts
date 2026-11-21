import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireWorkspaceMock,
  fetchPublicSourceMock,
  runnerModeMock,
  runnerStreamRequestMock,
} = vi.hoisted(() => ({
  requireWorkspaceMock: vi.fn(),
  fetchPublicSourceMock: vi.fn(),
  runnerModeMock: vi.fn(),
  runnerStreamRequestMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));

// The route consumes the guarded transport — mock it at the module boundary
// so these tests exercise the ROUTE's policy (sniffing, classification,
// headers), not the transport itself (covered by public-fetch tests).
vi.mock('@/lib/live/public-fetch', () => ({
  fetchPublicSource: fetchPublicSourceMock,
}));

// Runner mode is controlled per-test; the default (off) keeps every legacy
// test on the direct-egress path.
vi.mock('@/lib/live/runner-config', () => ({
  runnerMode: runnerModeMock,
  runnerStreamRequest: runnerStreamRequestMock,
  RUNNER_UNREACHABLE_ERROR: 'The media runner is unreachable right now.',
}));
// The REAL public-network policy runs here (DNS mocked) — redirect hops
// and initial URLs get the production validation, including port and
// private-address rules.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { GET } from './route';

const unauthorizedResponse = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

const MANIFEST_URL = 'https://manifest.example/live/master.m3u8';

function previewRequest(target: string | null) {
  const suffix = target === null ? '' : `?url=${encodeURIComponent(target)}`;
  return new Request(`http://localhost:3000/api/live/preview${suffix}`);
}

function jsonResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers });
}

function redirectResponse(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

const SESSION = { workspace: { id: 'ws_1' }, user: { id: 'u1' } };

beforeEach(() => {
  requireWorkspaceMock.mockReset();
  requireWorkspaceMock.mockResolvedValue(SESSION);
  fetchPublicSourceMock.mockReset();
  runnerModeMock.mockReset();
  // Off by default — only the runner-mode describe turns it on.
  runnerModeMock.mockReturnValue(false);
  runnerStreamRequestMock.mockReset();
  // Default the SSRF guard open — each test narrows it on purpose.
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/live/preview', () => {
  it('returns 401 without a workspace session and never fetches', async () => {
    requireWorkspaceMock.mockResolvedValueOnce(null);

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(401);
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
    // Even the 401 carries the sandbox headers — the route never serves
    // unsandboxed content.
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns 400 when the url query parameter is missing', async () => {
    const res = await GET(previewRequest(null));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
  });

  it('sniffs a playlist, rewrites its URIs, and serves it as a manifest with sandbox headers', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      jsonResponse(
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
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.apple.mpegurl'
    );
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
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
  });

  it('refuses an upstream that declares an active content-type', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      jsonResponse('<html>steal</html>', { 'content-type': 'text/html' })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toContain('<html>');
  });

  it('refuses an upstream whose body carries active markup regardless of MIME', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      jsonResponse('<script>alert(1)</script>', {
        'content-type': 'application/octet-stream',
      })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
  });

  it('forces binary media to application/octet-stream with sandbox headers', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      jsonResponse('fake-segment-bytes', { 'content-type': 'video/mp2t' })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    // Upstream MIME is NEVER reflected: binary is forced to octet-stream so
    // this origin cannot be turned into a script/image host.
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('fake-segment-bytes');
  });

  it('follows redirects, re-validating each hop through the policy', async () => {
    fetchPublicSourceMock
      .mockResolvedValueOnce(redirectResponse('/next/playlist.m3u8'))
      .mockResolvedValueOnce(
        jsonResponse('#EXTM3U\nseg1.ts\n', {
          'content-type': 'application/vnd.apple.mpegurl',
        })
      );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(fetchPublicSourceMock).toHaveBeenCalledTimes(2);
    expect(fetchPublicSourceMock).toHaveBeenNthCalledWith(
      2,
      'https://manifest.example/next/playlist.m3u8',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const text = await res.text();
    expect(text).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://manifest.example/next/seg1.ts')}`
    );
  });

  it('refuses a redirect hop that fails the URL policy', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      redirectResponse('http://localhost:8080/secret')
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    expect(fetchPublicSourceMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after more than three redirect hops', async () => {
    fetchPublicSourceMock.mockImplementation(() =>
      Promise.resolve(redirectResponse(`${MANIFEST_URL}?hop=`))
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    expect(fetchPublicSourceMock).toHaveBeenCalledTimes(4);
  });

  it('returns 502 with a friendly message when the upstream fetch fails', async () => {
    fetchPublicSourceMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('The stream could not be reached for preview.');
    expect(body.error).not.toContain('fetch failed');
  });

  it('returns 502 when the upstream answers with an error status', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      new Response('expired', { status: 403 })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'The stream could not be reached for preview.',
    });
  });

  it('returns 502 when the upstream body is empty', async () => {
    fetchPublicSourceMock.mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });
});

describe('GET /api/live/preview in runner mode', () => {
  function runnerResponse(
    body: string,
    headers: Record<string, string> = {}
  ): Response {
    return new Response(body, { status: 200, headers });
  }

  beforeEach(() => {
    runnerModeMock.mockReturnValue(true);
  });

  it('relays the playlist through the runner and rewrites URIs against the final URL', async () => {
    const finalUrl = 'https://final.example/live/master.m3u8';
    runnerStreamRequestMock.mockResolvedValueOnce(
      runnerResponse('#EXTM3U\nhttps://final.example/seg0.ts\n', {
        'content-type': 'application/vnd.apple.mpegurl',
        'x-final-url': encodeURIComponent(finalUrl),
      })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://final.example/seg0.ts')}`
    );
    // The relay replaces direct egress entirely in runner mode.
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
    expect(runnerStreamRequestMock).toHaveBeenCalledWith(
      '/preview-media',
      { url: MANIFEST_URL },
      expect.any(AbortSignal)
    );
  });

  it('falls back to the direct path when the runner predates the relay', async () => {
    runnerStreamRequestMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 })
    );
    fetchPublicSourceMock.mockResolvedValueOnce(
      jsonResponse('#EXTM3U\nseg0.ts\n', {
        'content-type': 'application/vnd.apple.mpegurl',
      })
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(200);
    expect(fetchPublicSourceMock).toHaveBeenCalledTimes(1);
    expect(await res.text()).toContain(
      `/api/live/preview?url=${encodeURIComponent('https://manifest.example/live/seg0.ts')}`
    );
  });

  it('maps a runner policy rejection to the route 400 contract', async () => {
    runnerStreamRequestMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Links on non-standard ports cannot be previewed.',
        }),
        { status: 400 }
      )
    );

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Links on non-standard ports cannot be previewed.',
    });
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
  });

  it('maps an unreachable runner to 502 with the stable message in the log', async () => {
    runnerStreamRequestMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'The stream could not be reached for preview.',
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('media runner is unreachable')
    );
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
  });

  it('returns a secured generic 502 when runner media fails classification', async () => {
    runnerStreamRequestMock.mockResolvedValueOnce(
      jsonResponse('Unexpected runner content', { 'content-type': 'text/html' })
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'The stream could not be reached for preview.',
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fetchPublicSourceMock).not.toHaveBeenCalled();
  });

  it('maps a runner 5xx to the generic 502', async () => {
    runnerStreamRequestMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'runner boom' }), { status: 500 })
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(previewRequest(MANIFEST_URL));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('The stream could not be reached for preview.');
    expect(body.error).not.toContain('runner boom');
  });
});
