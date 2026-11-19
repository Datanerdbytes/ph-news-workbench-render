import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { decryptToken, encryptToken } from '@/lib/facebook-token';
import { getPumpManager } from '@/lib/live/pump';
import {
  mapPumpStatus,
  parseSourceMode,
  pumpProcessRecord,
} from '@/lib/live/pump-state';
import { requirePublishingConnection } from '@/lib/publishing/connection';
import { facebookErrorResponse } from '@/lib/publishing/errors';
import {
  createPageLiveVideo,
  fetchPageLiveVideo,
} from '@/lib/publishing/live';
import { readText } from '@/lib/publishing/request';
import { parseScheduledPublishTime } from '@/lib/publishing/schedule';
import { recordNativeSchedule } from '@/lib/schedule-mirror';
import {
  assertPublicSourceUrl,
  MAX_SOURCE_URL_LENGTH,
  NetworkPolicyError,
} from '@/lib/live/public-network';

export const dynamic = 'force-dynamic';

type StreamRow = {
  id: number;
  facebook_video_id: string;
  title: string;
  description: string | null;
  status: string;
  stream_key: string | null;
  secure_stream_url: string | null;
  permalink_url: string | null;
  planned_start_time: string | Date | null;
  created_at: string | Date;
  source_url: string | null;
  source_mode: string | null;
  pump_status: string;
  pump_started_at: string | Date | null;
  pump_error: string | null;
};

function splitStreamUrl(value: string | null) {
  if (!value) return { base: null, key: null };
  const match = value.match(/^(.*\/)([^/]+)\/?$/);
  if (!match) return { base: value, key: null };
  return { base: match[1], key: match[2] };
}

function toStream(row: StreamRow) {
  let streamKey: string | null = null;
  if (row.stream_key) {
    try {
      streamKey = decryptToken(row.stream_key);
    } catch {
      streamKey = null;
    }
  }
  return {
    id: row.id,
    facebookVideoId: row.facebook_video_id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    streamKey,
    secureStreamUrl: row.secure_stream_url,
    permalink: row.permalink_url,
    plannedStartTime: row.planned_start_time,
    createdAt: row.created_at,
    sourceUrl: row.source_url,
    sourceMode: parseSourceMode(row.source_mode),
    pumpStatus: mapPumpStatus(
      { pumpStatus: row.pump_status },
      pumpProcessRecord(getPumpManager().status(row.id))
    ),
    pumpStartedAt: row.pump_started_at,
    pumpError: row.pump_error,
  };
}

async function loadRows(
  workspaceId: string,
  refresh: boolean,
  accessToken: string
): Promise<StreamRow[]> {
  const rows = (await sql`
    SELECT id, facebook_video_id, title, description, status, stream_key,
           secure_stream_url, permalink_url, planned_start_time, created_at,
           source_url, source_mode, pump_status, pump_started_at, pump_error
    FROM live_streams
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT 50
  `) as unknown as StreamRow[];

  if (!refresh) return rows;

  for (const row of rows) {
    if (row.status === 'ENDED' || row.status === 'VOD') continue;
    try {
      const live = await fetchPageLiveVideo(row.facebook_video_id, accessToken);
      row.status = live.status;
      row.title = live.title || row.title;
      row.description = live.description || row.description;
      row.permalink_url = live.permalink ?? row.permalink_url;
      await sql`
        UPDATE live_streams
        SET status = ${row.status}, title = ${row.title},
            description = ${row.description}, permalink_url = ${row.permalink_url},
            updated_at = now()
        WHERE id = ${row.id} AND workspace_id = ${workspaceId}
      `;
    } catch {
      // A stream that Facebook no longer returns keeps its stored state.
    }
  }

  return rows;
}

