import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { neon } from '@neondatabase/serverless';
import { decryptToken } from './lib/facebook-token';
import {
  getPumpManager,
  isFacebookIngestUrl,
  type PumpManager,
} from './lib/live/pump';
import {
  buildIngestUrl,
  parseSourceMode,
  PumpStateError,
} from './lib/live/pump-state';
import {
  ensureMediaSandbox,
  mediaSandboxAvailability,
} from './lib/live/media-sandbox';
import {
  ResolveError,
  resolveVideoUrl,
  type ResolvedVideo,
} from './lib/live/resolve';
import {
  NetworkPolicyError,
  validateSourceUrl,
} from './lib/live/public-network';
import { localRuntimeEnabled } from './lib/reels/media';
import { runnerToken } from './lib/live/runner-config';
import { withWorkspaceLiveLock } from './lib/live/workspace-lock';

// Media runner: the standalone worker that owns the sandboxed native-media
// work when the web runtime cannot run the sandbox (Render). The web app
// proxies resolve and pump control here over HTTPS with a shared bearer
// token; this process runs yt-dlp/ffprobe/ffmpeg inside the verified
// isolation sandbox and owns every live_streams.pump_status write.
//
// Run with: npx tsx --env-file=.env.local media-runner.ts
// Deployed on Fly.io via Dockerfile.worker + fly.worker.toml.

/**
 * The slice of the Neon HTTP client the worker needs — the tagged-template
 * query call only. Kept structural so tests pass a plain fake.
 */
export type RunnerSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export type RunnerDeps = {
  sql: RunnerSql;
  manager: PumpManager;
  resolveVideo: (url: string) => Promise<ResolvedVideo>;
};

/** One JSON log line per event — the download-worker/scheduler convention. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ area: 'media-runner', ...fields }));
}

type StreamRow = {
  id: number;
  source_url: string | null;
  source_mode: string | null;
  secure_stream_url: string | null;
  stream_key: string | null;
  pump_started_at: string | Date | null;
};

async function findStream(
  sql: RunnerSql,
  workspaceId: string,
  id: string
): Promise<StreamRow | null> {
  const rows = (await sql`
    SELECT id, source_url, source_mode, secure_stream_url, stream_key,
           pump_started_at
    FROM live_streams
    WHERE workspace_id = ${workspaceId}
      AND (facebook_video_id = ${id} OR id::text = ${id})
  `) as unknown as StreamRow[];
  return rows[0] ?? null;
}

/** readText parity with lib/publishing/request: string → trim → cap. */
function readText(value: unknown, max = 5000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

type HttpResponse = { status: number; body: unknown };

/**
 * The auth gate. Fail closed both ways: a worker without a configured token
 * refuses EVERYTHING with 503 (a misconfigured worker must never serve
 * unauthenticated), and a request without the exact bearer gets 401.
 */
function authorize(
  request: IncomingMessage
): { ok: true } | { ok: false; response: HttpResponse } {
  const token = runnerToken();
  if (!token) {
    return {
      ok: false,
      response: {
        status: 503,
        body: {
          error: 'The media runner has no access token configured. Set MEDIA_RUNNER_TOKEN.',
        },
      },
    };
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    return { ok: false, response: { status: 401, body: { error: 'unauthorized' } } };
  }
  return { ok: true };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) return null; // Oversized body → treat as absent.
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    return null;
  }
}

/** What the worker knows about a pump it started, keyed by stream id. */
type TrackedPump = {
  workspaceId: string;
  /** True once the DB row has been confirmed `running` for this pump. */
  dbRunning: boolean;
  /** Ownership is reserved before asynchronous native setup starts. */
  starting?: boolean;
  /** A terminal update still owed even if native setup removed its process. */
  pendingTerminal?: { error: string | null };
};

const RECONCILE_INTERVAL_MS = 3_000;
const SHUTDOWN_ERROR =
  'The media runner is shutting down. Start the pump again.';
const ORPHAN_ERROR =
  'The media runner restarted while this pump was running. Start it again.';

/**
 * Marks rows the DB claims are running but this process has no record of —
 * called at boot (the registry is empty, so every `running` row is an orphan
 * of a restart) and by the reconciler's terminal states.
 */
