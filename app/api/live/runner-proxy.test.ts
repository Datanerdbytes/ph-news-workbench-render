import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runner-mode route behavior: with MEDIA_RUNNER_URL configured the live
 * routes relay pump/resolve work to the media runner worker instead of
 * spawning locally. The worker's JSON contract is asserted elsewhere
 * (media-runner.test.ts, runner-config.test.ts); here we prove each route
 * branches correctly, passes the worker's response through verbatim, and
 * never touches the local manager or DB lifecycle writes.
 */

const {
  sqlMock,
  requireWorkspaceMock,
  requirePublishingConnectionMock,
  managerMock,
  runnerRequestMock,
} = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
  requirePublishingConnectionMock: vi.fn(),
  managerMock: {
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(() => ({ running: false, startedAt: null, error: null })),
  },
  runnerRequestMock: vi.fn(),
}));

vi.mock('@/lib/live/runner-config', () => ({
  runnerMode: () => true,
  runnerRequest: runnerRequestMock,
  RUNNER_UNREACHABLE_ERROR:
    'The media runner is unreachable right now. Try again shortly.',
}));
vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
vi.mock('@/lib/publishing/connection', () => ({
  requirePublishingConnection: requirePublishingConnectionMock,
}));
vi.mock('@/lib/facebook-token', () => ({
  decryptToken: vi.fn(() => 'decrypted-key'),
  encryptToken: vi.fn((value: string) => value),
}));
vi.mock('@/lib/live/pump', () => ({
  getPumpManager: () => managerMock,
  isFacebookIngestUrl: vi.fn(() => true),
  assembleRtmpsUrl: (base: string | null, key: string | null) =>
    base && key ? `${base.replace(/\/$/, '')}/${key}` : null,
}));
vi.mock('@/lib/live/resolve', () => ({
  resolveVideoUrl: vi.fn(),
  ResolveError: class ResolveError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { POST as pumpPost } from '@/app/api/live/[id]/pump/route';
import { GET as liveGet } from '@/app/api/live/route';
import { POST as resolvePost } from '@/app/api/live/resolve/route';
import { POST as disconnectPost } from '@/app/api/facebook/disconnect/route';

const access = {
  user: { id: 'editor-1' },
  workspace: { id: 'workspace-1', role: 'editor' },
};

const stream = {
  id: 21,
  source_url: 'https://source.example/live.m3u8',
  source_mode: 'direct',
  secure_stream_url: 'rtmps://ingest.example/stream',
  stream_key: 'encrypted-key',
  pump_started_at: '2026-01-01T00:00:00.000Z',
};

function queryText(call: unknown[]) {
  return (call[0] as string[]).join('?');
}

let selectedStream: typeof stream | null = stream;
let liveRows: Record<string, unknown>[] = [];

function pumpRequest(action: 'start' | 'stop') {
  return pumpPost(
    new NextRequest('http://localhost/api/live/21/pump', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id: '21' }) }
  );
}

function resolveRequest(url: string) {
  return resolvePost(
    new NextRequest('http://localhost/api/live/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  selectedStream = stream;
  liveRows = [];
  requireWorkspaceMock.mockResolvedValue(access);
  requirePublishingConnectionMock.mockResolvedValue({
    context: {
      access,
      connection: { accessToken: 'token', pageId: 'page-1', scopes: ['pages_manage_posts', 'publish_video'] },
    },
  });
  runnerRequestMock.mockResolvedValue({
    kind: 'response',
    status: 200,
    body: { pump: { status: 'running', startedAt: null } },
  });
  sqlMock.mockImplementation(async (...args: unknown[]) => {
    const text = queryText(args);
    if (text.includes('SELECT id, source_url')) {
      return selectedStream ? [selectedStream] : [];
    }
    if (text.includes('ORDER BY created_at')) return liveRows;
    if (text.includes('SELECT id, facebook_video_id')) return [];
    return [];
  });
});

describe('pump route in runner mode', () => {
  it('start relays to the worker and passes the response through verbatim', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'response',
      status: 409,
      body: { error: 'The pump is already running for this stream.' },
    });

    const response = await pumpRequest('start');

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toEqual({
      error: 'The pump is already running for this stream.',
    });
    expect(runnerRequestMock).toHaveBeenCalledWith('/pump/start', {
      workspaceId: 'workspace-1',
      streamId: '21',
    });
    // Nothing spawned or written locally — the worker owns the lifecycle.
    expect(managerMock.start).not.toHaveBeenCalled();
    expect(managerMock.status).not.toHaveBeenCalled();
  });

  it('start maps an unreachable worker to a 502 with the stable message', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'unreachable',
      error: 'fetch failed',
    });

    const response = await pumpRequest('start');

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error).toMatch(/media runner is unreachable/);
    expect(managerMock.start).not.toHaveBeenCalled();
  });

  it('start 404s an unknown stream before proxying', async () => {
    selectedStream = null;

    const response = await pumpRequest('start');

    expect(response.status).toBe(404);
    expect(runnerRequestMock).not.toHaveBeenCalled();
  });

  it('stop relays to the worker without local lifecycle writes', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'response',
      status: 200,
      body: { pump: { status: 'stopped', startedAt: '2026-01-01T00:00:00.000Z' } },
    });

    const response = await pumpRequest('stop');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pump: { status: 'stopped', startedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(runnerRequestMock).toHaveBeenCalledWith('/pump/stop', {
      workspaceId: 'workspace-1',
      streamId: '21',
    });
    expect(managerMock.stop).not.toHaveBeenCalled();
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes("SET pump_status = 'stopped'")
      )
    ).toBe(false);
  });
});

