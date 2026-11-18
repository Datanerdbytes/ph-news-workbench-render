import { assembleRtmpsUrl } from '@/lib/live/pump';

/**
 * Pure helpers shared by the pump API route and the /api/live read path.
 * Nothing here touches the database or spawns processes, so every function
 * is unit-testable without mocks.
 */

export type PumpStatusValue =
  | 'idle'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'interrupted';

export type PumpStateErrorCode = 'missing_ingest_base' | 'missing_stream_key';

/**
 * Thrown by `buildIngestUrl` when the stored row is missing one of the two
 * pieces of the ingest URL. Messages are route-friendly by construction and
 * never quote the stream key.
 */
export class PumpStateError extends Error {
  readonly code: PumpStateErrorCode;

  constructor(code: PumpStateErrorCode, message: string) {
    super(message);
    this.name = 'PumpStateError';
    this.code = code;
  }
}

/**
 * Reassembles the RTMPS ingest URL the pump copies into: the stored
 * `secure_stream_url` base (with or without a trailing slash) plus the
 * decrypted stream key. Throws a typed `PumpStateError` instead of returning
 * null so the route can only ever start a pump with a complete destination.
 */
export function buildIngestUrl(
  base: string | null,
  key: string | null
): string {
  if (!base) {
    throw new PumpStateError(
      'missing_ingest_base',
      'This stream has no RTMPS ingest URL stored. Refresh the stream from Facebook and try again.'
    );
  }
  if (!key) {
    throw new PumpStateError(
      'missing_stream_key',
      'This stream has no stream key stored. Recreate the live stream to get a fresh one.'
    );
  }
  const url = assembleRtmpsUrl(base, key);
  if (!url) {
    // Defensive: assembleRtmpsUrl only returns null for the two guarded cases.
    throw new PumpStateError(
      'missing_stream_key',
      'The RTMPS ingest URL could not be assembled.'
    );
  }
  return url;
}

/** What the route layer knows about a pump process, per stream id. */
export type PumpProcessState = {
  running: boolean;
  error?: string | null;
};

/**
 * Maps the stored `pump_status` column and the in-memory pump manager state
 * onto the value the UI shows:
 *
 * - DB `running` + process alive → `running`
 * - DB `running` + no process record (undefined — e.g. after a server
 *   restart) → `interrupted`
 * - DB `running` + process recorded as exited → the manager's terminal state
 *   (`stopped` when it exited without an error, `failed` with one)
 * - anything else passes through unchanged
 *
 * Known caveat inherited from the manager's status API: during a retry
 * backoff window the process reports `running: false`, so a DB row marked
 * `running` briefly maps to `stopped`/`failed` until the retry respawns.
 */
export function mapPumpStatus(
  row: { pumpStatus: string },
  process: PumpProcessState | undefined
): PumpStatusValue {
  if (row.pumpStatus !== 'running') {
    // idle / stopped / failed / anything else passes through.
    return row.pumpStatus as PumpStatusValue;
  }
  if (!process) return 'interrupted';
  if (process.running) return 'running';
  return process.error ? 'failed' : 'stopped';
}

/** Subset of `PumpManager.status()` the mapping needs, kept structural. */
export type PumpManagerStatus = {
  running: boolean;
  startedAt: Date | null;
  error: string | null;
};

/**
 * Adapts a `PumpManager.status()` result for `mapPumpStatus`. The manager
 * reports `startedAt: null` only when it holds no record for the id (e.g.
 * after a server restart, or a stream never pumped in this process), which
 * must surface as `interrupted` rather than `stopped`.
 */
export function pumpProcessRecord(
  status: PumpManagerStatus
): PumpProcessState | undefined {
  if (!status.startedAt) return undefined;
  return { running: status.running, error: status.error };
}

/**
 * Validates the pump route's `{ action }` body. Returns null for anything
 * that is not exactly `'start'` or `'stop'` — the caller renders a 400.
 */
export function parsePumpAction(body: unknown): 'start' | 'stop' | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const action = (body as { action?: unknown }).action;
  if (action === 'start' || action === 'stop') return action;
  return null;
}
