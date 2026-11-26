import { sql } from "@/lib/db";

export type CanceledScheduledPost = {
  id: number;
  news_item_id: number | null;
  scheduled_for: string;
  avatar_job_id: string | null;
};

export async function deleteScheduledPostWithAvatarRelease(input: {
  id: number | string;
  workspaceId: string;
  status: string;
  claim?: string;
}): Promise<CanceledScheduledPost | null> {
  const rows = (await sql`
    WITH deleted AS (
      DELETE FROM scheduled_posts
      WHERE id = ${input.id}
        AND workspace_id = ${input.workspaceId}
        AND (
          (${input.claim === undefined} AND status = ${input.status})
          OR (
            ${input.claim !== undefined}
            AND status = 'rescheduling'
            AND error_message = ${input.claim ?? null}
          )
        )
      RETURNING id, workspace_id, news_item_id, scheduled_for, avatar_job_id
    ), released AS (
      UPDATE avatar_jobs
      SET publish_state = 'ready', updated_at = now()
      FROM deleted
      WHERE avatar_jobs.id = deleted.avatar_job_id
        AND avatar_jobs.workspace_id = deleted.workspace_id
        AND avatar_jobs.status = 'completed'
        AND avatar_jobs.publish_state = 'scheduled'
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_posts
          WHERE scheduled_posts.avatar_job_id = avatar_jobs.id
            AND scheduled_posts.id <> deleted.id
        )
    )
    SELECT id, news_item_id, scheduled_for, avatar_job_id FROM deleted`) as unknown as CanceledScheduledPost[];
  return rows[0] ?? null;
}
