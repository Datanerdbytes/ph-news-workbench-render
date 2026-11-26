import { sql } from "@/lib/db";
import {
  FacebookApiError,
  cancelFacebookScheduledPost,
  isFacebookLiveStarted,
  isFacebookPostPublished,
  isFacebookStillScheduled,
  isFacebookVideoPublished,
  parseImages,
  publishPagePost,
  redactTokens,
  rescheduleFacebookScheduledPost,
} from "@/lib/facebook";
import { facebookTargets } from "@/lib/facebook-schedule";
import { stripMarkdown } from "@/lib/format";
import {
  recordScheduleEvent,
  type ScheduleEventSource,
} from "@/lib/schedule-events";
import {
  notifyTokenInvalid,
  notifyWorkspace,
  scheduledOutcomeCopy,
} from "@/lib/notifications";
import { getPrimaryPage, resolvePageToken } from "@/lib/facebook-page-token";
import { deleteStagedBlobs } from "@/lib/blob";
import { deleteScheduledPostWithAvatarRelease } from "@/lib/schedule-cancellation";
import {
  downloadVideoFromUrl,
  publishPageVideo,
} from "@/lib/publishing/videos";
import {
  publishInstagramImagePost,
  resolveInstagramAccount,
  type InstagramAccountResolution,
} from "@/lib/publishing/instagram";
import { InstagramApiError } from "@/lib/instagram";
import { resolvePlatformAccount } from "@/lib/publishing/connection";
import {
  ensureFreshYouTubeToken,
  fetchYouTubeVideoStatus,
} from "@/lib/youtube";

/** How many times the local executor will try a post before giving up. */
const MAX_ATTEMPTS = 3;
/** Wait this long between retries of a failed local publish. */
const RETRY_BACKOFF_MINUTES = 2;
/** A post stuck in 'publishing' this long is assumed to have been orphaned. */
const STUCK_PUBLISHING_MINUTES = 5;
/** How long after its slot a Facebook-native item may stay unpublished. */
const NATIVE_GRACE_MINUTES: Record<string, number> = {
  post: 60,
  photo: 60,
  reel: 60,
  live: 120,
  // Long videos need time to finish processing before they can go live.
  video: 60,
};
/** How long after its slot a YouTube-scheduled video may stay private. */
const YOUTUBE_GRACE_MINUTES = 60;

type ClaimedRow = {
  id: number;
  workspace_id: string;
  news_item_id: number | null;
  draft_id: number | null;
  text: string;
  image_url: string | null;
  image_urls: unknown;
  kind: string;
  page_id: string | null;
  avatar_job_id: string | null;
  attempts: number;
};

export type ScheduleRunResult = {
  due: number;
  published: number;
  failed: number;
  synced: number;
};

export type ScheduleRunOptions = {
  source: ScheduleEventSource;
  actorUserId?: string | null;
};

type PublicationCompletion = {
  id: number;
  media_url: string | null;
  avatar_blob_url: string | null;
};

/**
 * Commit the local publication record and the avatar ownership transition in
 * one statement. The returned blob URL is the only permission to clean up an
 * avatar's staged media.
 */
async function completeSchedulePublication(input: {
  id: number;
  workspaceId: string;
  facebookPostId: string;
  avatarJobId: string | null;
  status: "publishing" | "scheduled";
  attempts?: number;
  scheduledFor?: string | Date;
}): Promise<PublicationCompletion | null> {
  const rows = (await sql`
    WITH published AS (
      UPDATE scheduled_posts
      SET status = 'published', facebook_post_id = ${input.facebookPostId},
          error_message = NULL, updated_at = now()
      WHERE id = ${input.id} AND workspace_id = ${input.workspaceId}
        AND status = ${input.status}
        ${input.attempts === undefined
          ? sql``
          : sql`AND attempts = ${input.attempts}`}
        ${input.scheduledFor === undefined
          ? sql``
          : sql`AND scheduled_for = ${input.scheduledFor}`}
      RETURNING id, workspace_id, avatar_job_id, image_url
    ), completed_avatar AS (
      UPDATE avatar_jobs
      SET publish_state = 'published', updated_at = now()
      FROM published
      WHERE avatar_jobs.id = published.avatar_job_id
        AND avatar_jobs.workspace_id = published.workspace_id
        AND avatar_jobs.status = 'completed'
        AND avatar_jobs.publish_state = 'scheduled'
      RETURNING avatar_jobs.id, avatar_jobs.blob_url
    )
    SELECT published.id, published.image_url AS media_url,
           completed_avatar.blob_url AS avatar_blob_url
    FROM published
    LEFT JOIN completed_avatar ON completed_avatar.id = published.avatar_job_id`) as unknown as PublicationCompletion[];
  return rows[0] ?? null;
}

export async function markPublishStarted(
  id: number,
  workspaceId: string,
  attempts: number,
  mediaId?: string,
): Promise<void> {
  const rows = (await sql`
    UPDATE scheduled_posts
    SET facebook_post_id = COALESCE(facebook_post_id, ${mediaId ?? null}),
        publish_started_at = now(), updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND status = 'publishing'
      AND attempts = ${attempts}
    RETURNING id`) as unknown as { id: number }[];
  if (!rows.length) {
    throw new Error("This scheduled post is no longer owned by the publisher.");
  }
}

