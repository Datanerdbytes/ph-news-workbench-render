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
  // Two concurrent cancellations of schedules sharing one avatar must not
  // both pass the NOT EXISTS guard: each SQL statement fixes its own READ
  // COMMITTED snapshot, so two simultaneous deletes can each still see the
  // other's schedule and both skip the release — leaving the avatar
  // 'scheduled' with no referencing row. Locking the avatar row in an
  // earlier statement of the same transaction serializes the cancellations;
  // the delete+release statement then snapshots after the loser committed,
  // so its NOT EXISTS sees the removed schedule and exactly one of them
  // releases the avatar. (The schedule row itself is still claimed in the
  // delete statement, so a stale claim cannot delete or release anything.)
  const results = await sql.transaction(
    [
      sql`SELECT id FROM avatar_jobs
        WHERE id = (
          SELECT avatar_job_id FROM scheduled_posts
          WHERE id = ${input.id} AND workspace_id = ${input.workspaceId}
        )
        AND workspace_id = ${input.workspaceId}
        FOR UPDATE`,
      sql`
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
    SELECT id, news_item_id, scheduled_for, avatar_job_id FROM deleted`,
    ],
    { isolationLevel: "ReadCommitted" },
  );
  const rows = results[
    results.length - 1
  ] as unknown as CanceledScheduledPost[];
  return rows[0] ?? null;
}
