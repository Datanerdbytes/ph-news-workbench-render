import { afterEach, describe, expect, it, vi } from 'vitest';

import { withWorkspaceLiveLock } from './workspace-lock';

const lockState = globalThis as typeof globalThis & {
  __phLiveWorkspaceLocks?: Map<string, { tail: Promise<void>; pending: number }>;
};

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
  throw new Error('Timed out waiting for lock acquisition.');
}

afterEach(() => {
  lockState.__phLiveWorkspaceLocks?.clear();
});

describe('withWorkspaceLiveLock', () => {
  it('serializes operations in one workspace and releases idle keys', async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const first = withWorkspaceLiveLock('ws-lock-test', async () => {
      events.push('first:begin');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = withWorkspaceLiveLock('ws-lock-test', async () => {
      events.push('second');
    });

    await waitUntil(() => events.includes('first:begin'));
    expect(events).toEqual(['first:begin']);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:begin', 'first:end', 'second']);
    expect(lockState.__phLiveWorkspaceLocks?.has('ws-lock-test')).toBe(false);
  });

  it('does not serialize different workspaces', async () => {
    const gate = deferred();
    const events: string[] = [];
    const first = withWorkspaceLiveLock('ws-lock-a', async () => {
      events.push('a:begin');
      await gate.promise;
    });
    const second = withWorkspaceLiveLock('ws-lock-b', async () => {
      events.push('b');
    });

    await waitUntil(() => events.includes('b'));
    expect(events).toEqual(['a:begin', 'b']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(lockState.__phLiveWorkspaceLocks?.size).toBe(0);
  });

  it('releases the lock and removes its key when an operation throws', async () => {
    await expect(
      withWorkspaceLiveLock('ws-lock-error', async () => {
        throw new Error('expected');
      })
    ).rejects.toThrow('expected');

    expect(lockState.__phLiveWorkspaceLocks?.has('ws-lock-error')).toBe(false);
    await expect(withWorkspaceLiveLock('ws-lock-error', () => 'recovered')).resolves.toBe('recovered');
  });
});
