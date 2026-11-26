import { sql } from '@/lib/db';
import { recordScheduleEvent } from '@/lib/schedule-events';

/**
 * The kinds of content that Facebook can schedule on our behalf. Each of
 * these is created on Facebook first (with `published=false` +
 * `scheduled_publish_time`, or `planned_start_time` for live) and then
 * mirrored here so the Calendar and Analytics can see it.
 *
 * The story desk does NOT use this module — it schedules locally and the
 * worker publishes it, so it writes `source='local'` rows directly.
 * YouTube uploads mirror here too (`platform:'youtube'`, kind `'video'`):
 * the upload happens immediately and YouTube auto-publishes via
 * `status.publishAt`.
 * TikTok publishes mirror here as well (`platform:'tiktok'`), and Facebook
 * Stories land as kind `'story'`.
 * Instagram has no scheduling API, so only its immediate publishes reach
 * this module (`platform:'instagram'`, kind `'instagram-post'`); the
 * scheduled ones are written directly by the IG route and published by the
 * local worker.
 */
export type NativeScheduleKind =
  | 'post'
  | 'photo'
  | 'video'
  | 'reel'
  | 'live'
  | 'story'
  | 'instagram-post';

/** Platforms that schedule on their own (mirrored as `source` on the row). */
export type NativeSchedulePlatform =
  | 'facebook'
  | 'youtube'
  | 'tiktok'
  | 'instagram';

export type NativePublishResult = {
  page: { id: string; name: string };
  ok: boolean;
  id?: string;
  permalink?: string | null;
  error?: string;
};

export const NATIVE_KIND_LABELS: Record<NativeScheduleKind, string> = {
  post: 'Post',
  photo: 'Photo',
  video: 'Video',
  reel: 'Reel',
  live: 'Live',
  story: 'Story',
  'instagram-post': 'Instagram post',
};

/** Treat anything within this window as "publish now" rather than scheduled. */
export const IMMEDIATE_PUBLISH_WINDOW_MS = 60_000;

/** Row message when every target rejected the publish, per platform — the
 * Facebook wording predates multi-platform mirroring and stays as-is. */
const DEFAULT_REJECT_MESSAGES: Record<NativeSchedulePlatform, string> = {
  facebook: "Facebook rejected the publish on every selected Page.",
  youtube: "YouTube rejected the publish on every selected target.",
  tiktok: "TikTok rejected the publish on every selected target.",
  instagram: "Instagram rejected the publish on every selected account.",
};

/**
 * Record a platform-native publish so the workspace has a local row for it.
 *
 * - A scheduled publish becomes `status='scheduled'` and is later flipped to
 *   `published`/`failed` by the status sweep in lib/schedule-worker.ts, which
 *   asks the platform whether it went live.
 * - An immediate publish becomes `status='published'` right away, so the
 *   Analytics totals count it.
 * - A publish the platform rejected on every target becomes
 *   `status='failed'` so it is visible in the Calendar instead of vanishing.
 *
 * A recording failure never fails the publish itself: the content is already
 * on the platform either way.
 */
export async function recordNativeSchedule({
  workspaceId,
  userId,
  kind,
  text,
  scheduledFor,
  results,
  platform = 'facebook',
  newsItemId = null,
  draftId = null,
  avatarJobId = null,
  mediaUrl = null,
}: {
  workspaceId: string;
  userId: string;
  kind: NativeScheduleKind;
  text: string;
  /** The moment the platform will publish. `null` means it published immediately. */
  scheduledFor: Date | null;
  results: NativePublishResult[];
  platform?: NativeSchedulePlatform;
  newsItemId?: number | null;
  draftId?: number | null;
  avatarJobId?: string | null;
  mediaUrl?: string | null;
}): Promise<number | null> {
  const success = results.find((result) => result.ok);
  const scheduled =
    scheduledFor !== null && scheduledFor.getTime() > Date.now() + IMMEDIATE_PUBLISH_WINDOW_MS;

  const status = !success ? 'failed' : scheduled ? 'scheduled' : 'published';
  const errorMessage = success
    ? null
    : (results.find((result) => result.error)?.error ??
      DEFAULT_REJECT_MESSAGES[platform]);

  try {
    const rows = (await sql`
      INSERT INTO scheduled_posts
        (workspace_id, news_item_id, draft_id, text, scheduled_for, status,
         kind, source, facebook_post_id, facebook_post_ids, page_id,
         error_message, created_by, avatar_job_id, image_url)
      VALUES
        (${workspaceId}, ${newsItemId}, ${draftId}, ${text || '(no caption)'},
         ${(scheduledFor ?? new Date()).toISOString()}, ${status},
         ${kind}, ${platform}, ${success?.id ?? null},
         ${JSON.stringify(results)}::jsonb, ${success?.page.id ?? null},
         ${errorMessage}, ${userId}, ${avatarJobId}, ${mediaUrl})
      RETURNING id`) as unknown as { id: number }[];

    const scheduledPostId = rows[0]?.id;
    if (scheduledPostId === undefined) return null;

    await recordScheduleEvent({
      workspaceId,
      scheduledPostId,
      newsItemId,
      event: status === 'failed' ? 'failed' : status === 'scheduled' ? 'scheduled' : 'published',
      source: 'composer',
      actorUserId: userId,
      facebookPostId: success?.id ?? null,
      errorMessage,
      metadata: {
        kind,
        executor: platform,
        scheduledFor: scheduledFor?.toISOString() ?? null,
        pages: results.length,
        published: results.filter((result) => result.ok).length,
        ...(avatarJobId ? { avatarJobId } : {}),
      },
    });
    return scheduledPostId;
  } catch (error) {
    console.error(
      JSON.stringify({
        route: 'schedule-mirror',
        event: 'record_failed',
        kind,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
}
