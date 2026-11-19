type LockEntry = {
  tail: Promise<void>;
  pending: number;
};

type WorkspaceLockGlobal = typeof globalThis & {
  __phLiveWorkspaceLocks?: Map<string, LockEntry>;
};

const holder = globalThis as WorkspaceLockGlobal;
const workspaceLocks = (holder.__phLiveWorkspaceLocks ??= new Map());

/**
 * Serializes live lifecycle changes for a workspace in this Node process.
 * Deployments with multiple server processes/instances need a distributed or
 * database-backed lock; this map cannot coordinate across processes.
 */
export async function withWorkspaceLiveLock<T>(
  workspaceId: string,
  operation: () => Promise<T> | T
): Promise<T> {
  let entry = workspaceLocks.get(workspaceId);
  if (!entry) {
    entry = { tail: Promise.resolve(), pending: 0 };
    workspaceLocks.set(workspaceId, entry);
  }

  const previous = entry.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.tail = previous.then(() => turn);
  entry.pending += 1;

  await previous;
  try {
    return await operation();
  } finally {
    release();
    entry.pending -= 1;
    if (entry.pending === 0 && workspaceLocks.get(workspaceId) === entry) {
      workspaceLocks.delete(workspaceId);
    }
  }
}
