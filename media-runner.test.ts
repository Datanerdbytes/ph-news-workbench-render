import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { encryptToken } from './lib/facebook-token';
import {
  createRunnerServer,
  reconcileOrphanedPumps,
  type RunnerDeps,
  type RunnerServer,
  type RunnerSql,
} from './media-runner';
import type {
  PumpManager,
  PumpStartFailureReason,
  PumpStartResult,
} from './lib/live/pump';
import type { ResolvedVideo } from './lib/live/resolve';

const {
  startMock,
  stopMock,
  statusMock,
  resolveVideoMock,
} = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  statusMock: vi.fn(),
  resolveVideoMock: vi.fn(),
}));

const TOKEN = 'runner-test-token';
const SECRET = 'runner-test-secret-for-better-auth';

type RecordedQuery = { text: string; values: unknown[]; result: unknown[] };

/**
 * A tagged-template fake of the Neon client: records every query and answers
 * from a handler keyed on the SQL text, so tests can script row lookups.
 */
function fakeSql(
  answer: (text: string, values: unknown[]) => unknown[] = () => []
) {
  const queries: RecordedQuery[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const result = answer(text, values);
    queries.push({ text, values, result });
    return Promise.resolve(result);
  }) as unknown as RunnerSql;
  return { fn, queries };
}

function fakeManager(): PumpManager {
  return {
    start: startMock,
    stop: stopMock,
    status: statusMock,
  } as unknown as PumpManager;
}

const RESOLVED: ResolvedVideo = {
  title: 'DZMM TeleRadyo',
  isLive: true,
  playableUrl: 'https://manifest.example/live.m3u8',
  mode: 'direct',
  extractor: 'generic',
};

function makeServer(
  sqlAnswer?: (text: string, values: unknown[]) => unknown[]
): { runner: RunnerServer; queries: RecordedQuery[] } {
  const { fn, queries } = fakeSql(sqlAnswer);
  const deps: RunnerDeps = {
    sql: fn,
    manager: fakeManager(),
    resolveVideo: resolveVideoMock,
  };
  const runner = createRunnerServer(deps);
  return { runner, queries };
}

async function listen(runner: RunnerServer): Promise<number> {
  await runner.listen(0);
  const address = runner.server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

type ClientResult = { status: number; body: unknown };

function client(
  port: number,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'POST',
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );
    request.on('error', reject);
    if (options.body !== undefined) request.end(JSON.stringify(options.body));
    else request.end();
  });
}

const STREAM_ROW = () => [
  {
    id: 7,
    source_url: 'https://manifest.example/live.m3u8',
    source_mode: 'direct',
    secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    stream_key: encryptToken('fb-key-123'),
    pump_started_at: null,
  },
];

beforeEach(() => {
  process.env.MEDIA_RUNNER_TOKEN = TOKEN;
  process.env.BETTER_AUTH_SECRET = SECRET;
  startMock.mockReset();
  stopMock.mockReset();
  statusMock.mockReset();
  resolveVideoMock.mockReset();
  statusMock.mockReturnValue({
    running: false,
    startedAt: null,
    error: null,
    retrying: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth gate', () => {
  it('healthz answers without a token (no secrets in the payload)', async () => {
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/healthz', { method: 'GET' });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, sandbox: 'unavailable' });
    } finally {
      await runner.close();
    }
  });

  it('refuses everything with 503 when the worker has no token configured', async () => {
    delete process.env.MEDIA_RUNNER_TOKEN;
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        body: { url: 'https://example.com/v' },
        token: 'whatever',
      });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: /MEDIA_RUNNER_TOKEN/ });
    } finally {
      await runner.close();
    }
  });

  it('rejects a wrong bearer with 401', async () => {
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        body: { url: 'https://example.com/v' },
        token: 'wrong',
      });
      expect(result.status).toBe(401);
    } finally {
      await runner.close();
    }
  });
});

describe('POST /resolve', () => {
  it('validates, resolves, and returns the video payload', async () => {
    resolveVideoMock.mockResolvedValueOnce(RESOLVED);
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        token: TOKEN,
        body: { url: 'https://www.youtube.com/watch?v=abc' },
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual(RESOLVED);
      expect(resolveVideoMock).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=abc'
      );
    } finally {
      await runner.close();
    }
  });

  it('maps a network-policy rejection to 400 invalid_url', async () => {
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        token: TOKEN,
        body: { url: 'not a url' },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid_url' });
      expect(resolveVideoMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });

  it('maps a resolver failure to the resolver status contract', async () => {
    const { ResolveError } = await import('./lib/live/resolve');
    resolveVideoMock.mockRejectedValueOnce(
      new ResolveError('unavailable', 'That video is not available.')
    );
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        token: TOKEN,
        body: { url: 'https://example.com/v' },
      });
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({
        error: 'That video is not available.',
        code: 'unavailable',
      });
    } finally {
      await runner.close();
    }
  });

  it('answers 400 when the url is missing', async () => {
    const { runner } = makeServer();
    const port = await listen(runner);
    try {
      const result = await client(port, '/resolve', {
        token: TOKEN,
        body: {},
      });
      expect(result.status).toBe(400);
    } finally {
      await runner.close();
    }
  });
});

