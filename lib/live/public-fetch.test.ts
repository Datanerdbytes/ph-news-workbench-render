import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  MockAgent,
  agentCtorMock,
  destroyMock,
  closeMock,
  buildConnectorMock,
  undiciFetchMock,
  lookupMock,
} = vi.hoisted(() => {
  // A REAL class (not a vi.fn()) so `new Agent(...)` in production code works.
  class MockAgent {
    static lastOptions: Record<string, unknown> | null = null;
    constructor(options: Record<string, unknown>) {
      MockAgent.lastOptions = options;
    }
    async close() {
      await closeMock();
    }
    async destroy(error?: Error | null) {
      await destroyMock(error ?? null);
    }
  }
  return {
    MockAgent,
    agentCtorMock: vi.fn(),
    destroyMock: vi.fn(async (_error?: Error | null) => {}),
    closeMock: vi.fn(async () => {}),
    buildConnectorMock: vi.fn(),
    undiciFetchMock: vi.fn(),
    lookupMock: vi.fn(),
  };
});

// Agent must be a real class — production constructs it with `new`.
vi.mock('undici', () => ({
  Agent: MockAgent,
  fetch: undiciFetchMock,
  buildConnector: buildConnectorMock,
}));

// DNS is mocked so the pinned connector can be asserted against the
// validated addresses without touching the network.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { fetchPublicSource } from './public-fetch';

function resolveTo(...addresses: string[]) {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  );
}

const URL_UNDER_TEST =
  'https://manifest.example/live/master.m3u8?api_sig=abc&Expires=1';

