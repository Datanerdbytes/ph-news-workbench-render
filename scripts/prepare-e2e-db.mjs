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
//   6. the Facebook connection — the publish pages render their composer
//                        only when the workspace has a connected Page.
//
// The migrations are not transactional and a couple of them swallow their
// errors, so the end state is verified instead of trusted.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
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

/**
 * The same envelope lib/facebook-token.ts writes: AES-256-GCM under an
 * HKDF-derived key, tagged with the secret name. A seeded Page token has to
 * be readable by the container, which runs with the same BETTER_AUTH_SECRET.
 */
function encryptSecret(secret, info) {
  const master = process.env.BETTER_AUTH_SECRET;
  if (!master) {
    throw new Error(
      "BETTER_AUTH_SECRET is required — the container has to read the seeded token",
    );
  }
  const key = Buffer.from(
    hkdfSync("sha256", master, "ph-news-workbench", info, 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
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

// The publish pages (and the composer they wrap) only render when the
// workspace has a connected Facebook Page — /api/facebook/status reports
// "connected" from this row alone. The token is a dummy: the suite never
// publishes, it only needs the composer on screen.
const pageToken = encryptSecret("e2e-dummy-page-token", "facebook-page-token");
await sql`
  INSERT INTO facebook_connections
    (workspace_id, user_id, page_id, page_name, access_token, scopes, connected_at, updated_at)
  VALUES (${workspaceId}, ${owner.id}, 'e2e-page-id', 'E2E Test Page', ${pageToken},
          'pages_show_list,pages_manage_posts', now(), now())
  ON CONFLICT (workspace_id) DO NOTHING`;
console.log("→ facebook connection");

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