async function markPumpsFailed(
  sql: RunnerSql,
  ids: readonly (number | string)[],
  workspaceIds: readonly (string | null)[],
  error: string
): Promise<void> {
  for (let index = 0; index < ids.length; index += 1) {
    const workspaceId = workspaceIds[index];
    const id = String(ids[index]);
    if (workspaceId) {
      await sql`
        UPDATE live_streams
        SET pump_status = 'failed', pump_error = ${error}, updated_at = now()
        WHERE id::text = ${id} AND workspace_id = ${workspaceId}
      `;
    } else {
      await sql`
        UPDATE live_streams
        SET pump_status = 'failed', pump_error = ${error}, updated_at = now()
        WHERE id::text = ${id}
      `;
    }
  }
}

/**
 * Boot reconciliation: every row the DB says is running was orphaned by a
 * restart (the registry starts empty). Writes the `failed` state the UI maps
 * to a one-click restart instead of a phantom "running" card.
 */
export async function reconcileOrphanedPumps(sql: RunnerSql): Promise<number> {
  const rows = (await sql`
    SELECT id FROM live_streams WHERE pump_status = 'running'
  `) as unknown as { id: number }[];
  await markPumpsFailed(
    sql,
    rows.map((row) => row.id),
    rows.map(() => null),
    ORPHAN_ERROR
  );
  if (rows.length > 0) log({ event: 'boot_reconciled', count: rows.length });
  return rows.length;
}

/**
 * The runner HTTP server. Tests drive this against an ephemeral port with
 * injected deps; main() wires the real ones.
 */
