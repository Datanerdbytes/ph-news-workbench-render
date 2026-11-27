import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { TtsVoiceId } from "@/lib/tts/voices";
import { getAvatar, type AvatarId } from "./avatars";
import { avatarLimits, estimateAvatarSeconds } from "./config";
import {
  ACTIVE_AVATAR_STATUSES,
  type AvatarJobRow,
  type AvatarJobStatus,
} from "./jobs";

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 20;

export class AvatarQueueError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AvatarQueueError";
  }
}

type EnqueueInput = {
  workspaceId: string;
  userId: string;
  avatarId: AvatarId;
  voiceId: TtsVoiceId;
  speed: number;
  text: string;
};

type JobOwner = Pick<AvatarJobRow, "id" | "workspace_id" | "attempts"> & {
  worker_id: string | null;
};

export async function enqueueAvatarJob(input: EnqueueInput): Promise<AvatarJobRow> {
  const id = randomUUID();
  const avatar = getAvatar(input.avatarId);
  const estimatedSeconds = estimateAvatarSeconds(input.text, input.speed);
  const limits = avatarLimits();
  const results = await sql.transaction(
    [
      sql`SELECT id FROM workspaces WHERE id = ${input.workspaceId} FOR UPDATE`,
      sql`
        WITH active AS (
          SELECT count(*)::int AS count
          FROM avatar_jobs
          WHERE workspace_id = ${input.workspaceId}
            AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
        ), reserved AS (
          INSERT INTO avatar_usage_daily
            (day, workspace_id, jobs, characters, seconds_reserved)
          -- Derive the accounting day from the database clock, not the app
          -- clock: completion and release settle against the job's
          -- created_at (also converted to UTC), so a request that crosses
          -- UTC midnight must still reserve and settle on the same day.
          SELECT (now() AT TIME ZONE 'utc')::date, ${input.workspaceId}, 1, ${input.text.length}, ${estimatedSeconds}
          FROM active
          WHERE (SELECT count FROM active) < ${limits.maxActive}
            AND ${limits.dailyJobs} > 0
            AND ${estimatedSeconds} <= ${limits.dailySeconds}
          ON CONFLICT (day, workspace_id) DO UPDATE
          SET jobs = avatar_usage_daily.jobs + 1,
              characters = avatar_usage_daily.characters + ${input.text.length},
              seconds_reserved = avatar_usage_daily.seconds_reserved + ${estimatedSeconds}
          WHERE avatar_usage_daily.jobs < ${limits.dailyJobs}
            AND avatar_usage_daily.seconds_reserved + avatar_usage_daily.seconds_actual + ${estimatedSeconds} <= ${limits.dailySeconds}
            AND (SELECT count FROM active) < ${limits.maxActive}
          RETURNING workspace_id
        ), inserted AS (
          INSERT INTO avatar_jobs
            (id, workspace_id, user_id, avatar_id, avatar_kind, avatar_style,
             voice_id, speed, text, characters, estimated_seconds)
          SELECT ${id}, ${input.workspaceId}, ${input.userId}, ${avatar.id},
                 ${avatar.kind}, ${avatar.style}, ${input.voiceId}, ${input.speed},
                 ${input.text}, ${input.text.length}, ${estimatedSeconds}
          FROM reserved
          RETURNING *
        )
        SELECT * FROM inserted`,
    ],
    { isolationLevel: "ReadCommitted" },
  );
  const rows = results[1] as unknown as AvatarJobRow[];
  if (!rows.length) {
    throw new AvatarQueueError(
      429,
      "quota_exceeded",
      "The daily avatar allowance or active-job limit has been reached. Try again later.",
    );
  }
  return rows[0];
}

export async function getAvatarJob(
  id: string,
  workspaceId: string,
): Promise<AvatarJobRow | null> {
  const rows = (await sql`
    SELECT * FROM avatar_jobs
    WHERE id = ${id} AND workspace_id = ${workspaceId}`) as unknown as AvatarJobRow[];
  return rows[0] ?? null;
}

export async function claimNextAvatarJob(workerId: string): Promise<AvatarJobRow | null> {
  const rows = (await sql`
    UPDATE avatar_jobs
    SET status = 'submitting', worker_id = ${workerId}, attempts = attempts + 1,
        progress = 0.05, status_message = 'Preparing the avatar…',
        error = NULL, updated_at = now()
    WHERE id = (
      SELECT id FROM avatar_jobs
      WHERE status = 'queued' AND attempts < ${MAX_ATTEMPTS}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`) as unknown as AvatarJobRow[];
  return rows[0] ?? null;
}

export async function recordAvatarSubmission(job: JobOwner): Promise<boolean> {
  const rows = (await sql`
    UPDATE avatar_jobs
    SET provider_synthesis_id = id, updated_at = now()
    WHERE id = ${job.id} AND worker_id = ${job.worker_id}
      AND attempts = ${job.attempts} AND status = 'submitting'
      AND provider_synthesis_id IS NULL
    RETURNING id`) as unknown as { id: string }[];
  return rows.length > 0;
}

