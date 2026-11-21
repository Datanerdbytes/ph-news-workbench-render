import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

import {
  RUNNER_UNREACHABLE_ERROR,
  runnerMode,
  runnerRequest,
  runnerStreamRequest,
} from './runner-config';

const BASE = 'https://media-runner.fly.dev';
const TOKEN = 'shared-runner-token';

beforeEach(() => {
  process.env.MEDIA_RUNNER_URL = BASE;
  process.env.MEDIA_RUNNER_TOKEN = TOKEN;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MEDIA_RUNNER_URL;
  delete process.env.MEDIA_RUNNER_TOKEN;
  vi.restoreAllMocks();
});

describe('runnerMode', () => {
  it('is off without MEDIA_RUNNER_URL', () => {
    delete process.env.MEDIA_RUNNER_URL;
    expect(runnerMode()).toBe(false);
  });

  it('is on when MEDIA_RUNNER_URL is set (even blank-ish)', () => {
    process.env.MEDIA_RUNNER_URL = '  ';
    expect(runnerMode()).toBe(false);
    process.env.MEDIA_RUNNER_URL = BASE;
    expect(runnerMode()).toBe(true);
  });
});

describe('runnerRequest', () => {
  it('posts JSON with the bearer token and returns the response verbatim', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ pump: { status: 'running' } }), {
        status: 200,
      })
    );

    const outcome = await runnerRequest('/pump/start', {
      workspaceId: 'ws-1',
      streamId: '7',
    });

    expect(outcome).toEqual({
      kind: 'response',
      status: 200,
      body: { pump: { status: 'running' } },
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string; method: string },
    ];
    expect(url).toBe(`${BASE}/pump/start`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      workspaceId: 'ws-1',
      streamId: '7',
    });
  });

  it('unreachable on a transport failure — never throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const outcome = await runnerRequest('/resolve', { url: 'https://x' });

    expect(outcome).toEqual({ kind: 'unreachable', error: 'fetch failed' });
  });

  it('unreachable when the connection fails after response headers', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    })));

    await expect(runnerRequest('/resolve', { url: 'https://x' })).resolves.toEqual({
      kind: 'unreachable', error: 'terminated',
    });
  });

  it.each(['headers', 'body'])('bounds a stalled runner %s with the request deadline', async (phase) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Runner timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      const signal = init.signal!;
      if (phase === 'headers') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"title":'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      })));
    });

    const pending = runnerRequest('/resolve', { url: 'https://x' });
    // Attach the assertion before advancing so rejected bodies are observed.
    const result = expect(pending).resolves.toMatchObject({ kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(75_000);
    await result;
    expect(timeout).toHaveBeenCalledWith(75_000);
  });

  it('unreachable when the token is not configured', async () => {
    delete process.env.MEDIA_RUNNER_TOKEN;

    const outcome = await runnerRequest('/resolve', { url: 'https://x' });

    expect(outcome).toEqual({
      kind: 'unreachable',
      error: 'The media runner token is not configured.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unreachable when the URL is not configured', async () => {
    delete process.env.MEDIA_RUNNER_URL;

    const outcome = await runnerRequest('/resolve', { url: 'https://x' });

    expect(outcome).toMatchObject({ kind: 'unreachable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps a non-JSON body into an error payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }));

    const outcome = await runnerRequest('/pump/stop', {});

    expect(outcome).toEqual({
      kind: 'response',
      status: 504,
      body: { error: 'gateway timeout' },
    });
  });

  it('passes the worker error contract through untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'The pump is already running for this stream.' }),
        { status: 409 }
      )
    );

    const outcome = await runnerRequest('/pump/start', {});

    expect(outcome).toEqual({
      kind: 'response',
      status: 409,
      body: { error: 'The pump is already running for this stream.' },
    });
  });

  it('exposes the stable unreachable message used by the routes', () => {
    expect(RUNNER_UNREACHABLE_ERROR).toMatch(/media runner is unreachable/i);
  });
});

describe('runnerStreamRequest', () => {
  it('posts JSON with the bearer token and returns the RAW response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('#EXTM3U\nseg0.ts\n', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    );

    const response = await runnerStreamRequest(
      '/preview-media',
      { url: 'https://manifest.example/live.m3u8' },
      new AbortController().signal
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.apple.mpegurl'
    );
    // Body is streamable, never buffered.
    expect(await response.text()).toBe('#EXTM3U\nseg0.ts\n');
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string; signal: AbortSignal },
    ];
    expect(url).toBe(`${BASE}/preview-media`);
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://manifest.example/live.m3u8',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('combines the caller signal so a browser abort reaches the runner', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200 }));
    const controller = new AbortController();
    controller.abort();

    await runnerStreamRequest('/preview-media', {}, controller.signal);

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { signal: AbortSignal },
    ];
    expect(init.signal.aborted).toBe(true);
  });

  it('throws when the runner URL is not configured', async () => {
    delete process.env.MEDIA_RUNNER_URL;

    await expect(
      runnerStreamRequest('/preview-media', {}, new AbortController().signal)
    ).rejects.toThrow('The media runner URL is not configured.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the runner token is not configured', async () => {
    delete process.env.MEDIA_RUNNER_TOKEN;

    await expect(
      runnerStreamRequest('/preview-media', {}, new AbortController().signal)
    ).rejects.toThrow('The media runner token is not configured.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
