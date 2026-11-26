import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { recordScheduleEvent } from "@/lib/schedule-events";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const { id } = await params;
  const postId = Number(id);

  // Verify the post exists and belongs to this workspace
  const existing = (await sql`
    SELECT id, workspace_id, news_item_id, status, attempts, kind
    FROM scheduled_posts
    WHERE id = ${postId} AND workspace_id = ${access.workspace.id}
  `) as unknown as {
    id: number;
    workspace_id: string;
    news_item_id: number | null;
    status: string;
    attempts: number;
    kind: string;
  }[];

  const post = existing[0];
  if (!post) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (post.status !== "failed") {
    return NextResponse.json(
      { error: "Only failed posts can be retried." },
      { status: 400 }
    );
  }

  const retried = (await sql`
    WITH eligible AS (
      SELECT id, workspace_id, image_url, avatar_job_id
      FROM scheduled_posts
      WHERE id = ${postId} AND workspace_id = ${access.workspace.id}
        AND status = 'failed'
        AND facebook_post_id IS NULL
        AND publish_started_at IS NULL
      FOR UPDATE
    ), reclaimed_avatar AS (
      UPDATE avatar_jobs
      SET publish_state = 'scheduled', updated_at = now()
      FROM eligible
      WHERE avatar_jobs.id = eligible.avatar_job_id
        AND avatar_jobs.workspace_id = eligible.workspace_id
        AND avatar_jobs.status = 'completed'
        AND avatar_jobs.publish_state = 'scheduled'
        AND avatar_jobs.blob_url IS NOT NULL
        AND (
          avatar_jobs.blob_url = eligible.image_url
          OR (
            eligible.image_url IS NOT NULL
            AND strpos(eligible.image_url, '/compose/avatars/' || avatar_jobs.id || '/') > 0
          )
        )
      RETURNING avatar_jobs.id
    ), reset AS (
      UPDATE scheduled_posts AS scheduled
      SET status = 'scheduled', attempts = 0, error_message = NULL,
          publish_started_at = NULL, updated_at = now()
      FROM eligible
      WHERE scheduled.id = eligible.id
        AND (
          eligible.avatar_job_id IS NULL
          OR EXISTS (
            SELECT 1 FROM reclaimed_avatar
            WHERE reclaimed_avatar.id = eligible.avatar_job_id
          )
        )
      RETURNING scheduled.id
    )
    SELECT id FROM reset`) as unknown as { id: number }[];

  if (!retried.length) {
    return NextResponse.json(
      { error: "This post changed or its avatar is no longer available. Reload the calendar." },
      { status: 409 }
    );
  }

  // Record the retry event in activity log
  await recordScheduleEvent({
    workspaceId: access.workspace.id,
    scheduledPostId: postId,
    newsItemId: post.news_item_id,
    event: "retrying",
    source: "manual",
    actorUserId: access.user.id,
    metadata: { retriedBy: access.user.id, previousAttempts: post.attempts },
  });

  return NextResponse.json({ ok: true, status: "scheduled" });
}