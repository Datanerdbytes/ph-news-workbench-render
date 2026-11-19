import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  wrapWithSandboxMock,
  spawnMock,
  availabilityMock,
  processKillMock,
} = vi.hoisted(() => ({
  wrapWithSandboxMock: vi.fn(),
  spawnMock: vi.fn(),
  availabilityMock: vi.fn(),
  processKillMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    wrapWithSandbox: wrapWithSandboxMock,
  },
}));
vi.mock('./media-sandbox', () => ({
  mediaSandboxAvailability: availabilityMock,
}));

// guardedSpawn spawns via the REAL node:child_process — spy on process.kill
// so the group-kill behavior is observable without real children.
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  guardedSpawn,
  MEDIA_ISOLATION_ERROR_CODE,
  MEDIA_ISOLATION_UNAVAILABLE_MESSAGE,
  MediaIsolationError,
  shellEscape,
  signalProcessTree,
} from './media-egress';

function fakeChild(pid: number) {
  return { pid, kill: vi.fn(), stdout: null, stderr: null };
}

beforeEach(() => {
  wrapWithSandboxMock.mockReset();
  spawnMock.mockReset();
  processKillMock.mockReset();
  availabilityMock.mockReset();
  availabilityMock.mockReturnValue({ available: true, reason: null });
  wrapWithSandboxMock.mockResolvedValue('sandboxed-command');
  spawnMock.mockImplementation(() => fakeChild(4242));
  vi.spyOn(process, 'kill').mockImplementation(processKillMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guardedSpawn', () => {
  it('wraps the command through the sandbox and spawns it shell-wrapped', async () => {
    const child = await guardedSpawn('ffmpeg', ['-i', 'https://host/x'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(wrapWithSandboxMock).toHaveBeenCalledTimes(1);
    const [wrapped, , , , attribution] = wrapWithSandboxMock.mock
      .calls[0] as [string, unknown, unknown, unknown, { commandId: string }];
    expect(wrapped).toContain(`'ffmpeg'`);
    expect(wrapped).toContain(`'-i'`);
    expect(wrapped).toContain(`'https://host/x'`);
    // Per-invocation attribution id (≥128 bits) for violation reports.
    expect(attribution.commandId.length).toBeGreaterThanOrEqual(22);
    expect(child.pid).toBe(4242);
  });

  it('spawns detached as a group leader so the pump can signal the tree', async () => {
    const child = await guardedSpawn('ffmpeg', ['-version']);

    const [, options] = spawnMock.mock.calls[0] as [
      string,
      { shell: boolean; detached: boolean },
    ];
    expect(options.shell).toBe(true);
    expect(options.detached).toBe(true);
    expect(child.pid).toBe(4242);
  });

  it('throws MediaIsolationError when the sandbox is unavailable and never spawns', async () => {
    availabilityMock.mockReturnValue({
      available: false,
      reason: MEDIA_ISOLATION_UNAVAILABLE_MESSAGE,
    });

    await expect(guardedSpawn('ffmpeg', ['-version'])).rejects.toThrow(
      MediaIsolationError
    );
    try {
      await guardedSpawn('ffmpeg', ['-version']);
    } catch (error) {
      expect((error as MediaIsolationError).code).toBe(
        MEDIA_ISOLATION_ERROR_CODE
      );
    }
    expect(wrapWithSandboxMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('shellEscape', () => {
  it('single-quote wraps a plain token', () => {
    expect(shellEscape('ffmpeg')).toBe(`'ffmpeg'`);
  });

  it('neutralizes shell metacharacters in validated URLs', () => {
    expect(shellEscape('https://host/x;a=1')).toBe(`'https://host/x;a=1'`);
    expect(shellEscape('https://host/x$(evil)')).toBe(
      `'https://host/x$(evil)'`
    );
    expect(shellEscape('https://host/x`evil`')).toBe(
      `'https://host/x\`evil\`'`
    );
    expect(shellEscape('https://host/x|rm -rf|')).toBe(
      `'https://host/x|rm -rf|'`
    );
  });

  it('escapes embedded single quotes by splitting the quoting', () => {
    expect(shellEscape("it' s")).toBe(`'it'\\'' s'`);
  });
});

describe('signalProcessTree', () => {
  it('signals the negative pid (the whole process group) when possible', () => {
    const child = fakeChild(4242);

    signalProcessTree(child as never, 'SIGINT');

    expect(processKillMock).toHaveBeenCalledWith(-4242, 'SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to the direct kill when the group is already gone', () => {
    const child = fakeChild(4242);
    processKillMock.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    signalProcessTree(child as never, 'SIGKILL');

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('falls back to the direct kill for pid-less children', () => {
    const child = fakeChild(0);
    (child as { pid: number | null }).pid = null;

    signalProcessTree(child as never, 'SIGINT');

    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(processKillMock).not.toHaveBeenCalled();
  });
});