beforeEach(() => {
  agentCtorMock.mockReset();
  buildConnectorMock.mockReset();
  undiciFetchMock.mockReset();
  destroyMock.mockReset();
  closeMock.mockReset();
  MockAgent.lastOptions = null;
  resolveTo('93.184.216.34');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPublicSource', () => {
  it('validates the URL and resolves DNS before any connection', async () => {
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    expect(lookupMock).toHaveBeenCalledWith('manifest.example', {
      all: true,
      verbatim: true,
    });
  });

  it('does not dispatch when the request is aborted during DNS lookup', async () => {
    let finishLookup!: (addresses: { address: string; family: number }[]) => void;
    lookupMock.mockReturnValueOnce(new Promise(resolve => { finishLookup = resolve; }));
    const controller = new AbortController();
    const request = fetchPublicSource(URL_UNDER_TEST, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toHaveProperty('name', 'AbortError');
    finishLookup([{ address: '93.184.216.34', family: 4 }]);
    await Promise.resolve();
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('dials the validated numeric address while preserving hostname/SNI', async () => {
    const connector = vi.fn(
      (_options: object, callback: (error: Error | null) => void) =>
        callback(null)
    );
    buildConnectorMock.mockReturnValue(connector);
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    expect(buildConnectorMock).toHaveBeenCalledWith({ timeout: 8_000 });
    // The agent carries a connect wrapper that dials the PINNED address while
    // keeping the requested hostname as TLS servername.
    const agentOptions = MockAgent.lastOptions as {
      connect: (
        options: { hostname: string; servername?: string },
        callback: (error: Error | null) => void
      ) => void;
      connections: number;
      maxOrigins: number;
    };
    expect(typeof agentOptions.connect).toBe('function');
    expect(agentOptions.connections).toBe(1);
    expect(agentOptions.maxOrigins).toBe(1);

    agentOptions.connect(
      { hostname: 'manifest.example', servername: 'manifest.example' },
      () => {}
    );
    const [dialedOptions] = connector.mock.calls[0] as unknown as [
      { hostname: string; servername?: string },
    ];
    // TCP dials the validated numeric address…
    expect(dialedOptions.hostname).toBe('93.184.216.34');
    // …while TLS SNI/certificate identity keeps the requested hostname.
    expect(dialedOptions.servername).toBe('manifest.example');
  });

  it('dials IPv4 before IPv6 even when DNS answers IPv6-first', async () => {
    // CDN edge hosts answer DNS per region; a runtime without IPv6 egress
    // (Render) must not be handed a dead family as the first dial target.
    resolveTo('2001:4860:4860::8888', '93.184.216.34');
    const connector = vi.fn(
      (_options: object, callback: (error: Error | null) => void) =>
        callback(null)
    );
    buildConnectorMock.mockReturnValue(connector);
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    const agentOptions = MockAgent.lastOptions as {
      connect: (
        options: { hostname: string; servername?: string },
        callback: (error: Error | null) => void
      ) => void;
    };
    agentOptions.connect(
      { hostname: 'manifest.example', servername: 'manifest.example' },
      () => {}
    );
    expect(connector).toHaveBeenCalledTimes(1);
    const [dialedOptions] = connector.mock.calls[0] as unknown as [
      { hostname: string; servername?: string },
    ];
    expect(dialedOptions.hostname).toBe('93.184.216.34');
    expect(dialedOptions.servername).toBe('manifest.example');
  });

  it('falls back to the next validated address when a dial fails', async () => {
    resolveTo('93.184.216.34', '2001:4860:4860::8888');
    const socket = {} as object;
    const connector = vi.fn()
      .mockImplementationOnce(
        (_options: object, callback: (error: Error | null) => void) =>
          callback(new Error('connect ENETUNREACH 2001:4860:4860::8888'))
      )
      .mockImplementationOnce(
        (
          _options: object,
          callback: (error: Error | null, socket: unknown) => void
        ) => callback(null, socket)
      );
    buildConnectorMock.mockReturnValue(connector);
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    const agentOptions = MockAgent.lastOptions as {
      connect: (
        options: { hostname: string; servername?: string },
        callback: (error: Error | null, socket: unknown) => void
      ) => void;
    };
    const done = vi.fn();
    agentOptions.connect(
      { hostname: 'manifest.example', servername: 'manifest.example' },
      done
    );

    // The dial walked the whole validated list in order, then succeeded.
    expect(connector).toHaveBeenCalledTimes(2);
    const dialedHosts = connector.mock.calls.map(
      (call) =>
        (call[0] as unknown as { hostname: string }).hostname
    );
    expect(dialedHosts).toEqual(['93.184.216.34', '2001:4860:4860::8888']);
    // TLS SNI keeps the requested hostname on every attempt.
    for (const call of connector.mock.calls) {
      expect(
        (call[0] as unknown as { servername?: string }).servername
      ).toBe('manifest.example');
    }
    // Exactly one callback: success with the connected socket.
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(null, socket);
  });

  it('reports the last dial error after every validated address fails', async () => {
    resolveTo('93.184.216.34', '2001:4860:4860::8888');
    const connector = vi.fn(
      (_options: object, callback: (error: Error | null) => void) =>
        callback(new Error('connect ECONNREFUSED'))
    );
    buildConnectorMock.mockReturnValue(connector);
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    const agentOptions = MockAgent.lastOptions as {
      connect: (
        options: { hostname: string; servername?: string },
        callback: (error: Error | null, socket: unknown) => void
      ) => void;
    };
    const done = vi.fn();
    agentOptions.connect(
      { hostname: 'manifest.example', servername: 'manifest.example' },
      done
    );

    expect(connector).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledTimes(1);
    const [error] = done.mock.calls[0] as [Error | null];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('connect ECONNREFUSED');
  });

  it('fetches the ORIGINAL url (host preserved for Host header + SNI)', async () => {
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    const [calledUrl, calledInit] = undiciFetchMock.mock.calls[0] as [
      string,
      { redirect: string; dispatcher: unknown },
    ];
    expect(calledUrl).toBe(URL_UNDER_TEST);
    expect(calledInit.redirect).toBe('manual');
    expect(calledInit.dispatcher).toBeDefined();
  });

  it('does NOT replace the hostname with the IP literal in the request', async () => {
    undiciFetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200 })
    );

    await fetchPublicSource(URL_UNDER_TEST);

    const [calledUrl] = undiciFetchMock.mock.calls[0] as [string];
    expect(calledUrl).not.toContain('93.184.216.34');
  });

  it('rejects a URL whose DNS resolves to a private address', async () => {
    resolveTo('10.0.0.5');

    await expect(fetchPublicSource(URL_UNDER_TEST)).rejects.toThrow(
      /non-public/
    );
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('rejects private IP literals before any connection', async () => {
    resolveTo('169.254.169.254');

    await expect(
      fetchPublicSource('http://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(/non-public/);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('propagates upstream body bytes and closes the dispatcher on completion', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    undiciFetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200 })
    );

    const res = await fetchPublicSource(URL_UNDER_TEST);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(Array.from(first.value!)).toEqual([1, 2, 3]);
    const done = await reader.read();
    expect(done.done).toBe(true);
    expect(closeMock).toHaveBeenCalled();
  });

  it('destroys the dispatcher when the consumer cancels mid-stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        // Never closes — the consumer cancels instead.
      },
    });
    undiciFetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200 })
    );

    const res = await fetchPublicSource(URL_UNDER_TEST);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel('client went away');
    expect(destroyMock).toHaveBeenCalled();
  });

  it('destroys the dispatcher when the upstream fetch throws', async () => {
    undiciFetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(fetchPublicSource(URL_UNDER_TEST)).rejects.toThrow(
      'fetch failed'
    );
    expect(destroyMock).toHaveBeenCalled();
  });
});