describe('POST /pump/start', () => {
  const okOutcome: PumpStartResult = { ok: true };

  it('starts the pump, writes running, and returns the pump payload', async () => {
    startMock.mockResolvedValueOnce(okOutcome);
    statusMock.mockReturnValueOnce({
      running: false,
      startedAt: null,
      error: null,
      retrying: false,
    });
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : [{ pump_started_at: new Date('2026-11-20T01:00:00Z') }]
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        pump: { status: 'running', startedAt: '2026-11-20T01:00:00.000Z' },
      });
      expect(startMock).toHaveBeenCalledTimes(1);
      const call = startMock.mock.calls[0][0] as {
        id: number;
        source: string;
        mode: string;
        dest: string;
      };
      expect(call.id).toBe(7);
      expect(call.source).toBe('https://manifest.example/live.m3u8');
      expect(call.mode).toBe('direct');
      // The publisher destination is the DECRYPTED key — verified allowlisted.
      expect(call.dest).toBe(
        'rtmps://live-api-s.facebook.com:443/rtmp/fb-key-123'
      );
      const update = queries.find((query) =>
        query.text.includes("SET pump_status = 'running'")
      );
      expect(update).toBeDefined();
    } finally {
      await runner.close();
    }
  });

  it('maps the manager failure reasons to the route status contract', async () => {
    const cases: {
      outcome: Extract<PumpStartResult, { ok: false; reason: PumpStartFailureReason }>;
      status: number;
    }[] = [
      {
        outcome: { ok: false, reason: 'gate_disabled', error: 'gate' },
        status: 400,
      },
      {
        outcome: {
          ok: false,
          reason: 'isolation_unavailable',
          error: 'isolated',
        },
        status: 503,
      },
      {
        outcome: { ok: false, reason: 'already_running', error: 'already' },
        status: 409,
      },
      {
        outcome: { ok: false, reason: 'spawn_failed', error: 'boom' },
        status: 502,
      },
    ];
    for (const { outcome, status } of cases) {
      startMock.mockResolvedValueOnce(outcome);
      const { runner, queries } = makeServer((text) =>
        text.includes('FROM live_streams') ? STREAM_ROW() : []
      );
      const port = await listen(runner);
      try {
        const result = await client(port, '/pump/start', {
          token: TOKEN,
          body: { workspaceId: 'ws-1', streamId: '7' },
        });
        expect(result.status).toBe(status);
        if (outcome.reason === 'spawn_failed') {
          const update = queries.find((query) =>
            query.text.includes("SET pump_status = 'failed'")
          );
          expect(update).toBeDefined();
        }
      } finally {
        await runner.close();
      }
    }
  });

  it('404s an unknown stream and never reaches the manager', async () => {
    const { runner } = makeServer(() => []);
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '999' },
      });
      expect(result.status).toBe(404);
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });

  it('400s a stream with no resolved source', async () => {
    const { runner } = makeServer((text) =>
      text.includes('FROM live_streams')
        ? [{ ...STREAM_ROW()[0], source_url: null }]
        : []
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: /Resolve a source URL/ });
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });

  it('refuses a non-Facebook ingest destination before spawning', async () => {
    const { runner } = makeServer((text) =>
      text.includes('FROM live_streams')
        ? [
            {
              ...STREAM_ROW()[0],
              secure_stream_url: 'rtmps://evil.example.com:443/rtmp/',
            },
          ]
        : []
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: /not a Facebook endpoint/ });
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });

  it('400s when the stored stream key cannot be decrypted', async () => {
    const { runner } = makeServer((text) =>
      text.includes('FROM live_streams')
        ? [{ ...STREAM_ROW()[0], stream_key: 'garbage-ciphertext' }]
        : []
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: /could not be decrypted/ });
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });

  it('409s when the manager already runs this stream', async () => {
    statusMock.mockReturnValueOnce({
      running: true,
      startedAt: new Date(),
      error: null,
      retrying: false,
    });
    const { runner } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : []
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(409);
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });
});