export async function claimScheduledPost(
  post: ClaimedRow,
): Promise<{ id: number; attempts: number } | null> {
  const rows = (await sql`
    UPDATE scheduled_posts AS post
    SET status = 'publishing', attempts = attempts + 1, updated_at = now()
    WHERE post.id = ${post.id} AND post.status = 'scheduled'
      AND post.scheduled_for <= now()
      AND post.attempts < ${MAX_ATTEMPTS}
      AND (
        post.avatar_job_id IS NULL
        OR EXISTS (
          SELECT 1 FROM avatar_jobs
          WHERE avatar_jobs.id = post.avatar_job_id
            AND avatar_jobs.workspace_id = post.workspace_id
            AND avatar_jobs.status = 'completed'
            AND avatar_jobs.publish_state = 'scheduled'
            AND avatar_jobs.blob_url IS NOT NULL
            AND (
              avatar_jobs.blob_url = post.image_url
              OR (
                post.image_url IS NOT NULL
                AND strpos(post.image_url, '/compose/avatars/' || avatar_jobs.id || '/') > 0
              )
            )
        )
      )
      AND (post.attempts = 0
           OR post.updated_at < now() - (${RETRY_BACKOFF_MINUTES} * interval '1 minute'))
    RETURNING post.id, post.attempts`) as unknown as { id: number; attempts: number }[];
  return rows[0] ?? null;
}

