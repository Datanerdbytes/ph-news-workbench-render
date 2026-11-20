import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

import {
  RUNNER_UNREACHABLE_ERROR,
  runnerMode,
  runnerRequest,
} from './runner-config';

const BASE = 'https://media-runner.fly.dev';
const TOKEN = 'shared-runner-token';

beforeEach(() => {
  process.env.MEDIA_RUNNER_URL = BASE;
  process.env.MEDIA_RUNNER_TOKEN = TOKEN;
  fetchMock.mockReset();
});

afterEach(() => {
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