describe('POST /pump/stop', () => {
  it('stops one stream, writes stopped, and returns the payload', async () => {
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : []
    );
    const port = await listen(runner);
    try {
      const result = await client(port, '/pump/stop', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ pump: { status: 'stopped' } });
      expect(stopMock).toHaveBeenCalledWith(7);
      const update = queries.find((query) =>
        query.text.includes("SET pump_status = 'stopped'")
      );
      expect(update).toBeDefined();
    } finally {
      await runner.close();
    }
  });

  it('stop-all only touches pumps this worker started for the workspace', async () => {
    // Start a pump first so the registry has an entry for ws-1.
    startMock.mockResolvedValue({ ok: true });
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : [{ pump_started_at: null }]
    );
    const port = await listen(runner);
    try {
      await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      const result = await client(port, '/pump/stop', {
        token: TOKEN,
        body: { workspaceId: 'ws-1' },
      });
      expect(result.status).toBe(200);
      // Stop-all keys off the registry (string ids) — the manager accepts
      // either; assert the actual contract.
      expect(stopMock).toHaveBeenCalledWith('7');
      const updates = queries.filter((query) =>
        query.text.includes("SET pump_status = 'stopped'")
      );
      expect(updates.length).toBeGreaterThan(0);
      // A stop-all for another workspace must not touch the ws-1 pump.
      stopMock.mockClear();
      await client(port, '/pump/stop', {
        token: TOKEN,
        body: { workspaceId: 'ws-other' },
      });
      expect(stopMock).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });
});

describe('reconcileOnce', () => {
  it('writes failed with the manager error when a pump terminally dies', async () => {
    startMock.mockResolvedValue({ ok: true });
    // Start with the pump idle so the start request passes the duplicate
    // gate; the test then drives the manager into its terminal state.
    let managerStatus = {
      running: false,
      startedAt: null as Date | null,
      error: null as string | null,
      retrying: false,
    };
    statusMock.mockImplementation(() => managerStatus);
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : [{ pump_started_at: null }]
    );
    const port = await listen(runner);
    try {
      await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      managerStatus = {
        running: false,
        startedAt: new Date(),
        error: 'ffmpeg exited with code 1 (stderr: …***…)',
        retrying: false,
      };
      await runner.reconcileOnce();
      const update = queries.find((query) =>
        query.text.includes("SET pump_status = 'failed'")
      );
      expect(update).toBeDefined();
      expect(update?.values).toContain('ffmpeg exited with code 1 (stderr: …***…)');
    } finally {
      await runner.close();
    }
  });

  it('does not write while a retry backoff is pending', async () => {
    startMock.mockResolvedValue({ ok: true });
    const managerStatus = {
      running: false,
      startedAt: new Date(),
      error: null as string | null,
      retrying: true,
    };
    statusMock.mockImplementation(() => managerStatus);
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : [{ pump_started_at: null }]
    );
    const port = await listen(runner);
    try {
      await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      const before = queries.length;
      await runner.reconcileOnce();
      expect(
        queries.slice(before).some((query) => query.text.includes('UPDATE'))
      ).toBe(false);
    } finally {
      await runner.close();
    }
  });

  it('backfills a lost running write exactly once', async () => {
    startMock.mockResolvedValue({ ok: true });
    // Idle at start (so the duplicate gate passes), running at reconcile
    // (so the pump is alive and only the DB write needs healing).
    let managerStatus = {
      running: false,
      startedAt: null as Date | null,
      error: null as string | null,
      retrying: false,
    };
    statusMock.mockImplementation(() => managerStatus);
    const { runner, queries } = makeServer((text) =>
      text.includes('FROM live_streams') ? STREAM_ROW() : [{ pump_started_at: null }]
    );
    const port = await listen(runner);
    try {
      // Simulate the start write failing: registry entry exists but was never
      // confirmed — force it by clearing the flag after the request.
      await client(port, '/pump/start', {
        token: TOKEN,
        body: { workspaceId: 'ws-1', streamId: '7' },
      });
      const tracked = (
        runner.registry as Map<string, { dbRunning: boolean }>
      ).get('7');
      if (tracked) tracked.dbRunning = false;
      managerStatus = {
        running: true,
        startedAt: new Date(),
        error: null,
        retrying: false,
      };
      const before = queries.length;
      await runner.reconcileOnce();
      expect(
        queries
          .slice(before)
          .some((query) => query.text.includes("SET pump_status = 'running'"))
      ).toBe(true);
      const after = queries.length;
      await runner.reconcileOnce();
      expect(queries.length).toBe(after);
    } finally {
      await runner.close();
    }
  });
});

describe('reconcileOrphanedPumps', () => {
  it('marks every running row failed with the restart message', async () => {
    const { fn, queries } = fakeSql(() => [{ id: 3 }, { id: 9 }]);
    const count = await reconcileOrphanedPumps(fn);
    expect(count).toBe(2);
    const updates = queries.filter((query) =>
      query.text.includes("SET pump_status = 'failed'")
    );
    expect(updates.length).toBe(2);
    expect(updates[0].values).toContain(
      'The media runner restarted while this pump was running. Start it again.'
    );
  });
});
