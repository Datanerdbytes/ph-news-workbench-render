import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./env";

let client: ReturnType<typeof neon> | null = null;

function db() {
  if (!client) client = neon(requireEnv("DATABASE_URL"));
  return client;
}

const SEED_MARKER = "Regression seed";

/** The seeded owner and their workspace. */
async function ownerContext() {
  const sql = db();
  const rows = (await sql`
    SELECT w.id AS workspace_id, wm.user_id
    FROM workspaces w
    JOIN workspace_members wm
      ON wm.workspace_id = w.id AND wm.role = 'owner'
    ORDER BY w.created_at
    LIMIT 1
  `) as unknown as { workspace_id: string; user_id: string }[];
  return rows[0];
}

/** Insert unread notifications for every member of the first workspace. */
export async function seedNotifications(count = 2): Promise<void> {
  const sql = db();
  const workspace = (
    (await sql`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`) as unknown as {
      id: string;
    }[]
  )[0];
  const members = (await sql`
    SELECT user_id FROM workspace_members WHERE workspace_id = ${workspace.id}`) as unknown as {
    user_id: string;
  }[];

  for (const member of members) {
    for (let index = 0; index < count; index++) {
      const title = `${SEED_MARKER} ${index + 1}`;
      await sql`
        INSERT INTO notifications (workspace_id, user_id, type, title, body, link)
        VALUES (${workspace.id}, ${member.user_id}, 'scheduled_publish_success',
                ${title}, 'Seeded by the regression suite.', '/calendar')`;
    }
  }
}

/** Remove exactly what seedNotifications wrote. */
export async function clearSeededNotifications(): Promise<void> {
  await db()`DELETE FROM notifications WHERE title LIKE ${`${SEED_MARKER}%`}`;
}

/** The lockout spec locks a throwaway email — never leave it locked. */
export async function clearSignInLock(email: string): Promise<void> {
  await db()`DELETE FROM sign_in_locks WHERE email = ${email}`;
}

/**
 * Seed two published posts: one linked to a published draft (the same
 * publish written down twice) and one with no draft at all. The workspace
 * total must count them as two publishes, not three.
 */
export async function seedPublishedPublishes(): Promise<void> {
  const sql = db();
  const owner = await ownerContext();

  const drafts = (await sql`
    INSERT INTO drafts
      (workspace_id, user_id, text, model, input_tokens, output_tokens,
       estimated_cost, status, correlation_id)
    VALUES
      (${owner.workspace_id}, ${owner.user_id}, ${SEED_MARKER}, 'seed',
       0, 0, 0, 'published', ${randomUUID()})
    RETURNING id
  `) as unknown as { id: number }[];

  await sql`
    INSERT INTO scheduled_posts
      (workspace_id, text, scheduled_for, status, kind, source, created_by, draft_id)
    VALUES
      (${owner.workspace_id}, ${SEED_MARKER}, now(), 'published', 'post',
       'local', ${owner.user_id}, ${drafts[0].id}),
      (${owner.workspace_id}, ${SEED_MARKER}, now(), 'published', 'post',
       'local', ${owner.user_id}, NULL)
  `;
}

/** Remove exactly what seedPublishedPublishes wrote. */
export async function clearSeededPublishes(): Promise<void> {
  const sql = db();
  await sql`DELETE FROM scheduled_posts WHERE text = ${SEED_MARKER}`;
  await sql`DELETE FROM drafts WHERE text = ${SEED_MARKER}`;
}