describe('disconnect route in runner mode', () => {
  it('asks the worker to stop-all and still deletes the connection', async () => {
    const response = await disconnectPost(
      new NextRequest('http://localhost/api/facebook/disconnect', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(runnerRequestMock).toHaveBeenCalledWith('/pump/stop', {
      workspaceId: 'workspace-1',
    });
    expect(managerMock.stop).not.toHaveBeenCalled();
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes('DELETE FROM facebook_connections')
      )
    ).toBe(true);
  });

  it('disconnect still succeeds when the worker is unreachable', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'unreachable',
      error: 'fetch failed',
    });

    const response = await disconnectPost(
      new NextRequest('http://localhost/api/facebook/disconnect', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes('DELETE FROM facebook_connections')
      )
    ).toBe(true);
  });
});

describe('resolve route in runner mode', () => {
  it('relays the url and passes the resolved payload through', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'response',
      status: 200,
      body: { title: 'DZMM', isLive: true, playableUrl: null, mode: 'staged', extractor: 'generic' },
    });

    const response = await resolveRequest('https://facebook.com/video');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: 'DZMM', mode: 'staged' });
    expect(runnerRequestMock).toHaveBeenCalledWith('/resolve', {
      url: 'https://facebook.com/video',
    });
  });

  it('passes the worker error contract through with its status', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'response',
      status: 502,
      body: { error: 'That video is not available.', code: 'unavailable' },
    });

    const response = await resolveRequest('https://facebook.com/video');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'That video is not available.',
      code: 'unavailable',
    });
  });

  it('maps an unreachable worker to a 502 with the stable message', async () => {
    runnerRequestMock.mockResolvedValueOnce({
      kind: 'unreachable',
      error: 'fetch failed',
    });

    const response = await resolveRequest('https://facebook.com/video');

    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/media runner is unreachable/);
  });
});

describe('GET /api/live in runner mode', () => {
  it('trusts the DB pump_status instead of reporting interrupted', async () => {
    liveRows = [
      {
        id: 21,
        facebook_video_id: 'fb-video-1',
        title: 'DZMM',
        description: null,
        status: 'LIVE',
        stream_key: 'encrypted',
        secure_stream_url: 'rtmps://ingest.example/stream',
        permalink_url: null,
        planned_start_time: null,
        created_at: '2026-01-01T00:00:00.000Z',
        source_url: 'https://source.example/live.m3u8',
        source_mode: 'direct',
        pump_status: 'running',
        pump_started_at: '2026-01-01T00:00:00.000Z',
        pump_error: null,
      },
    ];

    const response = await liveGet(
      new NextRequest('http://localhost/api/live', { method: 'GET' })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { streams: { pumpStatus: string }[] };
    expect(payload.streams[0].pumpStatus).toBe('running');
    // The local manager must not be consulted: it holds no record for a
    // worker-owned pump and would downgrade running to interrupted.
    expect(managerMock.status).not.toHaveBeenCalled();
  });
});
