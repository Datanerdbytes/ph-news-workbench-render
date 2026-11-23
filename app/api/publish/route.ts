import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireWorkspace, unauthorized } from '@/lib/session';
import { resolvePageTargets } from '@/lib/publishing/connection';
import { stripMarkdown } from '@/lib/format';
import {
  FacebookApiError,
  parseImages,
  publishPagePost,
  redactTokens,
} from '@/lib/facebook';
import {
  downloadVideoFromUrl,
  publishPageVideo,
} from '@/lib/publishing/videos';
import { readMp4DurationSecondsFromFile } from '@/lib/reel-meta';
import {
  notifyTokenInvalid,
  notifyWorkspace,
} from '@/lib/notifications';
import { recordNativeSchedule } from '@/lib/schedule-mirror';

export const dynamic = 'force-dynamic';

type ConnectionRow = {
  scopes: string | null;
};

export async function POST(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const connectionRows = (await sql`
    SELECT scopes
    FROM facebook_connections
    WHERE workspace_id = ${access.workspace.id}
  `) as unknown as ConnectionRow[];

  const connection = connectionRows[0];
  if (!connection) {
    return NextResponse.json(
      { error: 'Connect your Facebook Page before publishing.', code: 'not_connected' },
      { status: 409 }
    );
  }

  const scopes = (connection.scopes ?? '').split(',').filter(Boolean);
  if (!scopes.includes('pages_manage_posts')) {
    return NextResponse.json(
      {
        error:
          'This connection cannot publish. Reconnect the Page to grant pages_manage_posts.',
        code: 'scope_missing',
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const message =
    typeof body?.message === 'string' ? stripMarkdown(body.message) : '';
  if (!message) {
    return NextResponse.json(
      { error: 'Write or generate a draft before publishing.' },
      { status: 400 }
    );
  }

  const newsItemId = Number(body?.newsItemId);
  if (!Number.isInteger(newsItemId) || newsItemId <= 0) {
    return NextResponse.json({ error: 'newsItemId is required.' }, { status: 400 });
  }

  // Resolve the story and the draft this publish belongs to BEFORE the
  // external call. Two things depend on picking them here: a draft
  // regenerated while Facebook is answering must not be the one marked
  // published, and only a story this workspace owns may be linked to the
  // publish — the Activity feed joins news_items without a workspace
  // predicate, so a foreign story id would leak its headline.
  const [story] = (await sql`
    SELECT n.id, d.id AS draft_id
    FROM news_items n
    LEFT JOIN drafts d
      ON d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id}
    WHERE n.id = ${newsItemId} AND n.workspace_id = ${access.workspace.id}
    ORDER BY d.id DESC
    LIMIT 1
  `) as unknown as { id: number; draft_id: number | null }[];

  // Optional target page — falls back to the workspace default (primary)
  // page, then to the legacy connection, matching every other composer.
  const requestedPageId =
    typeof body?.pageId === 'string' && body.pageId ? body.pageId : null;
  const targets = await resolvePageTargets(
    access.workspace.id,
    requestedPageId ? [requestedPageId] : []
  );
  const target = targets[0];
  if (!target) {
    return NextResponse.json(
      {
        error: requestedPageId
          ? 'That Page is not connected to this workspace.'
          : 'Connect your Facebook Page before publishing.',
        code: 'not_connected',
      },
      { status: 409 }
    );
  }

  try {
    const imageUrls = Array.isArray(body?.imageUrls)
      ? body.imageUrls
      : typeof body?.imageUrl === 'string'
        ? [body.imageUrl]
        : [];
    const videoUrl =
      typeof body?.videoUrl === 'string' && body.videoUrl ? body.videoUrl : null;

    let published: { id: string; permalink: string | null };
    let kind: 'post' | 'video' = 'post';
    if (videoUrl) {
      // A video attachment turns the post into a video publish with the
      // message as the video's description — Facebook has no text-plus-video
      // feed type. The video streams from storage to a temp file (never the
      // heap) and is gone the moment the publish settles.
      const downloaded = await downloadVideoFromUrl(videoUrl);
      try {
        const type = downloaded.upload.type;
        if (!type.includes('video/mp4') && !type.includes('video/quicktime')) {
          return NextResponse.json(
            { error: 'Attach an MP4 or MOV video.' },
            { status: 400 }
          );
        }
        const duration = await readMp4DurationSecondsFromFile(
          downloaded.upload.path
        );
        if (duration !== null && duration > 45 * 60) {
          return NextResponse.json(
            {
              error: `Facebook videos must be 45 minutes or shorter. This video is ${Math.round(duration / 60)} minutes.`,
            },
            { status: 400 }
          );
        }
        const video = await publishPageVideo({
          pageId: target.id,
          accessToken: target.accessToken,
          description: message,
          video: downloaded.upload,
        });
        published = video;
        kind = 'video';
      } finally {
        await downloaded.cleanup();
      }
    } else {
      const post = await publishPagePost({
        pageId: target.id,
        accessToken: target.accessToken,
        message,
        images: parseImages(imageUrls),
      });
      published = post;
    }

    if (story?.draft_id) {
      await sql`
        UPDATE drafts SET status = 'published'
        WHERE id = ${story.draft_id}`;
    }

    // This route publishes straight away and used to leave no trace beyond
    // the draft's status, so the Dashboard's published counters never saw a
    // post made from the story desk. Mirroring it records the publish —
    // linked to the story and the draft it published, so the activity log
    // keeps one entry for it rather than the draft and the event side by
    // side.
    await recordNativeSchedule({
      workspaceId: access.workspace.id,
      userId: access.user.id,
      kind,
      text: message,
      scheduledFor: null,
      results: [
        {
          page: { id: target.id, name: target.name },
          ok: true,
          id: published.id,
          permalink: published.permalink,
        },
      ],
      newsItemId: story?.id ?? null,
      draftId: story?.draft_id ?? null,
    });

    return NextResponse.json({
      id: published.id,
      permalink: published.permalink,
      page: { id: target.id, name: target.name },
    });
  } catch (error) {
    if (error instanceof FacebookApiError) {
      const permissionIssue =
        error.code === 10 || error.code === 200 || error.code === 190;
      if (permissionIssue) {
        await notifyTokenInvalid(access.workspace.id);
        await notifyWorkspace({
          workspaceId: access.workspace.id,
          type: 'publish_failed',
          title: 'Post could not be published',
          body: `${redactTokens(error.message)} Reconnect the Page to refresh its permissions.`.slice(
            0,
            200
          ),
          link: '/post',
          excludeUserIds: [access.user.id],
        });
        return NextResponse.json(
          {
            error: `${redactTokens(error.message)} Reconnect the Page to refresh its permissions.`,
            code: 'permission',
          },
          { status: 403 }
        );
      }
      await notifyWorkspace({
        workspaceId: access.workspace.id,
        type: 'publish_failed',
        title: 'Post could not be published',
        body: redactTokens(error.message).slice(0, 200),
        link: '/post',
        excludeUserIds: [access.user.id],
      });
      return NextResponse.json(
        { error: redactTokens(error.message), code: 'publish_failed' },
        { status: 502 }
      );
    }

    await notifyWorkspace({
      workspaceId: access.workspace.id,
      type: 'publish_failed',
      title: 'Post could not be published',
      body: 'The post could not be published.',
      link: '/post',
      excludeUserIds: [access.user.id],
    });
    return NextResponse.json(
      { error: 'The post could not be published.', code: 'publish_failed' },
      { status: 500 }
    );
  }
}
