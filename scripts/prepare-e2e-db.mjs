// Provisions the E2E database from an empty schema.
//
// The order matters and is not the alphabetical order of the files:
//
//   1. migrate-auth.js — the Better Auth tables ("user", account, session,
//                        verification). schema.sql's foreign keys reference
//                        "user", so these come first.
//   2. lib/schema.sql  — the base schema. Every migration only ALTERs tables
//                        that this file creates, so without it the first
//                        ALTER fails on a missing relation.
//   3. seed-owner.js   — the owner account. migrate-user-scoping.mjs refuses
//                        to run without a user to backfill draft ownership to.
//   4. migrate-*.mjs   — the incremental migrations.
//   5. the workspace   — the app creates it lazily on first sign-in, but the
//                        suite seeds notifications before it loads a page.
//
// The migrations are not transactional and a couple of them swallow their
// errors, so the end state is verified instead of trusted.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(databaseUrl);

function statements(source) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function run(script) {
  execFileSync("node", [join(root, script)], {
    stdio: "inherit",
    env: process.env,
  });
}

run("migrate-auth.js");
console.log("→ migrate-auth.js");

const schema = readFileSync(join(root, "lib", "schema.sql"), "utf8");
for (const statement of statements(schema)) {
  await sql.unsafe(statement);
}
console.log("→ lib/schema.sql");

run("seed-owner.js");
console.log("→ seed-owner.js");

const migrations = readdirSync(root)
  .filter((file) => /^migrate-.*\.mjs$/.test(file))
  .sort();
for (const migration of migrations) {
  run(migration);
  console.log(`→ ${migration}`);
}

const ownerEmail = process.env.OWNER_EMAIL;
if (!ownerEmail) {
  throw new Error("OWNER_EMAIL is required — it is the account the suite signs in with");
}

const owners = await sql`SELECT id, name FROM "user" WHERE email = ${ownerEmail}`;
if (!owners.length) {
  throw new Error(`seed-owner.js did not create ${ownerEmail}`);
}

const owner = owners[0];
const workspaceId = `ws_${owner.id}`;
const workspaceName = owner.name?.trim()
  ? `${owner.name.trim()}'s workspace`
  : "Personal workspace";
await sql`
  INSERT INTO workspaces (id, name, owner_id)
  VALUES (${workspaceId}, ${workspaceName}, ${owner.id})
  ON CONFLICT (id) DO NOTHING`;
await sql`
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (${workspaceId}, ${owner.id}, 'owner')
  ON CONFLICT DO NOTHING`;
console.log(`→ workspace ${workspaceId}`);

const requiredTables = [
  "user",
  "account",
  "session",
  "verification",
  "sign_in_locks",
  "workspaces",
  "workspace_members",
  "workspace_invites",
  "user_preferences",
  "feeds",
  "news_items",
  "drafts",
  "scheduled_posts",
  "scheduled_post_events",
  "usage_daily",
  "facebook_connections",
  "facebook_pages",
  "youtube_connections",
  "tiktok_connections",
  "live_streams",
  "notifications",
  "download_jobs",
];

const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = current_schema()`;
const present = new Set(tables.map((row) => row.table_name));
const missing = requiredTables.filter((table) => !present.has(table));
if (missing.length) {
  throw new Error(`tables missing after the migrations: ${missing.join(", ")}`);
}

const requiredColumns = [
  ["drafts", "user_id"],
  ["drafts", "workspace_id"],
  ["feeds", "workspace_id"],
  ["news_items", "workspace_id"],
  ["facebook_connections", "workspace_id"],
  ["workspaces", "ai_model"],
];
for (const [table, column] of requiredColumns) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}`;
  if (!rows.length) {
    throw new Error(`${table}.${column} is missing after the migrations`);
  }
}

console.log(
  JSON.stringify({
    prepared: true,
    owner: ownerEmail,
    workspace: workspaceId,
    tables: present.size,
  })
);