export async function GET(request: Request) {
  const result = await requirePublishingConnection(request, 'load live streams');
  if (result.response) return result.response;

  const refresh = new URL(request.url).searchParams.get('refresh') === '1';

  try {
    const rows = await loadRows(
      result.context.access.workspace.id,
      refresh,
      result.context.connection.accessToken
    );
    return NextResponse.json(
      { streams: rows.map(toStream) },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return facebookErrorResponse(
      error,
      'live_load_failed',
      'Could not load live streams.'
    );
  }
}

export async function POST(request: Request) {
  const result = await requirePublishingConnection(request, 'create a live stream');
  if (result.response) return result.response;

  const { access, connection } = result.context;

  // Creating a live video needs publish_video; connections made before that
  // scope was requested fail deep inside Graph with a generic "Permissions
  // error" — surface the real remedy instead.
  if (!connection.scopes.includes('publish_video')) {
    return NextResponse.json(
      {
        error:
          'Going live needs the publish_video permission. Reconnect the Page to grant it.',
        code: 'scope_missing',
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const title = readText(body?.title, 200);
  const description = readText(body?.description, 5000);
  if (!title) {
    return NextResponse.json(
      { error: 'Give the live stream a title.' },
      { status: 400 }
    );
  }

  // The pump copies this address into Facebook's RTMPS ingest. Signed CDN
  // URLs are long, so the bound is generous — but oversized input is
  // rejected, never truncated (truncation would drop signature parameters).
  // The full public-host policy applies here too: a stored source is a
  // server-side fetch target even if it never saw /api/live/resolve.
  // Oversized input is REJECTED, never truncated: truncation would drop
  // signature parameters and yield a differently-addressed request.
  const rawSourceUrl = body?.sourceUrl;
  if (
    rawSourceUrl !== undefined &&
    rawSourceUrl !== null &&
    (typeof rawSourceUrl !== 'string' ||
      rawSourceUrl.trim().length > MAX_SOURCE_URL_LENGTH)
  ) {
    return NextResponse.json(
      { error: 'The source link is too long to be used as a source.' },
      { status: 400 }
    );
  }
  const sourceUrl = readText(rawSourceUrl, MAX_SOURCE_URL_LENGTH);
  if (sourceUrl) {
    try {
      await assertPublicSourceUrl(sourceUrl);
    } catch (error) {
      if (!(error instanceof NetworkPolicyError)) throw error;
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  // How the pump consumes the source, straight from the resolve response:
  // 'direct' = ffmpeg opens the playable URL; 'staged' = no playable URL
  // exists (DASH-only sources such as Facebook replay VODs) and the pump
  // pipes yt-dlp feeder processes instead. An explicit value that is not
  // exactly one of the two strings is rejected — the UI always forwards
  // what resolve returned; absent/null means legacy-direct.
  const rawMode = body?.mode;
  if (
    rawMode !== undefined &&
    rawMode !== null &&
    rawMode !== 'direct' &&
    rawMode !== 'staged'
  ) {
    return NextResponse.json(
      { error: 'The source mode must be either "direct" or "staged".' },
      { status: 400 }
    );
  }
  const sourceMode = parseSourceMode(rawMode);

  const schedule = parseScheduledPublishTime(body?.scheduledFor);
  if (schedule.error) {
    return NextResponse.json({ error: schedule.error }, { status: 400 });
  }

  try {
    const live = await createPageLiveVideo({
      pageId: connection.pageId,
      accessToken: connection.accessToken,
      title,
      description,
      plannedStartTime: schedule.unix,
    });

    const secure = splitStreamUrl(live.secureStreamUrl ?? live.streamUrl);
    const storedKey = secure.key ? encryptToken(secure.key) : null;
    const planned =
      live.plannedStartTime ??
      (schedule.unix ? new Date(schedule.unix * 1000).toISOString() : null);

    const rows = (await sql`
      INSERT INTO live_streams
        (workspace_id, facebook_video_id, title, description, status,
         stream_key, secure_stream_url, permalink_url, planned_start_time,
         source_url, source_mode, created_by)
      VALUES
        (${access.workspace.id}, ${live.id}, ${live.title}, ${live.description},
         ${live.status}, ${storedKey}, ${secure.base}, ${live.permalink},
         ${planned}, ${sourceUrl || null}, ${sourceMode}, ${access.user.id})
      ON CONFLICT (workspace_id, facebook_video_id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        stream_key = EXCLUDED.stream_key,
        secure_stream_url = EXCLUDED.secure_stream_url,
        permalink_url = EXCLUDED.permalink_url,
        planned_start_time = EXCLUDED.planned_start_time,
        source_url = EXCLUDED.source_url,
        source_mode = EXCLUDED.source_mode,
        updated_at = now()
      RETURNING id, facebook_video_id, title, description, status, stream_key,
                secure_stream_url, permalink_url, planned_start_time, created_at,
                source_url, source_mode, pump_status, pump_started_at, pump_error
    `) as unknown as StreamRow[];

    // A planned live stream is held by Facebook until its start time. Mirror
    // it so the Calendar and Analytics can see it alongside every other
    // scheduled item.
    await recordNativeSchedule({
      workspaceId: access.workspace.id,
      userId: access.user.id,
      kind: 'live',
      text: live.title,
      scheduledFor: schedule.unix ? new Date(schedule.unix * 1000) : null,
      results: [
        {
          page: { id: connection.pageId, name: connection.pageName },
          ok: true,
          id: live.id,
          permalink: live.permalink ?? null,
        },
      ],
    });

    return NextResponse.json(
      {
        stream: { ...toStream(rows[0]), streamKey: secure.key },
        page: { id: connection.pageId, name: connection.pageName },
      },
      { status: 201 }
    );
  } catch (error) {
    return facebookErrorResponse(
      error,
      'live_create_failed',
      'The live stream could not be created.'
    );
  }
}