export function createRunnerServer(deps: RunnerDeps) {
  /** Stream id → workspace: the pumps this process is responsible for. */
  const registry = new Map<string, TrackedPump>();
  let shuttingDown = false;
  let reconciling = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;

  // Reuse the live lifecycle mutex with a runner-specific, per-stream key.
  // Native setup stays outside it so stop can cancel an in-flight start.
  function withStreamState<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    return withWorkspaceLiveLock(`media-runner:${id}`, operation);
  }

  /**
   * Keeps the DB honest for the pumps this process owns: a terminal settle
   * (crash, retries exhausted, clean exit) becomes a pump_status write here
   * within one interval — the web trusts the DB column, so nobody else will
   * notice the process died. A `retrying` backoff is NOT terminal.
   */
  async function reconcileOnce(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const [id, tracked] of registry) {
        if (tracked.starting) continue;
        try {
          await withStreamState(id, async () => {
            if (shuttingDown || registry.get(id) !== tracked || tracked.starting) return;
            const status = deps.manager.status(id);
            if (!tracked.pendingTerminal && (status.running || status.retrying)) {
              // Still live (or inside a retry backoff — not terminal). If the
              // start path never confirmed the DB write (e.g. a network hiccup
              // right after a successful spawn), self-heal it once.
              if (!tracked.dbRunning) {
                await deps.sql`
                  UPDATE live_streams
                  SET pump_status = 'running',
                      pump_started_at = COALESCE(pump_started_at, now()),
                      pump_error = NULL, updated_at = now()
                  WHERE id::text = ${id} AND workspace_id = ${tracked.workspaceId}
                `;
                tracked.dbRunning = true;
                log({ event: 'reconciled_running', streamId: id });
              }
              return;
            }
            const terminalError = tracked.pendingTerminal ? tracked.pendingTerminal.error : status.error;
            if (terminalError) {
              await markPumpsFailed(deps.sql, [id], [tracked.workspaceId], terminalError);
              log({ event: 'reconciled_failed', streamId: id });
            } else {
              await deps.sql`
                UPDATE live_streams
                SET pump_status = 'stopped', updated_at = now()
                WHERE id::text = ${id} AND workspace_id = ${tracked.workspaceId}
              `;
              log({ event: 'reconciled_stopped', streamId: id });
            }
            // Keep terminal pumps tracked until their DB update succeeds, so a
            // transient database outage is retried on the next sweep. A restart
            // while the write was in flight may have installed a new entry.
            if (registry.get(id) === tracked) registry.delete(id);
          });
        } catch (error) {
          log({
            event: 'reconcile_error',
            streamId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      reconciling = false;
    }
  }

  async function handleStart(request: IncomingMessage): Promise<HttpResponse> {
    if (shuttingDown) return { status: 503, body: { error: SHUTDOWN_ERROR } };
    const body = (await readJson(request)) as {
      workspaceId?: unknown;
      streamId?: unknown;
    } | null;
    const workspaceId = readText(body?.workspaceId, 100);
    const streamId = readText(body?.streamId, 200);
    if (!workspaceId || !streamId) {
      return { status: 400, body: { error: 'Send { workspaceId, streamId }.' } };
    }

    const stream = await findStream(deps.sql, workspaceId, streamId);
    if (!stream) {
      return { status: 404, body: { error: 'Live stream not found.' } };
    }
    if (!stream.source_url) {
      return {
        status: 400,
        body: {
          error: 'Resolve a source URL for this stream before going live.',
        },
      };
    }

    // The worker owns the stream-key decryption (BETTER_AUTH_SECRET lives
    // here too) so the key never crosses the web→worker boundary.
    let streamKey: string | null = null;
    if (stream.stream_key) {
      try {
        streamKey = decryptToken(stream.stream_key);
      } catch {
        return {
          status: 400,
          body: {
            error:
              'The stored stream key could not be decrypted. Recreate the live stream to get a fresh key.',
          },
        };
      }
    }

    let ingestUrl: string;
    try {
      ingestUrl = buildIngestUrl(stream.secure_stream_url, streamKey);
    } catch (error) {
      if (error instanceof PumpStateError) {
        return { status: 400, body: { error: error.message } };
      }
      throw error;
    }

    // The RTMPS publisher is the only unsandboxed component (its destination
    // is Facebook's own Graph response), so its target must be a Facebook
    // ingest endpoint — verified before anything spawns.
    if (!isFacebookIngestUrl(ingestUrl)) {
      return {
        status: 400,
        body: {
          error:
            'The RTMPS ingest URL is not a Facebook endpoint. Recreate the live stream to get a fresh one.',
        },
      };
    }

    const manager = deps.manager;
    const id = String(stream.id);
    const reservation = await withStreamState(id, () => {
      if (shuttingDown) return { status: 503, body: { error: SHUTDOWN_ERROR } };
      const status = manager.status(stream.id);
      if (registry.get(id)?.starting || status.running || status.retrying) {
        return { status: 409, body: { error: 'The pump is already running for this stream.' } };
      }
      const tracked: TrackedPump = { workspaceId, dbRunning: false, starting: true };
      const previous = registry.get(id);
      if (previous) tracked.pendingTerminal = previous.pendingTerminal ?? { error: status.error };
      registry.set(id, tracked);
      return tracked;
    });
    if ('status' in reservation) return reservation;
    const tracked = reservation;
    // The lock releases before this continuation resumes. A stop or shutdown
    // may already have cancelled ownership without a native process to stop.
    if (shuttingDown) return { status: 503, body: { error: SHUTDOWN_ERROR } };
    if (registry.get(id) !== tracked) return { status: 409, body: { error: 'The pump start was cancelled.' } };
    let outcome;
    try {
      outcome = await manager.start({
        id: stream.id,
        source: stream.source_url,
        // 'staged' rows (DASH-only sources, no playable URL) are piped through
        // yt-dlp feeders; everything else takes the ffprobe path.
        mode: parseSourceMode(stream.source_mode) ?? 'direct',
        // Never logged or returned — the manager redacts it everywhere it lands.
        dest: ingestUrl,
      });
    } catch (error) {
      await withStreamState(id, () => {
        if (registry.get(id) === tracked) {
          tracked.starting = false;
          tracked.pendingTerminal ??= { error: 'The media runner could not start this pump.' };
        }
      });
      throw error;
    }
    return withStreamState(id, async () => {
      tracked.starting = false;
      if (shuttingDown) return { status: 503, body: { error: SHUTDOWN_ERROR } };
      if (registry.get(id) !== tracked) {
        return { status: 409, body: { error: 'The pump start was cancelled.' } };
      }
      if (!outcome.ok) {
        // Keep any older unsaved terminal state for gate failures; a setup
        // failure replaces it with this attempt's error until SQL succeeds.
        if (outcome.reason === 'spawn_failed') tracked.pendingTerminal = { error: outcome.error };
        if (!tracked.pendingTerminal) registry.delete(id);
        if (outcome.reason === 'gate_disabled') {
          return { status: 400, body: { error: outcome.error } };
        }
        if (outcome.reason === 'isolation_unavailable') {
          return { status: 503, body: { error: outcome.error } };
        }
        if (outcome.reason === 'already_running') {
          return { status: 409, body: { error: outcome.error } };
        }
        // spawn_failed — the manager's error text is already key-redacted.
        await deps.sql`
          UPDATE live_streams
          SET pump_status = 'failed', pump_error = ${outcome.error}, updated_at = now()
          WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
        `;
        if (registry.get(id) === tracked) registry.delete(id);
        return { status: 502, body: { error: outcome.error } };
      }

      delete tracked.pendingTerminal;
      const updated = (await deps.sql`
        UPDATE live_streams
        SET pump_status = 'running', pump_started_at = now(), pump_error = NULL,
            updated_at = now()
        WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
        RETURNING pump_started_at
      `) as unknown as { pump_started_at: string | Date | null }[];

      // The start write landed — the reconciler only backfills it if it hadn't.
      if (registry.get(id) === tracked) tracked.dbRunning = true;

      log({ event: 'pump_started', streamId: stream.id, workspaceId });
      return {
        status: 200,
        body: {
          pump: {
            status: 'running',
            startedAt: updated[0]?.pump_started_at ?? null,
          },
        },
      };
    });
  }

  async function handleStop(request: IncomingMessage): Promise<HttpResponse> {
    const body = (await readJson(request)) as {
      workspaceId?: unknown;
      streamId?: unknown;
    } | null;
    const workspaceId = readText(body?.workspaceId, 100);
    if (!workspaceId) {
      return { status: 400, body: { error: 'Send { workspaceId, streamId? }.' } };
    }
    const streamId = readText(body?.streamId, 200);

    if (streamId) {
      const stream = await findStream(deps.sql, workspaceId, streamId);
      if (!stream) {
        return { status: 404, body: { error: 'Live stream not found.' } };
      }
      // Stop the process even when the DB row is stale; stopping an idle
      // stream is a no-op success, not an error.
      deps.manager.stop(stream.id);
      registry.delete(String(stream.id));
      await withStreamState(String(stream.id), () => deps.sql`
        UPDATE live_streams
        SET pump_status = 'stopped', updated_at = now()
        WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
      `);
      log({ event: 'pump_stopped', streamId: stream.id, workspaceId });
      return {
        status: 200,
        body: {
          pump: { status: 'stopped', startedAt: stream.pump_started_at ?? null },
        },
      };
    }

    // No stream id: stop every pump this worker started for the workspace
    // (the disconnect flow's stop-all). The web layer owns the blanket DB
    // update for the tenant's other, already-terminal rows.
    const own = [...registry.entries()].filter(
      ([, tracked]) => tracked.workspaceId === workspaceId
    );
    for (const [id] of own) {
      deps.manager.stop(id);
      registry.delete(id);
    }
    for (const [id] of own) {
      await withStreamState(id, () => deps.sql`
        UPDATE live_streams
        SET pump_status = 'stopped', updated_at = now()
        WHERE id::text = ${id} AND workspace_id = ${workspaceId}
      `);
    }
    log({ event: 'pump_stopped_all', workspaceId, count: own.length });
    return { status: 200, body: { pump: { status: 'stopped', startedAt: null } } };
  }

  async function handleResolve(request: IncomingMessage): Promise<HttpResponse> {
    const body = (await readJson(request)) as { url?: unknown } | null;
    const url = readText(body?.url, 2048);
    if (!url) {
      return { status: 400, body: { error: 'Paste a video link to preview.' } };
    }

    try {
      // Same order as the web route: policy checks run before yt-dlp can
      // ever see the input; DNS-based public checks happen in the resolver.
      const validated = validateSourceUrl(url);
      const video = await deps.resolveVideo(validated);
      return { status: 200, body: video };
    } catch (error) {
      if (error instanceof NetworkPolicyError) {
        return {
          status: 400,
          body: { error: error.message, code: 'invalid_url' },
        };
      }
      if (error instanceof ResolveError) {
        return {
          status: error.code === 'invalid_url' ? 400 : 502,
          body: { error: error.message, code: error.code },
        };
      }
      return {
        status: 502,
        body: { error: 'The video link could not be resolved.' },
      };
    }
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://runner.internal');
    const path = url.pathname;

    // Liveness for the platform and the web side: no secrets in the payload,
    // so it stays token-free and simple to check.
    if (path === '/healthz' && request.method === 'GET') {
      const sandbox = mediaSandboxAvailability();
      json(response, 200, {
        ok: true,
        sandbox: sandbox.available ? 'ready' : 'unavailable',
      });
      return;
    }

    const gate = authorize(request);
    if (!gate.ok) {
      json(response, gate.response.status, gate.response.body);
      return;
    }

    let outcome: HttpResponse;
    try {
      if (path === '/resolve' && request.method === 'POST') {
        outcome = await handleResolve(request);
      } else if (path === '/pump/start' && request.method === 'POST') {
        outcome = await handleStart(request);
      } else if (path === '/pump/stop' && request.method === 'POST') {
        outcome = await handleStop(request);
      } else if (
        (path === '/resolve' ||
          path === '/pump/start' ||
          path === '/pump/stop') &&
        request.method !== 'POST'
      ) {
        outcome = { status: 405, body: { error: 'Method not allowed.' } };
      } else {
        outcome = { status: 404, body: { error: 'Not found.' } };
      }
    } catch (error) {
      log({
        event: 'handler_error',
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = {
        status: 500,
        body: { error: 'The media runner could not process that request.' },
      };
    }
    json(response, outcome.status, outcome.body);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      log({
        event: 'handle_threw',
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        json(response, 500, { error: 'The media runner could not process that request.' });
      } else {
        response.end();
      }
    });
  });

  return {
    server,
    registry,
    reconcileOnce,
    startReconciler(intervalMs: number = RECONCILE_INTERVAL_MS): void {
      if (reconcileTimer) return;
      reconcileTimer = setInterval(() => {
        void reconcileOnce();
      }, intervalMs);
      reconcileTimer.unref?.();
    },
    stopReconciler(): void {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
    },
    /** Terminal write for every pump this process owns (shutdown path). */
    async markOwnPumpsFailed(error: string): Promise<void> {
      shuttingDown = true;
      const ids = [...registry.keys()];
      // Stop detached media groups before any network I/O: the Mac's stop
      // script may terminate this server while the database is unavailable.
      for (const id of ids) deps.manager.stop(id, { force: true });
      const outcomes = await Promise.allSettled(ids.map((id) =>
        withStreamState(id, async () => {
          const tracked = registry.get(id);
          if (!tracked) return;
          await markPumpsFailed(deps.sql, [id], [tracked.workspaceId], error);
          if (registry.get(id) === tracked) registry.delete(id);
        })
      ));
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
    listen(port: number): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => resolve());
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export type RunnerServer = ReturnType<typeof createRunnerServer>;

function json(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body ?? null));
}

const MEDIA_RUNNER_ENV = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'MEDIA_RUNNER_TOKEN',
] as const;

