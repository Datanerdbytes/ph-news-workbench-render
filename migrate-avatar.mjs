import { config } from "dotenv";

config();
config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS avatar_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    avatar_id TEXT NOT NULL,
    avatar_kind TEXT NOT NULL CHECK (avatar_kind IN ('video', 'photo')),
    avatar_style TEXT,
    voice_id TEXT NOT NULL,
    speed NUMERIC(4, 2) NOT NULL CHECK (speed BETWEEN 0.75 AND 1.25),
    text TEXT NOT NULL,
    characters INTEGER NOT NULL CHECK (characters > 0),
    estimated_seconds INTEGER NOT NULL CHECK (estimated_seconds > 0),
    provider_synthesis_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'submitting', 'running', 'downloading', 'finalizing', 'completed', 'failed', 'cancelled')),
    progress REAL CHECK (progress BETWEEN 0 AND 1),
    status_message TEXT NOT NULL DEFAULT '',
    blob_url TEXT,
    file_size BIGINT,
    duration_seconds REAL,
    error TEXT,
    worker_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    publish_state TEXT NOT NULL DEFAULT 'ready'
      CHECK (publish_state IN ('ready', 'publishing', 'scheduled', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS avatar_usage_daily (
    day DATE NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    jobs INTEGER NOT NULL DEFAULT 0 CHECK (jobs >= 0),
    characters INTEGER NOT NULL DEFAULT 0 CHECK (characters >= 0),
    seconds_reserved INTEGER NOT NULL DEFAULT 0 CHECK (seconds_reserved >= 0),
    seconds_actual INTEGER NOT NULL DEFAULT 0 CHECK (seconds_actual >= 0),
    PRIMARY KEY (day, workspace_id)
  )`;

await sql`
  ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS avatar_job_id TEXT REFERENCES avatar_jobs(id) ON DELETE RESTRICT`;

await sql`
  ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ`;

await sql`
  CREATE INDEX IF NOT EXISTS avatar_jobs_workspace_idx
  ON avatar_jobs (workspace_id, created_at DESC)`;

await sql`
  CREATE INDEX IF NOT EXISTS avatar_jobs_queue_idx
  ON avatar_jobs (status, created_at)`;

await sql`
  CREATE INDEX IF NOT EXISTS avatar_jobs_active_idx
  ON avatar_jobs (workspace_id, status)`;

await sql`
  CREATE INDEX IF NOT EXISTS scheduled_posts_avatar_idx
  ON scheduled_posts (avatar_job_id)`;

console.log(JSON.stringify({ migrated: "avatar" }));