async function persistPublishedMediaId(
  id: number,
  workspaceId: string,
  attempts: number,
  mediaId: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE scheduled_posts
    SET facebook_post_id = ${mediaId}, updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND status = 'publishing'
      AND attempts = ${attempts}
    RETURNING id`;
  return rows.length > 0;
}

async function deleteCompletedAvatar(
  mediaUrl: string | null,
  avatarBlobUrl: string | null,
): Promise<void> {
  if (!avatarBlobUrl) return;
  const urls = [...new Set([mediaUrl, avatarBlobUrl])].filter(
    (url): url is string => Boolean(url)
  );
  try {
    await deleteStagedBlobs(urls);
  } catch {
    // The durable publication and ownership transition already succeeded.
  }
}

export async function publishDuePosts(
  options: ScheduleRunOptions = { source: "scheduler" }
): Promise<ScheduleRunResult> {
  const synced = await syncNativeSchedules();
  await requeueStuckPosts();

  // Candidate selection only — the real claim happens per row, immediately
  // before its publish, so a slow publish (Instagram's container polling)
  // cannot let an overlapping sweep double-publish a waiting row.
  const due = (await sql`
    SELECT id, workspace_id, news_item_id, draft_id, text,
           image_url, image_urls, kind, page_id, avatar_job_id, attempts
    FROM scheduled_posts
    WHERE status = 'scheduled' AND scheduled_for <= now()
      AND source = 'local'
      AND attempts < ${MAX_ATTEMPTS}
      AND (
        avatar_job_id IS NULL
        OR EXISTS (
          SELECT 1 FROM avatar_jobs
          WHERE avatar_jobs.id = scheduled_posts.avatar_job_id
            AND avatar_jobs.workspace_id = scheduled_posts.workspace_id
            AND avatar_jobs.status = 'completed'
            AND avatar_jobs.publish_state = 'scheduled'
            AND avatar_jobs.blob_url IS NOT NULL
            AND (
              avatar_jobs.blob_url = scheduled_posts.image_url
              OR (
                scheduled_posts.image_url IS NOT NULL
                AND strpos(scheduled_posts.image_url, '/compose/avatars/' || avatar_jobs.id || '/') > 0
              )
            )
        )
      )
      AND (attempts = 0
           OR updated_at < now() - (${RETRY_BACKOFF_MINUTES} * interval '1 minute'))
    ORDER BY scheduled_for ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED`) as unknown as ClaimedRow[];

  let published = 0;
  let failed = 0;

  for (const post of due) {
    // Conditional claim: only a row still in 'scheduled' may publish, and the
    // eligibility gates (attempt budget, retry backoff) are re-checked
    // against the CURRENT row — a concurrent sweep's stale candidate cannot
    // claim a row that just failed a retry. The claim returns the updated
    // attempt count, which drives the failure decisions below.
    const claimed = await claimScheduledPost(post);
    if (!claimed) continue;
    const attemptCount = claimed.attempts;

    await recordScheduleEvent({
      workspaceId: post.workspace_id,
      scheduledPostId: post.id,
      newsItemId: post.news_item_id,
      event: "claimed",
      source: options.source,
      actorUserId: options.actorUserId,
    });

    let mediaId: string;
    try {
      if (post.kind === "instagram-post") {
        mediaId = await publishScheduledInstagramPost(post, () =>
          markPublishStarted(post.id, post.workspace_id, attemptCount),
        );
      } else if (post.kind === "video") {
        // A scheduled video carries its staged file URL in image_url —
        // stream it to a temp file (never the heap) and publish it with the
        // post text as the video's description. It goes to the Page picked
        // at schedule time, falling back to the primary Page.
        const primary = await getPrimaryPage(post.workspace_id);
        if (!primary) {
          throw new Error("This workspace has no connected Facebook Page.");
        }
        let pageId = primary.pageId;
        let token = primary.token;
        if (post.page_id) {
          const scoped = await resolvePageToken(post.workspace_id, post.page_id);
          if (!scoped) {
            throw new Error("That Page is not connected to this workspace.");
          }
          pageId = post.page_id;
          token = scoped;
        }
        if (!post.image_url) {
          throw new Error("The scheduled video is missing its file.");
        }
        const downloaded = await downloadVideoFromUrl(post.image_url);
        try {
          const video = await publishPageVideo({
            pageId,
            accessToken: token,
            description: stripMarkdown(post.text),
            video: downloaded.upload,
            beforePublish: (videoId) =>
              markPublishStarted(post.id, post.workspace_id, attemptCount, videoId),
          });
          mediaId = video.id;
        } finally {
          try {
            await downloaded.cleanup();
          } catch {
            // Temp cleanup cannot change the publish outcome.
          }
        }
      } else {
        const primary = await getPrimaryPage(post.workspace_id);
        if (!primary) {
          throw new Error("This workspace has no connected Facebook Page.");
        }

        const storedImages = Array.isArray(post.image_urls)
          ? post.image_urls
          : post.image_url
            ? [post.image_url]
            : [];

        const result = await publishPagePost({
          pageId: primary.pageId,
          accessToken: primary.token,
          message: stripMarkdown(post.text),
          images: parseImages(storedImages),
          beforePublish: () =>
            markPublishStarted(post.id, post.workspace_id, attemptCount),
        });
        mediaId = result.id;
      }
    } catch (error) {
      const message =
        error instanceof FacebookApiError
          ? redactTokens(error.message)
          : error instanceof Error
            ? error.message
            : "The scheduled post could not be published.";
      const permissionIssue =
        error instanceof FacebookApiError &&
        (error.code === 10 || error.code === 200 || error.code === 190);
      const ambiguous =
        (error instanceof FacebookApiError ||
          error instanceof InstagramApiError) &&
        error.ambiguous;

      if (ambiguous) {
        await sql`
          UPDATE scheduled_posts
          SET error_message = ${`${message} Automatic retry is paused because the platform may have accepted it.`},
              updated_at = now()
          WHERE id = ${post.id} AND workspace_id = ${post.workspace_id}
            AND status = 'publishing'
            AND attempts = ${attemptCount}`;
        continue;
      }

      // A definite failure is safe to retry until the attempt budget runs out.
      const exhausted = attemptCount >= MAX_ATTEMPTS;

      const failureRows = (await sql`
        UPDATE scheduled_posts
        SET status = ${exhausted ? "failed" : "scheduled"},
            error_message = ${message}, facebook_post_id = NULL,
            publish_started_at = NULL, updated_at = now()
        WHERE id = ${post.id} AND workspace_id = ${post.workspace_id}
          AND status = 'publishing'
          AND attempts = ${attemptCount}
        RETURNING id`) as unknown as { id: number }[];
      if (!failureRows.length) continue;

      await recordScheduleEvent({
        workspaceId: post.workspace_id,
        scheduledPostId: post.id,
        newsItemId: post.news_item_id,
        event: exhausted ? "failed" : "retrying",
        source: options.source,
        actorUserId: options.actorUserId,
        errorMessage: message,
        metadata: { attempt: attemptCount, maxAttempts: MAX_ATTEMPTS },
      });

      if (permissionIssue) {
        await notifyTokenInvalid(post.workspace_id);
      }

      if (exhausted) {
        failed++;
        const failedCopy = scheduledOutcomeCopy(post.kind, false, message);
        await notifyWorkspace({
          workspaceId: post.workspace_id,
          type: "scheduled_publish_failed",
          title: failedCopy.title,
          body: failedCopy.body,
          link: `/calendar?post=${post.id}`,
        });
      }
      continue;
    }

    try {
      const persisted = await persistPublishedMediaId(
        post.id,
        post.workspace_id,
        attemptCount,
        mediaId,
      );
      if (!persisted) continue;
    } catch (error) {
      console.error(
        JSON.stringify({
          route: "schedule-worker",
          event: "published_media_id_persist_failed",
          scheduledPostId: post.id,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
    }

    // Graph accepted the publish. A later durable-write failure must leave
    // the row publishing for recovery, never send it back to Graph.
    published++;
    try {
      const completion = await completeSchedulePublication({
        id: post.id,
        workspaceId: post.workspace_id,
        facebookPostId: mediaId,
        avatarJobId: post.avatar_job_id,
        status: "publishing",
        attempts: attemptCount,
      });
      if (!completion) continue;

      // Preserve ordinary staged-media cleanup. Avatar media is deleted only
      // when the atomic completion returned its database-owned blob URL.
      if (
        !post.avatar_job_id &&
        (post.kind === "instagram-post" || post.kind === "video") &&
        post.image_url
      ) {
        try {
          await deleteStagedBlobs([post.image_url]);
        } catch {
          // Cleanup only.
        }
      }
      await deleteCompletedAvatar(completion.media_url, completion.avatar_blob_url);

      if (post.draft_id) {
        await sql`UPDATE drafts SET status = 'published' WHERE id = ${post.draft_id}`;
      }

      await recordScheduleEvent({
        workspaceId: post.workspace_id,
        scheduledPostId: post.id,
        newsItemId: post.news_item_id,
        event: "published",
        source: options.source,
        actorUserId: options.actorUserId,
        facebookPostId: mediaId,
      });

      const successCopy = scheduledOutcomeCopy(post.kind, true, post.text);
      await notifyWorkspace({
        workspaceId: post.workspace_id,
        type: "scheduled_publish_success",
        title: successCopy.title,
        body: successCopy.body,
        link: `/calendar?post=${post.id}`,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          route: "schedule-worker",
          event: "publication_completion_failed",
          scheduledPostId: post.id,
          kind: post.kind,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
    }
  }

  return { due: due.length, published, failed, synced };
}

/** Human copy for each Instagram resolution failure — mirrors the gates the
 * IG publish route shows, so retries fail with the same actionable text. */
function instagramGateMessage(
  resolution: Extract<InstagramAccountResolution, { ok: false }>
): string {
  switch (resolution.reason) {
    case "scope_missing":
      return `Reconnect to grant ${resolution.detail ?? "the Instagram scopes"} before posting.`;
    case "no_ig_account":
      return (
        resolution.detail ??
        "This Page has no professional Instagram account linked to it."
      );
    case "probe_failed":
      return `Could not verify the Instagram connection${resolution.detail ? `: ${resolution.detail}` : "."}`;
    default:
      return "Connect your Facebook Page with Instagram permissions before posting to Instagram.";
  }
}

/**
 * The local executor for scheduled Instagram posts. Instagram has no
 * scheduling API, so the row holds a staged blob image and the worker runs
 * the container → publish flow at the due time. The media id lands in the
 * same column Facebook uses (it is a generic platform-media-id column).
 * Staged-image cleanup happens AFTER the durable published write in the
 * caller — deleting earlier would break the retry path on a write failure.
 */
async function publishScheduledInstagramPost(
  post: ClaimedRow,
  beforePublish: () => Promise<void>,
): Promise<string> {
  if (!post.image_url) {
    throw new Error("The scheduled Instagram post is missing its staged image.");
  }

  const connection = await resolveInstagramAccount(post.workspace_id);
  if (!connection.ok) {
    throw new Error(instagramGateMessage(connection));
  }

  const result = await publishInstagramImagePost({
    account: connection.account,
    accessToken: connection.accessToken,
    imageUrl: post.image_url,
    caption: stripMarkdown(post.text),
    beforePublish,
  });

  return result.id;
}

export async function requeueInterruptedPost(row: {
  id: number;
  workspace_id: string;
  attempts: number;
}): Promise<"scheduled" | "failed" | null> {
  const newStatus = row.attempts >= MAX_ATTEMPTS ? "failed" : "scheduled";
  const rows = (await sql`
    UPDATE scheduled_posts
    SET status = ${newStatus},
        error_message = 'The scheduler was interrupted before this post went out.',
        publish_started_at = NULL,
        updated_at = now()
    WHERE id = ${row.id}
      AND workspace_id = ${row.workspace_id}
      AND status = 'publishing'
      AND attempts = ${row.attempts}
      AND facebook_post_id IS NULL
      AND publish_started_at IS NULL
    RETURNING id`) as unknown as { id: number }[];
  return rows.length > 0 ? newStatus : null;
}

/**
 * Recover posts the executor claimed but never finished — a crash or a
 * restart between the claim and the publish leaves them stuck in
 * 'publishing' forever, because only 'scheduled' rows are claimed.
 */
async function requeueStuckPosts(): Promise<void> {
  const rows = (await sql`
    SELECT id, workspace_id, news_item_id, attempts, facebook_post_id,
           publish_started_at, kind, avatar_job_id
    FROM scheduled_posts
    WHERE status = 'publishing'
      AND updated_at < now() - (${STUCK_PUBLISHING_MINUTES} * interval '1 minute')
      AND (facebook_post_id IS NOT NULL OR publish_started_at IS NULL)
    LIMIT 10
    FOR UPDATE SKIP LOCKED`) as unknown as {
    id: number;
    workspace_id: string;
    news_item_id: number | null;
    attempts: number;
    facebook_post_id: string | null;
    publish_started_at: string | null;
    kind: string;
    avatar_job_id: string | null;
  }[];

  for (const row of rows) {
    // First check if Facebook actually published it
    if (row.facebook_post_id) {
      const token = await resolvePageToken(row.workspace_id, null);
      if (token) {
        const published = await detectPublished(row.kind, row.facebook_post_id, token);
        if (published === true) {
          // Facebook did publish it — commit the local row and linked avatar
          // together. A failed write leaves the claim for a later sweep; it
          // must never requeue content that is already live.
          let completion: PublicationCompletion | null;
          try {
            completion = await completeSchedulePublication({
              id: row.id,
              workspaceId: row.workspace_id,
              facebookPostId: row.facebook_post_id,
              avatarJobId: row.avatar_job_id,
              status: "publishing",
              attempts: row.attempts,
            });
          } catch (error) {
            console.error(
              JSON.stringify({
                route: "schedule-worker",
                event: "recovered_publication_completion_failed",
                scheduledPostId: row.id,
                error: error instanceof Error ? error.name : "unknown",
              })
            );
            continue;
          }
          if (!completion) continue;
          await deleteCompletedAvatar(completion.media_url, completion.avatar_blob_url);
          await recordScheduleEvent({
            workspaceId: row.workspace_id,
            scheduledPostId: row.id,
            newsItemId: row.news_item_id,
            event: "published",
            source: "scheduler",
            facebookPostId: row.facebook_post_id,
            metadata: { kind: row.kind, executor: "facebook", recovered: true },
          });
          const recoveredCopy = scheduledOutcomeCopy(row.kind, true);
          await notifyWorkspace({
            workspaceId: row.workspace_id,
            type: "scheduled_publish_success",
            title: recoveredCopy.title,
            body: recoveredCopy.body,
            link: `/calendar?post=${row.id}`,
          });
          continue;
        }
      }
      // A platform id exists but publication could not be confirmed. Keep the
      // row for reconciliation; republishing could duplicate live content.
      continue;
    }

    // Once the external publish began, a missing id is an unknown outcome,
    // not proof that nothing was accepted.
    if (row.publish_started_at) continue;

    // No id and no publish marker: the executor stopped before Graph.
    const newStatus = await requeueInterruptedPost(row);
    if (!newStatus) continue;
    const exhausted = newStatus === "failed";

    await recordScheduleEvent({
      workspaceId: row.workspace_id,
      scheduledPostId: row.id,
      newsItemId: row.news_item_id,
      event: exhausted ? "failed" : "retrying",
      source: "scheduler",
      errorMessage:
        "The scheduler was interrupted before this post went out.",
      metadata: { attempt: row.attempts, maxAttempts: MAX_ATTEMPTS },
    });

    if (exhausted) {
      const interruptedCopy = scheduledOutcomeCopy(
        row.kind,
        false,
        "The scheduler was interrupted before this post went out."
      );
      await notifyWorkspace({
        workspaceId: row.workspace_id,
        type: "scheduled_publish_failed",
        title: interruptedCopy.title,
        body: interruptedCopy.body,
        link: `/calendar?post=${row.id}`,
      });
    }
  }
}

type NativeRow = {
  id: number;
  workspace_id: string;
  news_item_id: number | null;
  kind: string;
  source: string;
  facebook_post_id: string | null;
  facebook_post_ids: unknown;
  page_id: string | null;
  scheduled_for: Date | string;
  avatar_job_id: string | null;
};

/**
 * Release stale rescheduling claims abandoned by a crash or timeout.
 * When an intended time was persisted with the claim, recover with that
 * confirmed intended time instead of restoring a stale overdue scheduled_for.
 *
 * Recovery owns the row while it works: the observed claim is atomically
 * swapped for a fresh one before any remote call, and PATCH/DELETE refuse a
 * claimed row — so a concurrent sweep or request cannot interleave, and a
 * sweep whose claim was observed by two readers cannot double-fire once the
 * other reader's swap wins. A claim counts as recovered only when the final
 * update confirms the new claim still owned the row.
 */
export async function recoverStaleReschedules(): Promise<number> {
  const stale = (await sql`
    SELECT id, workspace_id, source, kind, facebook_post_id, facebook_post_ids,
           page_id, scheduled_for, error_message, avatar_job_id, image_url
    FROM scheduled_posts
    WHERE status = 'rescheduling'
      AND updated_at < now() - interval '10 minutes'
    FOR UPDATE SKIP LOCKED`) as unknown as Array<{
      id: number;
      workspace_id: string;
      source: string;
      kind: string;
      facebook_post_id: string | null;
      facebook_post_ids: unknown;
      page_id: string | null;
      scheduled_for: string;
      error_message: string | null;
      avatar_job_id: string | null;
      image_url: string | null;
    }>;

  let recovered = 0;
  for (const row of stale) {
    let parsed: { claim?: string; action?: string; intended?: string } | null =
      null;
    try {
      if (row.error_message?.startsWith("{")) {
        parsed = JSON.parse(row.error_message);
      }
    } catch {}

    // Take exclusive ownership of the claim before any remote work. The
    // SELECT's row lock is released as soon as this Neon HTTP query returns,
    // so two sweeps can observe the same claim; only the one whose swap
    // matches the observed claim may proceed. The swap rewrites the claim to
    // a fresh payload carrying the same intent, so the next sweep parses it
    // exactly like the original.
    const recoveryClaim = JSON.stringify(
      parsed?.action === "delete"
        ? { claim: crypto.randomUUID(), action: "delete" }
        : {
            claim: crypto.randomUUID(),
            ...(parsed?.intended ? { intended: parsed.intended } : {}),
          }
    );
    const owned = (await sql`
      UPDATE scheduled_posts
      SET error_message = ${recoveryClaim},
          updated_at = now()
      WHERE id = ${row.id}
        AND status = 'rescheduling'
        AND (error_message = ${row.error_message} OR (${row.error_message} IS NULL AND error_message IS NULL))
      RETURNING id`) as unknown as { id: number }[];

    if (!owned.length) {
      continue;
    }

    // Separate deletion-claim recovery from rescheduling-claim recovery.
    // If a DELETE operation crashed while holding the claim, complete the
    // deletion rather than restoring it to scheduled.
    if (parsed?.action === "delete") {
      if (row.source === "facebook") {
        // The DELETE route claims before it cancels, so a crash in between
        // leaves Facebook holding the post. Confirm the remote cancellation
        // on every Page that accepted the action before deleting the local
        // row — the claim match alone does not confirm it.
        const targets = facebookTargets(row);
        let canceled = targets.length > 0;
        for (const target of targets) {
          try {
            const token = await resolvePageToken(
              row.workspace_id,
              target.pageId
            );
            if (!token) {
              canceled = false;
              break;
            }
            const held = target.pageId
              ? await isFacebookStillScheduled(target.pageId, target.postId, token)
              : null;
            if (held !== false) {
              await cancelFacebookScheduledPost(
                target.postId,
                token,
                target.pageId
              );
            }
          } catch {
            canceled = false;
            break;
          }
        }
        if (!canceled) {
          // Cancellation could not be confirmed. Mirror the DELETE route's
          // failure outcome — put the row back to 'scheduled' so the user can
          // retry the cancel with proper feedback instead of deleting it here
          // while Facebook may still hold the post.
          await sql`
            UPDATE scheduled_posts
            SET status = 'scheduled',
                error_message = NULL,
                updated_at = now()
            WHERE id = ${row.id}
              AND status = 'rescheduling'
              AND error_message = ${recoveryClaim}`;
          continue;
        }
      }

      const deleted = await deleteScheduledPostWithAvatarRelease({
        id: row.id,
        workspaceId: row.workspace_id,
        status: "rescheduling",
        claim: recoveryClaim,
      });

      if (deleted) {
        await recordScheduleEvent({
          workspaceId: row.workspace_id,
          scheduledPostId: deleted.id,
          newsItemId: deleted.news_item_id,
          event: "canceled",
          source: "scheduler",
          metadata: { scheduledFor: deleted.scheduled_for, recovered: true },
        });
        recovered++;
      }
      continue;
    }

    const intendedIso =
      typeof parsed?.intended === "string" ? parsed.intended : null;
    let targetTime = row.scheduled_for;
    if (intendedIso) {
      if (row.source === "facebook") {
        // Re-apply the intended time to every Page that accepted the action
        // — the claim does not confirm the remote state, the confirmed moves
        // do. The claim is only released once every Page is confirmed at the
        // new time; an unconfirmed Page keeps the claim for the next sweep,
        // so the row never advertises a time Facebook may not hold.
        const targets = facebookTargets(row);
        let confirmed = true;
        for (const target of targets) {
          try {
            const token = await resolvePageToken(
              row.workspace_id,
              target.pageId
            );
            if (!token) {
              confirmed = false;
              break;
            }
            const held = target.pageId
              ? await isFacebookStillScheduled(target.pageId, target.postId, token)
              : null;
            if (held === false) {
              // Facebook no longer holds the item — it published or was
              // removed, and the sync sweep settles the outcome. Nothing
              // left to move on this Page.
              continue;
            }
            const newUnix = Math.floor(new Date(intendedIso).getTime() / 1000);
            await rescheduleFacebookScheduledPost(
              target.postId,
              token,
              newUnix,
              target.pageId
            );
          } catch {
            confirmed = false;
            break;
          }
        }
        if (!confirmed) {
          continue;
        }
        // A row no Page accepted follows PATCH's outcome for the same
        // situation — a definite refusal: release the claim and keep the old
        // time. Otherwise the confirmed intended time stands.
        targetTime = targets.length ? intendedIso : row.scheduled_for;
      } else {
        // No platform holds this row, so the persisted intent is the truth.
        targetTime = intendedIso;
      }
    }

    const updated = (await sql`
      UPDATE scheduled_posts
      SET status = 'scheduled',
          scheduled_for = ${targetTime},
          error_message = NULL,
          updated_at = now()
      WHERE id = ${row.id}
        AND status = 'rescheduling'
        AND error_message = ${recoveryClaim}
      RETURNING id`) as unknown as { id: number }[];

    if (updated.length) {
      recovered++;
    }
  }

  return recovered;
}

/**
 * Facebook (and, for videos scheduled with publishAt, YouTube) is the
 * executor for every natively scheduled item, but the workspace still needs
 * to learn how each one ended. This sweep asks the platform whether the item
 * went live and flips the local row to 'published' or 'failed' — so the
 * Calendar and Analytics stay truthful.
 */
export async function syncNativeSchedules(): Promise<number> {
  // A crash between claim and completion leaves a row held by nobody.
  // Reconcile and release stale claims older than 10 minutes.
  await recoverStaleReschedules();

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
  const rows = (await sql`
    SELECT id, workspace_id, news_item_id, kind, source, facebook_post_id,
           facebook_post_ids, page_id, scheduled_for, avatar_job_id
    FROM scheduled_posts
    WHERE source IN ('facebook', 'youtube') AND status = 'scheduled'
      AND scheduled_for <= ${oneMinuteAgo}
      AND updated_at < ${twoMinutesAgo}
    ORDER BY scheduled_for ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED`) as unknown as NativeRow[];

  let synced = 0;

  for (const row of rows) {
    if (row.source === "youtube") {
      // Per-row boundary: a failing terminal write (status flip, event,
      // notification) must not abort the sweep or starve the local claim.
      try {
        synced += await syncYouTubeSchedule(row);
      } catch (error) {
        console.error(
          JSON.stringify({
            route: "schedule-sync",
            event: "failed",
            scheduledPostId: row.id,
            kind: row.kind,
            source: "youtube",
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      continue;
    }

    const postId = row.facebook_post_id;
    if (!postId) {
      await markNativeFailed(
        row,
        "Facebook did not return an id for this item."
      );
      continue;
    }

    try {
      const token = await resolvePageToken(row.workspace_id, row.page_id);
      if (!token) continue;

      const published = await detectPublished(row.kind, postId, token);

      if (published === true) {
        const completion = await completeSchedulePublication({
          id: row.id,
          workspaceId: row.workspace_id,
          facebookPostId: postId,
          avatarJobId: row.avatar_job_id,
          status: "scheduled",
          scheduledFor: row.scheduled_for,
        });
        if (!completion) continue;
        await deleteCompletedAvatar(completion.media_url, completion.avatar_blob_url);
        await recordScheduleEvent({
          workspaceId: row.workspace_id,
          scheduledPostId: row.id,
          newsItemId: row.news_item_id,
          event: "published",
          source: "scheduler",
          facebookPostId: postId,
          metadata: { kind: row.kind, executor: "facebook" },
        });
        const nativeCopy = scheduledOutcomeCopy(row.kind, true);
        await notifyWorkspace({
          workspaceId: row.workspace_id,
          type: "scheduled_publish_success",
          title: nativeCopy.title,
          body: nativeCopy.body,
          link: `/calendar?post=${row.id}`,
        });
        synced++;
        continue;
      }

      if (published === null && row.page_id) {
        // Reel and video container nodes cannot be read at all (bare GETs are
        // refused with code 12), so the probes above stay "unknown" for them.
        // Ask Facebook's own queue instead: once the item leaves
        // /{page}/scheduled_posts, Facebook has released it — past the slot
        // that means it went out, before the slot that it was removed there.
        const held = await isFacebookStillScheduled(
          row.page_id,
          postId,
          token
        );
        if (held === false) {
          const pastSlot =
            Date.now() >= new Date(row.scheduled_for).getTime();
          if (pastSlot) {
            const completion = await completeSchedulePublication({
              id: row.id,
              workspaceId: row.workspace_id,
              facebookPostId: postId,
              avatarJobId: row.avatar_job_id,
              status: "scheduled",
              scheduledFor: row.scheduled_for,
            });
            if (!completion) continue;
            await deleteCompletedAvatar(completion.media_url, completion.avatar_blob_url);
            await recordScheduleEvent({
              workspaceId: row.workspace_id,
              scheduledPostId: row.id,
              newsItemId: row.news_item_id,
              event: "published",
              source: "scheduler",
              facebookPostId: postId,
              metadata: { kind: row.kind, executor: "facebook", viaQueue: true },
            });
            const queueCopy = scheduledOutcomeCopy(row.kind, true);
            await notifyWorkspace({
              workspaceId: row.workspace_id,
              type: "scheduled_publish_success",
              title: queueCopy.title,
              body: queueCopy.body,
              link: `/calendar?post=${row.id}`,
            });
          } else {
            const failed = await markNativeFailed(
              row,
              "The item was removed from Facebook before its scheduled time."
            );
            if (!failed) continue;
          }
          synced++;
          continue;
        }
        // held === true (still queued) or null (edge unreadable) — fall
        // through to the grace check below.
      }

      // Still unpublished. If it is well past its slot, Facebook is not going
      // to publish it — surface that instead of leaving it queued forever.
      const graceMinutes = NATIVE_GRACE_MINUTES[row.kind] ?? 60;
      const slot = new Date(row.scheduled_for).getTime();
      const overdueBy = Date.now() - slot;
      if (overdueBy > graceMinutes * 60_000) {
        if (
          await markNativeFailed(
            row,
            "Facebook did not publish this item at its scheduled time."
          )
        ) {
          synced++;
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          route: "schedule-sync",
          event: "failed",
          scheduledPostId: row.id,
          kind: row.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  return synced;
}

/**
 * YouTube is the executor for videos uploaded with `status.publishAt` — it
 * keeps them Private until the slot, then flips them public. The probe reads
 * exactly that flag; still private well past the slot means the video never
 * went out (processing failure, removed in Studio) and is surfaced as failed.
 * Inconclusive probes (non-OK or malformed responses) stay retryable — they
 * must never record a failure, because the video may already be public.
 */
async function syncYouTubeSchedule(row: NativeRow): Promise<number> {
  const videoId = row.facebook_post_id;
  if (!videoId) {
    await markNativeFailed(row, "YouTube did not return an id for this upload.");
    return 1;
  }

  const overdueBy = Date.now() - new Date(row.scheduled_for).getTime();

  let connection;
  try {
    connection = await resolvePlatformAccount(row.workspace_id, "youtube");
  } catch (error) {
    return backOffYouTubeProbe(row, error, overdueBy);
  }
  if (!connection) {
    await markNativeFailed(row, "The YouTube connection is gone. Reconnect YouTube.");
    return 1;
  }

  let token: string;
  let status: Awaited<ReturnType<typeof fetchYouTubeVideoStatus>>;
  try {
    token = await ensureFreshYouTubeToken(connection, row.workspace_id);
    status = await fetchYouTubeVideoStatus(videoId, token);
  } catch (error) {
    return backOffYouTubeProbe(row, error, overdueBy);
  }

  if (status.privacyStatus === "public") {
    const completion = await completeSchedulePublication({
      id: row.id,
      workspaceId: row.workspace_id,
      facebookPostId: videoId,
      avatarJobId: row.avatar_job_id,
      status: "scheduled",
      scheduledFor: row.scheduled_for,
    });
    if (!completion) return 0;
    await deleteCompletedAvatar(completion.media_url, completion.avatar_blob_url);
    await recordScheduleEvent({
      workspaceId: row.workspace_id,
      scheduledPostId: row.id,
      newsItemId: row.news_item_id,
      event: "published",
      source: "scheduler",
      facebookPostId: videoId,
      metadata: { kind: row.kind, executor: "youtube" },
    });
    const youtubeCopy = scheduledOutcomeCopy(row.kind, true);
    await notifyWorkspace({
      workspaceId: row.workspace_id,
      type: "scheduled_publish_success",
      title: youtubeCopy.title,
      body: youtubeCopy.body,
      link: `/calendar?post=${row.id}`,
    });
    return 1;
  }

  if (status.privacyStatus === null) {
    // Non-OK or malformed response — the answer is unknown, and the video
    // may already be public. An inconclusive probe never records a failure:
    // back off and retry on a later sweep.
    await bumpYouTubeRetryMarker(row);
    console.error(
      JSON.stringify({
        route: "schedule-sync",
        event: "probe_failed",
        scheduledPostId: row.id,
        kind: row.kind,
        source: "youtube",
        error: "inconclusive probe response",
      })
    );
    return 0;
  }

  // Confirmed still non-public. Past the grace window YouTube is not going
  // to publish it — surface that instead of leaving it queued forever.
  if (overdueBy > YOUTUBE_GRACE_MINUTES * 60_000) {
    return (await markNativeFailed(
      row,
      "YouTube did not publish this video at its scheduled time."
    ))
      ? 1
      : 0;
  }
  return 0;
}

/**
 * A YouTube probe failed transiently (token refresh, network). Bump
 * `updated_at` so the row skips the sweep's 2-minute staleness gate —
 * otherwise the same row would occupy the sweep's LIMIT 10 slot every run
 * and starve the rows behind it. The bump is best-effort: a failed marker
 * must not abort the rest of the sweep. Only `scheduled` native rows read
 * `updated_at` this way (the publish claim filters `source='local'`), so
 * publish timing is unaffected.
 */
async function backOffYouTubeProbe(
  row: NativeRow,
  error: unknown,
  overdueBy: number
): Promise<number> {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  console.error(
    JSON.stringify({
      route: "schedule-sync",
      event: "probe_failed",
      scheduledPostId: row.id,
      kind: row.kind,
      source: "youtube",
      error: message,
    })
  );

  // Broken well past the slot, sweep after sweep — surface it rather than
  // leave the row queued forever with a connection that never answers.
  if (overdueBy > YOUTUBE_GRACE_MINUTES * 60_000) {
    return (await markNativeFailed(row, `YouTube could not be probed: ${message}`))
      ? 1
      : 0;
  }

  await bumpYouTubeRetryMarker(row);
  return 0;
}

/** Best-effort retry marker — see backOffYouTubeProbe. */
async function bumpYouTubeRetryMarker(row: NativeRow): Promise<void> {
  try {
    await sql`
      UPDATE scheduled_posts
      SET updated_at = now()
      WHERE id = ${row.id} AND status = 'scheduled'`;
  } catch {
    // The marker only delays the next probe; never fail the sweep for it.
  }
}

async function markNativeFailed(
  row: NativeRow,
  reason: string
): Promise<boolean> {
  const updated = (await sql`
    UPDATE scheduled_posts
    SET status = 'failed', error_message = ${reason}, updated_at = now()
    WHERE id = ${row.id} AND status = 'scheduled'
      AND scheduled_for = ${row.scheduled_for}
    RETURNING id`) as unknown as { id: number }[];

  if (!updated.length) return false;

  await recordScheduleEvent({
    workspaceId: row.workspace_id,
    scheduledPostId: row.id,
    newsItemId: row.news_item_id,
    event: "failed",
    source: "scheduler",
    facebookPostId: row.facebook_post_id,
    errorMessage: reason,
    metadata: { kind: row.kind, executor: row.source },
  });
  const failedCopy = scheduledOutcomeCopy(row.kind, false, reason);
  await notifyWorkspace({
    workspaceId: row.workspace_id,
    type: "scheduled_publish_failed",
    title: failedCopy.title,
    body: failedCopy.body,
    link: `/calendar?post=${row.id}`,
  });
  return true;
}

/**
 * Whether a scheduled item is live. Each kind of item lives on a different
 * kind of Graph node, so try the matching shape first and fall back to the
 * others rather than reporting "unknown" when a node exposes a different
 * field set than expected.
 */
async function detectPublished(
  kind: string,
  id: string,
  token: string
): Promise<boolean | null> {
  const attempts: Array<() => Promise<boolean | null>> =
    kind === "reel" || kind === "video"
      ? [
          () => isFacebookVideoPublished(id, token),
          () => isFacebookPostPublished(id, token),
        ]
      : kind === "live"
        ? [
            () => isFacebookLiveStarted(id, token),
            // Fallback: some live videos appear as video posts after ending
            () => isFacebookVideoPublished(id, token),
            () => isFacebookPostPublished(id, token),
          ]
        : [
            () => isFacebookPostPublished(id, token),
            () => isFacebookVideoPublished(id, token),
          ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result !== null) return result;
    } catch {
      // Try the next shape.
    }
  }

  return null;
}
