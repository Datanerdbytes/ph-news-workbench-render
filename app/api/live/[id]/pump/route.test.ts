import { NextRequest } from 'next/server';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, requireWorkspaceMock, requirePublishingConnectionMock, managerMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
    requirePublishingConnectionMock: vi.fn(),
    managerMock: {
      start: vi.fn(),
      stop: vi.fn(),
      status: vi.fn(),
    },
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
vi.mock('@/lib/facebook-token', () => ({ decryptToken: vi.fn(() => 'decrypted-key') }));
vi.mock('@/lib/live/pump', () => ({
  assembleRtmpsUrl: (base: string | null, key: string | null) =>
    base && key ? `${base.replace(/\/$/, '')}/${key}` : null,
  // The ingest allowlist has its own unit tests (pump.test.ts); the route
  // tests only need it to pass so the lifecycle behavior is exercised.
  isFacebookIngestUrl: vi.fn(() => true),
  getPumpManager: () => managerMock,
}));

import { POST as pumpPost } from './route';
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

function disconnectRequest() {
  return disconnectPost(new NextRequest('http://localhost/api/facebook/disconnect', { method: 'POST' }));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the lifecycle operation.');
}

let facebookConnected = true;
let streamsForDisconnect: { id: number }[] = [];
let selectedStream: typeof stream | null = stream;
let events: string[];

beforeEach(() => {
  vi.clearAllMocks();
  facebookConnected = true;
  streamsForDisconnect = [{ id: 21 }];
  selectedStream = stream;
  events = [];
  requireWorkspaceMock.mockResolvedValue(access);
  requirePublishingConnectionMock.mockImplementation(async () =>
    facebookConnected
      ? {
          context: {
            access,
            connection: { accessToken: 'token', pageId: 'page-1', scopes: ['pages_manage_posts'] },
          },
        }
      : { response: new Response(JSON.stringify({ code: 'not_connected' }), { status: 409 }) }
  );
  managerMock.start.mockImplementation(async () => ({ ok: true }));
  managerMock.stop.mockImplementation((id: number) => {
    events.push(`stop:${id}`);
    return { ok: true, wasRunning: true };
  });
  managerMock.status.mockReturnValue({ running: false, startedAt: null, error: null });
  sqlMock.mockImplementation(async (...args: unknown[]) => {
    const text = queryText(args);
    if (text.includes('SELECT id, source_url')) return selectedStream ? [selectedStream] : [];
    if (text.includes('SELECT id') && text.includes('FROM live_streams')) {
      return streamsForDisconnect;
    }
    if (text.includes("SET pump_status = 'running'")) events.push('db:running');
    if (text.includes("SET pump_status = 'stopped'")) events.push('db:stopped');
    if (text.includes('DELETE FROM facebook_connections')) {
      facebookConnected = false;
      events.push('disconnect');
    }
    return [];
  });
});

describe('POST /api/live/[id]/pump', () => {
  it('allocates the output pipe inside the sandbox-approved OS temporary directory', async () => {
    const tmpdir = vi.spyOn(os, 'tmpdir').mockReturnValue('/sandbox-approved-tmp');
    try {
      const response = await pumpRequest('start');
      expect(response.status).toBe(200);
      expect(path.dirname(managerMock.start.mock.calls[0][0].outFifo)).toBe('/sandbox-approved-tmp');
    } finally {
      tmpdir.mockRestore();
    }
  });

  it('allows an authenticated editor to stop without Facebook credentials or scopes', async () => {
    const response = await pumpRequest('stop');

    expect(response.status).toBe(200);
    expect(requirePublishingConnectionMock).not.toHaveBeenCalled();
    expect(managerMock.stop).toHaveBeenCalledWith(21);
    const findCall = sqlMock.mock.calls.find((call) => queryText(call).includes('SELECT id, source_url'))!;
    expect(queryText(findCall)).toContain('workspace_id =');
    expect(findCall.slice(1)).toEqual(['workspace-1', '21', '21']);
    const updateCall = sqlMock.mock.calls.find((call) => queryText(call).includes("SET pump_status = 'stopped'"))!;
    expect(updateCall.slice(1)).toEqual([21, 'workspace-1']);
  });

  it('does not stop a stream from another tenant', async () => {
    selectedStream = null;
    const response = await pumpRequest('stop');

    expect(response.status).toBe(404);
    expect(managerMock.stop).not.toHaveBeenCalled();
    const findCall = sqlMock.mock.calls.find((call) => queryText(call).includes('SELECT id, source_url'))!;
    expect(queryText(findCall)).toContain('workspace_id =');
    expect(findCall.slice(1)).toEqual(['workspace-1', '21', '21']);
  });

  it('requires publishing authorization only for starting the pump', async () => {
    const response = await pumpRequest('start');

    expect(response.status).toBe(200);
    expect(requirePublishingConnectionMock).toHaveBeenCalledOnce();
    expect(managerMock.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21, dest: 'rtmps://ingest.example/stream/decrypted-key' })
    );
    expect(events).toContain('db:running');
  });

  it('rejects unauthenticated stop requests', async () => {
    requireWorkspaceMock.mockResolvedValue(null);
    const response = await pumpRequest('stop');
    expect(response.status).toBe(401);
    expect(managerMock.stop).not.toHaveBeenCalled();
  });
});

describe('start/disconnect serialization', () => {
  it('finishes start writes before disconnect stops and marks the pump stopped', async () => {
    const startGate = deferred<{ ok: true }>();
    managerMock.start.mockImplementation(() => {
      events.push('start');
      return startGate.promise;
    });

    const starting = pumpRequest('start');
    await waitUntil(() => events.includes('start'));
    const disconnecting = disconnectRequest();
    expect(managerMock.stop).not.toHaveBeenCalled();

    startGate.resolve({ ok: true });
    const startResponse = await starting;
    const disconnectResponse = await disconnecting;

    expect(startResponse.status).toBe(200);
    expect(disconnectResponse.status).toBe(200);
    expect(events).toEqual(['start', 'db:running', 'stop:21', 'db:stopped', 'disconnect']);
  });

  it('when disconnect wins, start checks the connection after disconnect and never spawns', async () => {
    const selectGate = deferred<{ id: number }[]>();
    const selectEntered = deferred<void>();
    sqlMock.mockImplementation(async (...args: unknown[]) => {
      const text = queryText(args);
      if (text.includes('SELECT id, source_url')) return selectedStream ? [selectedStream] : [];
      if (text.includes('SELECT id') && text.includes('FROM live_streams')) {
        selectEntered.resolve();
        return selectGate.promise;
      }
      if (text.includes("SET pump_status = 'stopped'")) events.push('db:stopped');
      if (text.includes('DELETE FROM facebook_connections')) {
        facebookConnected = false;
        events.push('disconnect');
      }
      return [];
    });

    const disconnecting = disconnectRequest();
    await selectEntered.promise;
    const starting = pumpRequest('start');
    selectGate.resolve([{ id: 21 }]);

    const disconnectResponse = await disconnecting;
    const startResponse = await starting;

    expect(disconnectResponse.status).toBe(200);
    expect(startResponse.status).toBe(409);
    expect(managerMock.start).not.toHaveBeenCalled();
    expect(events).toEqual(['stop:21', 'db:stopped', 'disconnect']);
    expect(requirePublishingConnectionMock).toHaveBeenCalledOnce();
  });
});
