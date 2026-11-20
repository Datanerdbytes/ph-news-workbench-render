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
  updatePageLiveVideo,
} from '@/lib/publishing/live';
import { readText } from '@/lib/publishing/request';
import { parseScheduledPublishTime } from '@/lib/publishing/schedule';

export const dynamic = 'force-dynamic';

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
        // End Facebook first; a failed end request must leave the pump and
        // controls available for another attempt.
        await endPageLiveVideo({
          liveVideoId: stream.facebook_video_id,
          accessToken: connection.accessToken,
        });

        // Media runner mode: the pump lives in the worker — relay the stop
        // (best-effort; the worker's reconcile loop will surface reality on
        // the next tick either way).
        if (runnerMode()) {
          await runnerRequest('/pump/stop', {
            workspaceId: access.workspace.id,
            streamId: String(stream.id),
          });
        } else {
          getPumpManager().stop(stream.id);
        }
        await sql`
          UPDATE live_streams
          SET status = 'ENDED', pump_status = 'stopped', updated_at = now()
          WHERE id = ${stream.id} AND workspace_id = ${access.workspace.id}
        `;

        return NextResponse.json({ ended: true });
      } catch (error) {
        return facebookErrorResponse(
          error,
          'live_end_failed',
          'The live stream could not be ended.'
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
