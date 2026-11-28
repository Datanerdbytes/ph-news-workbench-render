import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);

await sql`
  ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS tts_provider TEXT NOT NULL DEFAULT 'azure'`;

await sql`
  ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS assemblyai_api_key_encrypted TEXT`;

await sql`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_tts_provider_check'
    ) THEN
      ALTER TABLE workspaces
        ADD CONSTRAINT workspaces_tts_provider_check
        CHECK (tts_provider IN ('azure', 'assemblyai'));
    END IF;
  END
  $$`;

const rows = await sql`SELECT count(*)::int AS workspaces FROM workspaces`;
console.log(JSON.stringify({ migrated: "tts-provider", ...rows[0] }));
