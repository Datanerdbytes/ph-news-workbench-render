import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createResolvedAddressGuard } from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { initialize: vi.fn() },
}));

import { ensureMediaSandbox, mediaSandboxAvailability } from './media-sandbox';

// globalThis state survives across tests in one file — reset via each test's
// own expectations; the module caches state, so order matters per describe.
function state() {
  return (
    (globalThis as unknown as { __phMediaSandbox?: { state: string; reason: string | null; initializing: Promise<void> | null } })
      .__phMediaSandbox ?? null
  );
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe('mediaSandboxAvailability', () => {
  it('reports unavailable with a reason before initialization', () => {
    // Fresh module state in a fresh worker: uninitialized means unavailable.
    const availability = mediaSandboxAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('not been initialized');
  });
});

describe('ensureMediaSandbox', () => {
  it('succeeds when every platform primitive probe passes', async () => {
    // macOS path: sandbox-exec + rg + the functional profile probe.
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === '/bin/echo' || command === 'echo') return { status: 0 };
      return { status: 0 };
    });
    (globalThis as unknown as { __phMediaSandbox?: unknown }).__phMediaSandbox = {
      state: 'uninitialized',
      reason: null,
      initializing: null,
    };

    await ensureMediaSandbox();

    expect(state()?.state).toBe('ready');
    expect(mediaSandboxAvailability().available).toBe(true);
  });

  it('fails closed when the functional sandbox probe is refused', async () => {
    // A Linux-style runtime refusing unprivileged user namespaces: the
    // bwrap --version probe passes but the functional run is refused.
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'bwrap' && args[0] !== '--version') return { status: 1 };
      return { status: 0 };
    });
    (globalThis as unknown as { __phMediaSandbox?: unknown }).__phMediaSandbox = {
      state: 'uninitialized',
      reason: null,
      initializing: null,
    };

    await ensureMediaSandbox();

    expect(state()?.state).toBe('unavailable');
    expect(state()?.reason).toContain('user namespaces');
    expect(mediaSandboxAvailability().available).toBe(false);
    platformSpy.mockRestore();
  });

  it.each([
    ['146.75.22.132', true],
    ['::ffff:146.75.22.132', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['10.0.0.1', false],
    ['::ffff:10.0.0.1', false],
    ['172.16.0.1', false],
    ['192.168.0.1', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['::ffff:169.254.169.254', false],
    ['168.63.129.16', false],
    ['0.0.0.0', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['224.0.0.1', false],
    ['ff02::1', false],
  ])('configured runtime policy permits %s: %s', async (address, permitted) => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    (globalThis as unknown as { __phMediaSandbox?: unknown }).__phMediaSandbox = {
      state: 'uninitialized',
      reason: null,
      initializing: null,
    };

    await ensureMediaSandbox();

    const config = vi.mocked(SandboxManager.initialize).mock.calls.at(-1)?.[0];
    expect(config?.network.deniedResolvedAddresses).toBeDefined();
    const guard = createResolvedAddressGuard({
      allowedDomains: config?.network.allowedDomains,
      deniedDomains: config?.network.deniedDomains,
      deniedResolvedAddresses: config?.network.deniedResolvedAddresses,
      localAddresses: () => [],
    });
    expect(guard.permits('video.example', address, 443)).toBe(permitted);
  });

  it('fails closed when an operator disables the sandbox', async () => {
    vi.stubEnv('DISABLE_MEDIA_SANDBOX', '1');
    (globalThis as unknown as { __phMediaSandbox?: unknown }).__phMediaSandbox = {
      state: 'uninitialized',
      reason: null,
      initializing: null,
    };

    await ensureMediaSandbox();

    expect(state()?.state).toBe('unavailable');
    expect(state()?.reason).toContain('disabled by configuration');
    vi.unstubAllEnvs();
  });
});
