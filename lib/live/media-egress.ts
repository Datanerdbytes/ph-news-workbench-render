import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Native yt-dlp/ffprobe/ffmpeg processes are not safe to run from the web
 * process until they are launched by a runner that enforces their complete
 * network egress policy. URL validation alone cannot constrain nested requests
 * made by extractors, HLS demuxers, retries, or child processes (a master
 * playlist can point ffmpeg's transport layer at arbitrary hosts regardless
 * of any pre-flight URL check).
 *
 * This intentionally fails closed. There is no environment-variable escape
 * hatch: an operator must replace this boundary with a verified runner (for
 * example, a separately isolated source worker plus a trusted RTMPS publisher)
 * before native media execution is enabled.
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
 * Assert that native media execution is confined at the socket boundary.
 *
 * Quarantine implementation: no supported runtime currently supplies the
 * required end-to-end source isolation and trusted RTMPS egress split, so all
 * native execution is refused. Keep this call immediately before every native
 * child-process launch when replacing the quarantine with a real runner.
 */
export function assertMediaIsolationAvailable(): void {
  throw new MediaIsolationError();
}

/**
 * The only child-process entrypoint available to native media code. The
 * assertion is deliberately synchronous and runs in the same call stack as
 * spawn — including retries, fallback candidates, and nested launch paths —
 * so a quarantine can never be bypassed by skipping the public entrypoints.
 */
export function guardedSpawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptions
): ChildProcess {
  assertMediaIsolationAvailable();
  return spawn(command, [...args], options ?? {});
}