export async function updateAvatarJob(
  job: JobOwner,
  status: Extract<AvatarJobStatus, "submitting" | "running" | "downloading" | "finalizing">,
  progress: number,
  statusMessage: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE avatar_jobs
    SET status = ${status}, progress = ${progress}, status_message = ${statusMessage},
        updated_at = now()
    WHERE id = ${job.id} AND worker_id = ${job.worker_id}
      AND attempts = ${job.attempts}
      AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
    RETURNING id`) as unknown as { id: string }[];
  return rows.length > 0;
}

export async function heartbeatAvatarJob(job: JobOwner): Promise<boolean> {
  const rows = (await sql`
    UPDATE avatar_jobs SET updated_at = now()
    WHERE id = ${job.id} AND worker_id = ${job.worker_id}
      AND attempts = ${job.attempts}
      AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
    RETURNING id`) as unknown as { id: string }[];
  return rows.length > 0;
}

export async function completeAvatarJob(
  job: JobOwner,
  result: { blobUrl: string; fileSize: number; durationSeconds: number },
): Promise<boolean> {
  const actualSeconds = Math.max(1, Math.ceil(result.durationSeconds));
  const results = await sql`
    WITH finished AS (
      UPDATE avatar_jobs
      SET status = 'completed', progress = 1, status_message = 'Avatar video is ready.',
          blob_url = ${result.blobUrl}, file_size = ${result.fileSize},
          duration_seconds = ${result.durationSeconds}, error = NULL,
          worker_id = NULL, updated_at = now()
      WHERE id = ${job.id} AND workspace_id = ${job.workspace_id}
        AND worker_id = ${job.worker_id} AND attempts = ${job.attempts}
        AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
        AND cancel_requested = false
      RETURNING workspace_id, (created_at AT TIME ZONE 'utc')::date AS day, estimated_seconds
    ), accounted AS (
      UPDATE avatar_usage_daily usage
      SET seconds_reserved = GREATEST(0, usage.seconds_reserved - finished.estimated_seconds),
          seconds_actual = usage.seconds_actual + ${actualSeconds}
      FROM finished
      WHERE usage.workspace_id = finished.workspace_id AND usage.day = finished.day
    )
    SELECT * FROM finished`;
  return results.length > 0;
}

export async function failAvatarJob(
  job: JobOwner,
  error: { message: string; retryable: boolean },
): Promise<"queued" | "failed" | "cancelled" | null> {
  const results = await sql`
    WITH finished AS (
      UPDATE avatar_jobs
      SET status = CASE
            WHEN cancel_requested THEN 'cancelled'
            WHEN ${error.retryable} AND attempts < ${MAX_ATTEMPTS} THEN 'queued'
            ELSE 'failed'
          END,
          progress = CASE WHEN cancel_requested OR NOT ${error.retryable} OR attempts >= ${MAX_ATTEMPTS}
            THEN NULL ELSE progress END,
          status_message = CASE
            WHEN cancel_requested THEN 'Avatar generation cancelled.'
            WHEN ${error.retryable} AND attempts < ${MAX_ATTEMPTS} THEN 'Retrying avatar generation…'
            ELSE 'Avatar generation failed.'
          END,
          error = CASE WHEN ${error.retryable} AND attempts < ${MAX_ATTEMPTS}
            AND NOT cancel_requested THEN NULL ELSE ${error.message} END,
          worker_id = NULL, updated_at = now()
      WHERE id = ${job.id} AND worker_id = ${job.worker_id}
        AND attempts = ${job.attempts}
        AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
      RETURNING *, (created_at AT TIME ZONE 'utc')::date AS day
    ), released AS (
      UPDATE avatar_usage_daily usage
      SET seconds_reserved = GREATEST(0, usage.seconds_reserved - finished.estimated_seconds)
      FROM finished
      WHERE usage.workspace_id = finished.workspace_id AND usage.day = finished.day
        AND finished.status IN ('failed', 'cancelled')
        AND finished.provider_synthesis_id IS NULL
    )
    SELECT status FROM finished`;
  const rows = results as unknown as { status: "queued" | "failed" | "cancelled" }[];
  return rows[0]?.status ?? null;
}

export async function requestAvatarCancellation(
  id: string,
  workspaceId: string,
): Promise<AvatarJobRow | null> {
  const results = await sql`
    WITH cancelled AS (
      UPDATE avatar_jobs
      SET cancel_requested = true,
          status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
          status_message = CASE WHEN status = 'queued' THEN 'Avatar generation cancelled.' ELSE status_message END,
          worker_id = CASE WHEN status = 'queued' THEN NULL ELSE worker_id END,
          updated_at = now()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
        AND status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])
        AND publish_state = 'ready'
      RETURNING *, (created_at AT TIME ZONE 'utc')::date AS day
    ), released AS (
      UPDATE avatar_usage_daily usage
      SET seconds_reserved = GREATEST(0, usage.seconds_reserved - cancelled.estimated_seconds)
      FROM cancelled
      WHERE usage.workspace_id = cancelled.workspace_id AND usage.day = cancelled.day
        AND cancelled.status = 'cancelled' AND cancelled.provider_synthesis_id IS NULL
    )
    SELECT * FROM cancelled`;
  const rows = results as unknown as AvatarJobRow[];
  return rows[0] ?? null;
}

export async function removeAvatarJob(
  id: string,
  workspaceId: string,
): Promise<{ blobUrl: string | null; providerSynthesisId: string | null } | null> {
  const rows = (await sql`
    DELETE FROM avatar_jobs
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND status IN ('completed', 'failed', 'cancelled')
      AND publish_state = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_posts WHERE avatar_job_id = avatar_jobs.id
      )
    RETURNING blob_url, provider_synthesis_id`) as unknown as Array<{
    blob_url: string | null;
    provider_synthesis_id: string | null;
  }>;
  if (!rows.length) return null;
  return {
    blobUrl: rows[0].blob_url,
    providerSynthesisId: rows[0].provider_synthesis_id,
  };
}

export async function recoverStaleAvatarJobs(): Promise<
  Array<{ id: string; provider_synthesis_id: string | null }>
> {
  const rows = (await sql`
    WITH recovered AS (
      UPDATE avatar_jobs
      SET status = CASE
            WHEN cancel_requested THEN 'cancelled'
            WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed'
            ELSE 'queued'
          END,
          status_message = CASE
            WHEN cancel_requested THEN 'Avatar generation cancelled.'
            WHEN attempts >= ${MAX_ATTEMPTS} THEN 'Avatar generation stopped responding.'
            ELSE 'Resuming avatar generation…'
          END,
          error = CASE WHEN NOT cancel_requested AND attempts < ${MAX_ATTEMPTS} THEN NULL
            ELSE 'Avatar generation stopped responding.' END,
          worker_id = NULL, updated_at = now()
      WHERE status IN ('submitting', 'running', 'downloading', 'finalizing')
        AND updated_at < now() - ${STALE_MINUTES} * interval '1 minute'
      RETURNING *, (created_at AT TIME ZONE 'utc')::date AS day
    ), releasable AS (
      SELECT workspace_id, day, SUM(estimated_seconds)::int AS seconds
      FROM recovered
      WHERE status IN ('failed', 'cancelled')
        AND provider_synthesis_id IS NULL
      GROUP BY workspace_id, day
    ), released AS (
      UPDATE avatar_usage_daily usage
      SET seconds_reserved = GREATEST(0, usage.seconds_reserved - releasable.seconds)
      FROM releasable
      WHERE usage.workspace_id = releasable.workspace_id AND usage.day = releasable.day
    )
    SELECT id, provider_synthesis_id FROM recovered`) as unknown as Array<{
    id: string;
    provider_synthesis_id: string | null;
  }>;
  return rows;
}

export async function claimAvatarForPublish(
  id: string,
  workspaceId: string,
  videoUrl: string,
  allowComposite = false,
): Promise<string | null> {
  const rows = (await sql`
    UPDATE avatar_jobs SET publish_state = 'publishing', updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND status = 'completed' AND publish_state = 'ready' AND blob_url IS NOT NULL
      ${allowComposite ? sql`` : sql`AND blob_url = ${videoUrl}`}
    RETURNING blob_url`) as unknown as { blob_url: string }[];
  return rows[0]?.blob_url ?? null;
}

export async function releaseAvatarPublish(id: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE avatar_jobs SET publish_state = 'ready', updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND publish_state = 'publishing'`;
}

export async function finishAvatarPublish(
  id: string,
  workspaceId: string,
  scheduledPostId: number,
): Promise<boolean> {
  const rows = (await sql`
    WITH mirrored AS (
      SELECT id FROM scheduled_posts
      WHERE id = ${scheduledPostId} AND workspace_id = ${workspaceId}
        AND avatar_job_id = ${id} AND status = 'published'
    )
    UPDATE avatar_jobs SET publish_state = 'published', updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND publish_state = 'publishing' AND EXISTS (SELECT 1 FROM mirrored)
    RETURNING id`) as unknown as { id: string }[];
  return rows.length > 0;
}

/** Release a canceled schedule only after its referencing row is gone. */
export async function releaseScheduledAvatar(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE avatar_jobs SET publish_state = 'ready', updated_at = now()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND status = 'completed' AND publish_state = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_posts WHERE avatar_job_id = avatar_jobs.id
      )
    RETURNING id`) as unknown as { id: string }[];
  return rows.length > 0;
}
