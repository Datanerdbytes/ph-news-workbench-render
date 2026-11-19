import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { mediaSandboxAvailability } from './media-sandbox';

/**
 * Server-side entrypoint for native media processes. Every spawn goes through
 * the verified sandbox: the command is wrapped by SandboxManager so the whole
 * process tree is confined (OS-level enforcement) and its complete network
 * egress is forced through the sandbox's filtering proxies — public unicast
 * only, no direct sockets, no rebinding path.
 *
 * This is the seam the quarantine opens: when the sandbox is unavailable the
 * MediaIsolationError propagates and callers fail closed (503
 * media_isolation_unavailable) instead of running unconstrained tools.
 */

export const MEDIA_ISOLATION_ERROR_CODE = 'media_isolation_unavailable' as const;

export const MEDIA_ISOLATION_UNAVAILABLE_MESSAGE =
  'Native media processing is temporarily unavailable because its network isolation is not configured and verified on this runtime.';

export class MediaIsolationError extends Error {
  readonly code = MEDIA_ISOLATION_ERROR_CODE;

  constructor(message = MEDIA_ISOLATION_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'MediaIsolationError';
  }
}

/**
 * Single-quote shell escaping for POSIX `sh -c`. Every token of a sandboxed
 * command is escaped before composing the wrapped command line, so shell
 * metacharacters in a validated URL (`; | & $ ` < >`) stay inert data.
 */
export function shellEscape(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * Signals one child's WHOLE process tree. Sandboxed children are
 * `sh -c`-wrapped and detached as their own group leaders (a shell does not
 * forward signals to its grandchildren); the unsandboxed publisher is also
 * spawned detached, so the negative-pid kill reaches every process uniformly.
 */
export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone — fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already dead — nothing to do.
  }
}

/**
 * Spawns one native media process inside the verified sandbox. Resolves with
 * the child (the shell wrapper — signal it via `signalProcessTree`) or throws
 * MediaIsolationError when the sandbox is unavailable on this runtime.
 *
 * The child is spawned detached as its own process-group leader so the pump
 * can signal the wrapper and every descendant with one negative-pid kill.
 */
export async function guardedSpawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptions
): Promise<ChildProcess> {
  const availability = mediaSandboxAvailability();
  if (!availability.available) {
    throw new MediaIsolationError(availability.reason);
  }

  const escaped = [command, ...args].map(shellEscape).join(' ');
  const wrapped = await SandboxManager.wrapWithSandbox(
    escaped,
    undefined,
    undefined,
    undefined,
    // Opaque per-invocation attribution key for sandbox violation reports.
    { commandId: randomUUID() }
  );

  return spawn(wrapped, {
    shell: true,
    detached: true,
    ...options,
  });
}
