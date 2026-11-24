import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getPumpManager } from '@/lib/live/pump';
import { runnerMode, runnerRequest } from '@/lib/live/runner-config';
import { withWorkspaceLiveLock } from '@/lib/live/workspace-lock';
import { requirePublishingConnection } from '@/lib/publishing/connection';
import { requireWorkspace, unauthorized } from '@/lib/session';
import { facebookErrorResponse } from '@/lib/publishing/errors';
import {
  endPageLiveVideo,
  isAlreadyEndedGraphError,
  resolveEndVideoId,
  updatePageLiveVideo,
} from '@/lib/publishing/live';
import { readText } from '@/lib/publishing/request';
import { parseScheduledPublishTime } from '@/lib/publishing/schedule';

export const dynamic = 'force-dynamic';

// User-facing text when ending fails; the raw Graph detail goes to the
// server log instead (see the DELETE catch below).
const END_FAILED_MESSAGE =
  'The live stream could not be ended. Try again — if it still fails, reconnect the Page or create the stream again.';

type StreamRow = {
  id: number;
  facebook_video_id: string;
};

async function findStream(workspaceId: string, id: string) {
  const rows = (await sql`
    SELECT id, facebook_video_id
    FROM live_streams
    WHERE workspace_id = ${workspaceId}
      AND (facebook_video_id = ${id} OR id::text = ${id})
  `) as unknown as StreamRow[];
  return rows[0] ?? null;
}

// Stop the pump and persist ENDED. Shared by the normal end path and the
// "broadcast already gone from Facebook" path — in both cases the local row
// must stop reporting a stream that is no longer running.
async function endLocalStream(workspaceId: string, streamId: number) {
  // Media runner mode: the pump lives in the worker — relay the stop
  // (best-effort; the worker's reconcile loop will surface reality on the
  // next tick either way).
  if (runnerMode()) {
    await runnerRequest('/pump/stop', {
      workspaceId,
      streamId: String(streamId),
    });
  } else {
    getPumpManager().stop(streamId);
  }
  await sql`
    UPDATE live_streams
    SET status = 'ENDED', pump_status = 'stopped', updated_at = now()
    WHERE id = ${streamId} AND workspace_id = ${workspaceId}
  `;
  return NextResponse.json({ ended: true });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const result = await requirePublishingConnection(request, 'update a live stream');
  if (result.response) return result.response;

  const { access, connection } = result.context;
  const { id } = await params;
  const stream = await findStream(access.workspace.id, id);
  if (!stream) {
    return NextResponse.json({ error: 'Live stream not found.' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const title = readText(body?.title, 200);
  if (!title) {
    return NextResponse.json(
      { error: 'Give the live stream a title.' },
      { status: 400 }
    );
  }
  const description = readText(body?.description, 5000);
  const schedule = parseScheduledPublishTime(body?.scheduledFor);
  if (schedule.error) {
    return NextResponse.json({ error: schedule.error }, { status: 400 });
  }

  try {
    const live = await updatePageLiveVideo({
      liveVideoId: stream.facebook_video_id,
      accessToken: connection.accessToken,
      title,
      description,
      plannedStartTime: schedule.unix,
    });

    await sql`
      UPDATE live_streams
      SET title = ${title}, description = ${description},
          status = ${live.status}, planned_start_time = ${live.plannedStartTime},
          permalink_url = ${live.permalink}, updated_at = now()
      WHERE id = ${stream.id} AND workspace_id = ${access.workspace.id}
    `;

    return NextResponse.json({ stream: live });
  } catch (error) {
    return facebookErrorResponse(
      error,
      'live_update_failed',
      'The live stream could not be updated.'
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const { id } = await params;

  try {
    return await withWorkspaceLiveLock(access.workspace.id, async () => {
      const result = await requirePublishingConnection(request, 'end a live stream');
      if (result.response) return result.response;
      const { connection } = result.context;

      const stream = await findStream(access.workspace.id, id);
      if (!stream) {
        return NextResponse.json({ error: 'Live stream not found.' }, { status: 404 });
      }

      try {
        // The end call must target the live video node id — not a value
        // Graph cannot resolve to a broadcast (the observed failure quoted
        // the stream key, e.g. "Object with ID '122152546167117522' does not
        // exist"). Re-read the node from Facebook when the stored id is
        // missing or no longer loads; with no usable id there is nothing
        // safe to POST to, so say so and let the user recreate the stream.
        const endVideoId = await resolveEndVideoId({
          liveVideoId: stream.facebook_video_id,
          accessToken: connection.accessToken,
        });
        // If Facebook no longer recognizes the node as a broadcast (the observed
        // failure quoted the stream key, e.g. "Object with ID '...' does not
        // exist"), there is nothing left to end on Facebook — clean up locally
        // instead of surfacing a failure the user cannot act on.
        if (!endVideoId) {
          return await endLocalStream(access.workspace.id, stream.id);
        }

        // End Facebook first; a failed end request must leave the pump and
        // controls available for another attempt.
        try {
          await endPageLiveVideo({
            liveVideoId: endVideoId,
            accessToken: connection.accessToken,
          });
        } catch (error) {
          // The broadcast is already gone from Facebook — the node no longer
          // exists — so there is nothing left to end. Clean up locally
          // instead of surfacing a failure the person cannot act on.
          if (isAlreadyEndedGraphError(error)) {
            return await endLocalStream(access.workspace.id, stream.id);
          }
          throw error;
        }

        return await endLocalStream(access.workspace.id, stream.id);
      } catch (error) {
        // The raw Graph detail stays in the server log; the toast gets a
        // line the person can act on.
        console.error(
          JSON.stringify({
            route: 'live/[id]',
            event: 'live_end_failed',
            streamId: stream.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return facebookErrorResponse(
          error,
          'live_end_failed',
          'The live stream could not be ended.',
          undefined,
          { userMessage: END_FAILED_MESSAGE }
        );
      }
    });
  } catch {
    return NextResponse.json(
      { error: 'The live stream could not be ended. Try again.' },
      { status: 500 }
    );
  }
}
