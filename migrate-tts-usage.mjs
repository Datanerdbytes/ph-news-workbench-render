import { config } from "dotenv";

config();
config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS tts_usage_daily (
    day DATE NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
    characters INTEGER NOT NULL DEFAULT 0 CHECK (characters >= 0),
    PRIMARY KEY (day, workspace_id)
  )`;

console.log(JSON.stringify({ migrated: "tts-usage" }));
