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
 * Seed three published posts: two linked to the same published draft (the
 * same draft published twice) and one with no draft at all. The workspace
 * total must count them as three publishes — counting the linked posts as
 * rows instead of distinct drafts would report two.
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

/**
 * Seed a live_streams row the pump guard tests can target: `source_url` is
 * NULL, so POST /api/live/[id]/pump must refuse to start — the guard fires
 * before any yt-dlp/ffmpeg process could ever spawn. `status` defaults to
 * ENDED so no Facebook refresh path touches the row (loadRows only refreshes
 * non-ended streams, and the suite never sends ?refresh=1); a live status
 * makes the card render its pump controls for the UI assertions instead.
 */
export async function seedSourcelessLiveStream(
  status = "ENDED"
): Promise<{ id: number; title: string }> {
  const sql = db();
  const owner = await ownerContext();
  const title = `${SEED_MARKER} live broadcast (${status.toLowerCase()})`;
  const rows = (await sql`
    INSERT INTO live_streams
      (workspace_id, facebook_video_id, title, description, status, created_by)
    VALUES
      (${owner.workspace_id}, ${`e2e-pump-${randomUUID()}`}, ${title},
       'Seeded by the regression suite.', ${status}, ${owner.user_id})
    RETURNING id, title
  `) as unknown as { id: number; title: string }[];
  return rows[0];
}

/** Remove exactly what seedSourcelessLiveStream wrote. */
export async function clearSeededLiveStreams(): Promise<void> {
  await db()`DELETE FROM live_streams WHERE title LIKE ${`${SEED_MARKER}%`}`;
}

const SOURCES_FEED_HOST = "https://e2e-sources.test/";

/**
 * Seed two feeds with stories on both sides of Manila day/month boundaries,
 * plus RSS metadata and an undated item for Sources filter coverage. All rows
 * are namespaced under e2e-sources.test for cleanup.
 */
export async function seedSourcesRedesignData(): Promise<{
  vergeFeedId: number;
  soloFeedId: number;
  today: string;
  previousDay: string;
  previousMonth: string;
}> {
  const sql = db();
  const owner = await ownerContext();
  const runId = randomUUID();
  const manilaDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = manilaDay.format(new Date());
  const [year, month] = today.split("-").map(Number);
  const previousMonth = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
  const dayStart = new Date(`${today}T00:00:00+08:00`);
  const nextDay = new Date(dayStart.getTime() + 86_400_000);
  const previousDay = manilaDay.format(new Date(dayStart.getTime() - 86_400_000));

  const feeds = (await sql`
    INSERT INTO feeds (workspace_id, url, title, category, enabled)
    VALUES
      (${owner.workspace_id}, ${`${SOURCES_FEED_HOST}verge/rss.xml`}, 'E2E Verge', 'Tech', true),
      (${owner.workspace_id}, ${`${SOURCES_FEED_HOST}solo/rss.xml`}, 'E2E Solo', NULL, true)
    RETURNING id
  `) as unknown as { id: number }[];
  const [vergeFeedId, soloFeedId] = feeds.map((feed) => feed.id);

  await sql`
    INSERT INTO news_items
      (feed_id, workspace_id, guid, link, title, summary, image_url,
       published_at, created_at, raw_payload, dedup_hash)
    VALUES
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-1`},
       ${`${SOURCES_FEED_HOST}one`}, 'E2E sources story one',
       'Discusses flood resilience and evacuation plans.',
       ${`${SOURCES_FEED_HOST}img/one.jpg`}, ${dayStart.toISOString()}, ${dayStart.toISOString()},
       ${JSON.stringify({ creator: "Maria Santos", categories: ["Climate", "Metro Manila"] })},
       ${`e2e-${runId}-h1`}),
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-2`},
       ${`${SOURCES_FEED_HOST}two`}, 'E2E sources story two', NULL,
       NULL, ${new Date(nextDay.getTime() - 1).toISOString()}, ${dayStart.toISOString()},
       ${JSON.stringify({ author: "Liza Reyes", categories: ["Breaking"] })},
       ${`e2e-${runId}-h2`}),
      (${soloFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-3`},
       ${`${SOURCES_FEED_HOST}three`}, 'E2E solo story', 'Seeded solo summary.',
       NULL, ${new Date(dayStart.getTime() + 12 * 3_600_000).toISOString()}, ${dayStart.toISOString()},
       NULL, ${`e2e-${runId}-h3`}),
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-4`},
       ${`${SOURCES_FEED_HOST}yesterday`}, 'E2E yesterday story', 'Previous Manila day.',
       NULL, ${new Date(dayStart.getTime() - 1).toISOString()}, ${dayStart.toISOString()},
       NULL, ${`e2e-${runId}-h4`}),
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-5`},
       ${`${SOURCES_FEED_HOST}tomorrow`}, 'E2E tomorrow story', 'Next Manila day.',
       NULL, ${nextDay.toISOString()}, ${dayStart.toISOString()},
       NULL, ${`e2e-${runId}-h5`}),
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-6`},
       ${`${SOURCES_FEED_HOST}previous-month`}, 'E2E previous month story',
       'A policy story from the previous month.', NULL,
       ${new Date(`${previousMonth}-15T12:00:00+08:00`).toISOString()}, ${dayStart.toISOString()},
       ${JSON.stringify({ creator: "Juan Dela Cruz", categories: ["Politics"] })},
       ${`e2e-${runId}-h6`}),
      (${vergeFeedId}, ${owner.workspace_id}, ${`e2e-${runId}-7`},
       ${`${SOURCES_FEED_HOST}undated`}, 'E2E undated story', 'No publication date.',
       NULL, NULL, ${dayStart.toISOString()}, NULL, ${`e2e-${runId}-h7`})
  `;

  return { vergeFeedId, soloFeedId, today, previousDay, previousMonth };
}

/** Remove exactly what seedSourcesRedesignData wrote. */
export async function clearSeededSourcesRedesignData(): Promise<void> {
  const sql = db();
  await sql`DELETE FROM news_items WHERE link LIKE ${`${SOURCES_FEED_HOST}%`}`;
  await sql`DELETE FROM feeds WHERE url LIKE ${`${SOURCES_FEED_HOST}%`}`;
}

/** The columns live_streams carries, as reported by information_schema. */
export async function liveStreamsColumns(): Promise<string[]> {
  const rows = (await db()`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'live_streams'
  `) as unknown as { column_name: string }[];
  return rows.map((row) => row.column_name);
}