async function main(): Promise<void> {
  const missing = MEDIA_RUNNER_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    console.error(
      `Missing required env: ${missing.join(', ')}. Run with: npx tsx --env-file=.env.local media-runner.ts`
    );
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL!) as RunnerSql;
  const runner = createRunnerServer({
    sql,
    manager: getPumpManager(),
    resolveVideo: resolveVideoUrl,
  });

  // The sandbox bootstraps first and independently: it is what makes the
  // native tools safe, and a failure here must be visible immediately — the
  // worker still serves (fail-closed endpoints) with sandbox: 'unavailable'.
  await ensureMediaSandbox();
  const sandbox = mediaSandboxAvailability();
  log({ event: 'sandbox', available: sandbox.available, reason: sandbox.available ? null : sandbox.reason });

  if (!localRuntimeEnabled()) {
    log({
      event: 'gate_warning',
      detail:
        'ENABLE_LOCAL_VIDEO_PROCESSING is not 1 — pump starts will fail the runtime gate.',
    });
  }

  await reconcileOrphanedPumps(sql);

  const port = Number(process.env.PORT || 8080);
  await runner.listen(port);
  log({ event: 'listening', port, sandbox: sandbox.available ? 'ready' : 'unavailable' });
  runner.startReconciler();

  const shutdown = async (signal: string) => {
    log({ event: 'shutdown', signal, active: runner.registry.size });
    runner.stopReconciler();
    try {
      await runner.markOwnPumpsFailed(SHUTDOWN_ERROR);
    } catch (error) {
      log({
        event: 'shutdown_write_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await runner.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

// Run directly (tsx media-runner.ts) → boot; imported by tests → no side effects.
const invokedDirectly = process.argv[1]?.endsWith('media-runner.ts');
if (invokedDirectly) {
  void main();
}
