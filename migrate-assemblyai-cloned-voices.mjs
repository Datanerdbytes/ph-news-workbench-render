import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);

await sql`
  ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS assemblyai_voice_ids JSONB NOT NULL DEFAULT '[]'::jsonb`;

const rows = await sql`SELECT count(*)::int AS workspaces FROM workspaces`;
console.log(JSON.stringify({ migrated: "assemblyai-cloned-voices", ...rows[0] }));
