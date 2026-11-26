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
  MAX_VIDEO_BYTES,
  publishPageVideo,
} from '@/lib/publishing/videos';
import { readMp4DurationSecondsFromFile } from '@/lib/reel-meta';
import {
  notifyTokenInvalid,
  notifyWorkspace,
} from '@/lib/notifications';
import { recordNativeSchedule } from '@/lib/schedule-mirror';
import {
  claimAvatarForPublish,
  finishAvatarPublish,
  releaseAvatarPublish,
} from '@/lib/avatar/queue';
import { deleteStagedBlobs } from '@/lib/blob';

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

  const avatarJobId =
    typeof body?.avatarJobId === 'string' && body.avatarJobId.trim()
      ? body.avatarJobId.trim()
      : null;
  if (
    body?.avatarJobId !== undefined &&
    body.avatarJobId !== null &&
    !avatarJobId
  ) {
    return NextResponse.json(
      { error: 'Choose a valid avatar video.' },
      { status: 400 }
    );
  }
  if (
    avatarJobId &&
    (typeof body?.videoUrl !== 'string' || !body.videoUrl)
  ) {
    return NextResponse.json(
      { error: 'An avatar video URL is required.' },
      { status: 400 }
    );
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

  let claimedAvatarId: string | null = null;
  let avatarBlobUrl: string | null = null;
  let graphStarted = false;
  let completedPublish: { id: string; permalink: string | null } | null = null;

  const releasePreGraphAvatar = async () => {
    if (!claimedAvatarId || graphStarted) return;
    const id = claimedAvatarId;
    claimedAvatarId = null;
    try {
      await releaseAvatarPublish(id, access.workspace.id);
    } catch (releaseError) {
      console.error(
        JSON.stringify({
          route: 'publish',
          event: 'avatar_release_failed',
          error: releaseError instanceof Error ? releaseError.name : 'unknown',
        })
      );
    }
  };

  try {
    const imageUrls = Array.isArray(body?.imageUrls)
      ? body.imageUrls
      : typeof body?.imageUrl === 'string'
        ? [body.imageUrl]
        : [];
    let videoUrl =
      typeof body?.videoUrl === 'string' && body.videoUrl ? body.videoUrl : null;

    if (avatarJobId) {
      const claimedUrl = await claimAvatarForPublish(
        avatarJobId,
        access.workspace.id,
        videoUrl as string
      );
      if (!claimedUrl) {
        return NextResponse.json(
          {
            error: 'This avatar video is not ready or has already been used.',
            code: 'avatar_unavailable',
          },
          { status: 409 }
        );
      }
      claimedAvatarId = avatarJobId;
      avatarBlobUrl = claimedUrl;
      // Every fetch and cleanup below uses the URL returned by the atomic
      // ownership claim, never a second client-supplied location.
      videoUrl = claimedUrl;
    }

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
          await releasePreGraphAvatar();
          return NextResponse.json(
            { error: 'Attach an MP4 or MOV video.' },
            { status: 400 }
          );
        }
        const duration = await readMp4DurationSecondsFromFile(
          downloaded.upload.path
        );
        if (duration !== null && duration > 45 * 60) {
          await releasePreGraphAvatar();
          return NextResponse.json(
            {
              error: `Facebook videos must be 45 minutes or shorter. This video is ${Math.round(duration / 60)} minutes.`,
            },
            { status: 400 }
          );
        }
        if (claimedAvatarId && downloaded.upload.size > MAX_VIDEO_BYTES) {
          await releasePreGraphAvatar();
          return NextResponse.json(
            { error: 'Videos must be 1 GB or smaller for the chunked uploader.' },
            { status: 400 }
          );
        }
        // From here on a failure is ambiguous: Graph may have accepted the
        // upload before the connection failed. Keep the ownership claim.
        graphStarted = true;
        const video = await publishPageVideo({
          pageId: target.id,
          accessToken: target.accessToken,
          description: message,
          video: downloaded.upload,
        });
        published = video;
        completedPublish = video;
        kind = 'video';
      } finally {
        await downloaded.cleanup();
      }
    } else {
      const images = parseImages(imageUrls);
      graphStarted = true;
      const post = await publishPagePost({
        pageId: target.id,
        accessToken: target.accessToken,
        message,
        images,
      });
      published = post;
    }
    completedPublish = published;

    // The external publish is already complete. Ancillary database failures
    // must not turn it into a failed response or release the avatar claim.
    if (story?.draft_id) {
      try {
        await sql`
          UPDATE drafts SET status = 'published'
          WHERE id = ${story.draft_id}`;
      } catch (draftError) {
        console.error(
          JSON.stringify({
            route: 'publish',
            event: 'draft_update_failed',
            draftId: story.draft_id,
            error: draftError instanceof Error ? draftError.name : 'unknown',
          })
        );
      }
    }

    // This route publishes straight away and used to leave no trace beyond
    // the draft's status, so the Dashboard's published counters never saw a
    // post made from the story desk. Mirroring it records the publish —
    // linked to the story and the draft it published, so the activity log
    // keeps one entry for it rather than the draft and the event side by
    // side.
    let scheduledPostId: number | null = null;
    try {
      scheduledPostId = await recordNativeSchedule({
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
        ...(avatarJobId ? { avatarJobId } : {}),
      });
    } catch (mirrorError) {
      console.error(
        JSON.stringify({
          route: 'publish',
          event: 'mirror_failed',
          error: mirrorError instanceof Error ? mirrorError.name : 'unknown',
        })
      );
    }

    let warning: string | undefined;
    if (claimedAvatarId) {
      if (scheduledPostId == null) {
        warning =
          'Published, but the local activity record could not be saved. The avatar media was kept for recovery.';
      } else {
        try {
          const finished = await finishAvatarPublish(
            claimedAvatarId,
            access.workspace.id,
            scheduledPostId
          );
          if (!finished) {
            warning =
              'Published, but the local avatar record is incomplete. The avatar media was kept for recovery.';
          } else if (avatarBlobUrl) {
            try {
              await deleteStagedBlobs([avatarBlobUrl]);
            } catch {
              // The durable ownership transition succeeded; cleanup is best-effort.
            }
          }
        } catch (finishError) {
          warning =
            'Published, but the local avatar record is incomplete. The avatar media was kept for recovery.';
          console.error(
            JSON.stringify({
              route: 'publish',
              event: 'avatar_finish_failed',
              error: finishError instanceof Error ? finishError.name : 'unknown',
            })
          );
        }
      }
    }

    return NextResponse.json({
      id: published.id,
      permalink: published.permalink,
      page: { id: target.id, name: target.name },
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    await releasePreGraphAvatar();

    if (completedPublish) {
      return NextResponse.json({
        id: completedPublish.id,
        permalink: completedPublish.permalink,
        page: { id: target.id, name: target.name },
        ...(claimedAvatarId
          ? {
              warning:
                'Published, but the local record is incomplete. The avatar media was kept for recovery.',
            }
          : {}),
      });
    }
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
