import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { decryptToken } from '@/lib/facebook-token';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  getPumpManager,
  isFacebookIngestUrl,
} from '@/lib/live/pump';
import {
  buildIngestUrl,
  parsePumpAction,
  parseSourceMode,
  PumpStateError,
} from '@/lib/live/pump-state';
import {
  runnerMode,
  runnerRequest,
  RUNNER_UNREACHABLE_ERROR,
} from '@/lib/live/runner-config';
import { withWorkspaceLiveLock } from '@/lib/live/workspace-lock';
import { requirePublishingConnection } from '@/lib/publishing/connection';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

type PumpRow = {
  id: number;
  source_url: string | null;
  source_mode: string | null;
  secure_stream_url: string | null;
  stream_key: string | null;
  pump_started_at: string | Date | null;
};

async function findStream(workspaceId: string, id: string) {
  const rows = (await sql`
    SELECT id, source_url, source_mode, secure_stream_url, stream_key,
           pump_started_at
    FROM live_streams
    WHERE workspace_id = ${workspaceId}
      AND (facebook_video_id = ${id} OR id::text = ${id})
  `) as unknown as PumpRow[];
  return rows[0] ?? null;
}

async function startPump(workspaceId: string, stream: PumpRow) {
  if (!stream.source_url) {
    return NextResponse.json(
      { error: 'Resolve a source URL for this stream before going live.' },
      { status: 400 }
    );
  }

  // Media runner mode: the sandboxed pipeline lives in the worker. It owns
  // the stream-key decryption, the ingest allowlist, the duplicate guard and
  // every pump_status write — this route keeps only the auth/tenant checks
  // (already done by the caller) and relays the start.
  if (runnerMode()) {
    const outcome = await runnerRequest('/pump/start', {
      workspaceId,
      streamId: String(stream.id),
    });
    if (outcome.kind === 'unreachable') {
      return NextResponse.json(
        { error: RUNNER_UNREACHABLE_ERROR },
        { status: 502 }
      );
    }
    return NextResponse.json(outcome.body as object, {
      status: outcome.status,
    });
  }

  let streamKey: string | null = null;
  if (stream.stream_key) {
    try {
      streamKey = decryptToken(stream.stream_key);
    } catch {
      return NextResponse.json(
        {
          error:
            'The stored stream key could not be decrypted. Recreate the live stream to get a fresh key.',
        },
        { status: 400 }
      );
    }
  }

  let ingestUrl: string;
  try {
    ingestUrl = buildIngestUrl(stream.secure_stream_url, streamKey);
  } catch (error) {
    if (error instanceof PumpStateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // The RTMPS publisher is the only unsandboxed component (its destination
  // is Facebook's own Graph response), so its target must be a Facebook
  // ingest endpoint — verified before anything spawns.
  if (!isFacebookIngestUrl(ingestUrl)) {
    return NextResponse.json(
      {
        error:
          'The RTMPS ingest URL is not a Facebook endpoint. Recreate the live stream to get a fresh one.',
      },
      { status: 400 }
    );
  }

  const manager = getPumpManager();
  if (manager.status(stream.id).running) {
    return NextResponse.json(
      { error: 'The pump is already running for this stream.' },
      { status: 409 }
    );
  }

  const outcome = await manager.start({
    id: stream.id,
    source: stream.source_url,
    // How the pump consumes the source: 'staged' rows (DASH-only sources,
    // no playable URL) are piped through yt-dlp feeders, everything else —
    // including legacy rows predating the column — takes the ffprobe path.
    mode: parseSourceMode(stream.source_mode) ?? 'direct',
    // The local flv fifo: the sandboxed side writes it, the publisher reads
    // it. Fresh per start; the manager unlinks it on every exit path.
    outFifo: path.join(os.tmpdir(), `live-pump-out-${randomUUID()}.flv`),
    // Never logged or returned — the manager redacts it everywhere it lands.
    dest: ingestUrl,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'gate_disabled') {
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    }
    if (outcome.reason === 'isolation_unavailable') {
      return NextResponse.json({ error: outcome.error }, { status: 503 });
    }
    if (outcome.reason === 'already_running') {
      return NextResponse.json({ error: outcome.error }, { status: 409 });
    }
    // spawn_failed — the manager's error text is already key-redacted.
    await sql`
      UPDATE live_streams
      SET pump_status = 'failed', pump_error = ${outcome.error}, updated_at = now()
      WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
    `;
    return NextResponse.json({ error: outcome.error }, { status: 502 });
  }

  const updated = (await sql`
    UPDATE live_streams
    SET pump_status = 'running', pump_started_at = now(), pump_error = NULL,
        updated_at = now()
    WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
    RETURNING pump_started_at
  `) as unknown as { pump_started_at: string | Date | null }[];

  return NextResponse.json({
    pump: {
      status: 'running',
      startedAt: updated[0]?.pump_started_at ?? null,
    },
  });
}

async function stopPump(workspaceId: string, stream: PumpRow) {
  // Media runner mode: the pump lives in the worker, which owns the
  // pump_status write — this route only relays the stop.
  if (runnerMode()) {
    const outcome = await runnerRequest('/pump/stop', {
      workspaceId,
      streamId: String(stream.id),
    });
    if (outcome.kind === 'unreachable') {
      return NextResponse.json(
        { error: RUNNER_UNREACHABLE_ERROR },
        { status: 502 }
      );
    }
    return NextResponse.json(outcome.body as object, {
      status: outcome.status,
    });
  }

  // Stop the process even when the DB row is stale; stopping an idle stream
  // is a no-op success, not an error.
  getPumpManager().stop(stream.id);

  // pump_error keeps its history: a stopped pump that failed earlier still
  // shows why. The next successful start clears it.
  await sql`
    UPDATE live_streams
    SET pump_status = 'stopped', updated_at = now()
    WHERE id = ${stream.id} AND workspace_id = ${workspaceId}
  `;

  return NextResponse.json({
    pump: { status: 'stopped', startedAt: stream.pump_started_at ?? null },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await request.json().catch(() => null);
  const action = parsePumpAction(body);
  if (!action) {
    return NextResponse.json(
      { error: "Send { action: 'start' } or { action: 'stop' }." },
      { status: 400 }
    );
  }

  const { id } = await params;

  // Both lifecycle actions need the workspace lock. Stop deliberately uses
  // workspace auth only: disconnecting a Page must never prevent cleanup of a
  // pump because a Facebook token, scope, or runtime gate is unavailable.
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  try {
    return await withWorkspaceLiveLock(access.workspace.id, async () => {
      if (action === 'stop') {
        const stream = await findStream(access.workspace.id, id);
        if (!stream) {
          return NextResponse.json(
            { error: 'Live stream not found.' },
            { status: 404 }
          );
        }
        return await stopPump(access.workspace.id, stream);
      }

      // Keep the publishing check inside the lifecycle lock. If disconnect
      // wins the lock first, it deletes the connection before start can spawn.
      const result = await requirePublishingConnection(
        request,
        'control the live pump'
      );
      if (result.response) return result.response;

      const stream = await findStream(access.workspace.id, id);
      if (!stream) {
        return NextResponse.json(
          { error: 'Live stream not found.' },
          { status: 404 }
        );
      }
      return await startPump(access.workspace.id, stream);
    });
  } catch {
    // Unexpected DB failure — a plain 500 with no internals leaking.
    return NextResponse.json(
      { error: 'The live pump could not be updated. Try again.' },
      { status: 500 }
    );
  }
}
