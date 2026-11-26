import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type ScheduledPost = {
  id: number;
  workspace_id: string;
  news_item_id: number | null;
  draft_id: number | null;
  text: string;
  image_url: string | null;
  image_urls: unknown;
  kind: string;
  page_id: string | null;
  avatar_job_id: string | null;
  attempts: number;
};

describe.skipIf(!process.env.DATABASE_URL)("scheduled post claims", () => {
  let sql: typeof import("@/lib/db").sql;
  let claimScheduledPost: typeof import("@/lib/schedule-worker").claimScheduledPost;
  let markPublishStarted: typeof import("@/lib/schedule-worker").markPublishStarted;
  let requeueInterruptedPost: typeof import("@/lib/schedule-worker").requeueInterruptedPost;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/db"));
    ({
      claimScheduledPost,
      markPublishStarted,
      requeueInterruptedPost,
    } = await import("@/lib/schedule-worker"));
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email)
      VALUES (${userId}, ${`DB claim ${userId}`}, ${`${userId}@example.test`})`;
    await sql`
      INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`DB claim ${workspaceId}`}, ${userId})`;
  });

  afterEach(async () => {
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
  });

  async function createPost(input: {
    avatarJobId?: string | null;
    imageUrl?: string | null;
  } = {}): Promise<ScheduledPost> {
    const rows = await sql`
      INSERT INTO scheduled_posts
        (workspace_id, text, image_url, scheduled_for, created_by, avatar_job_id)
      VALUES
        (${workspaceId}, 'Database claim regression', ${input.imageUrl ?? null},
         now() - interval '1 minute', ${userId}, ${input.avatarJobId ?? null})
      RETURNING id, workspace_id, news_item_id, draft_id, text,
                image_url, image_urls, kind, page_id, avatar_job_id, attempts`;
    return rows[0] as unknown as ScheduledPost;
  }

  async function createAvatar(blobUrl: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO avatar_jobs
        (id, workspace_id, user_id, avatar_id, avatar_kind, voice_id, speed,
         text, characters, estimated_seconds, status, blob_url, publish_state)
      VALUES
        (${id}, ${workspaceId}, ${userId}, 'lisa', 'photo', 'en-US-AvaMultilingualNeural', 1,
         'Database claim regression', 24, 10, 'completed', ${blobUrl}, 'scheduled')`;
    return id;
  }

  it("claims a due post without an avatar", async () => {
    const post = await createPost();

    await expect(claimScheduledPost(post)).resolves.toEqual({
      id: post.id,
      attempts: 1,
    });

    const rows = await sql`
      SELECT status, attempts FROM scheduled_posts WHERE id = ${post.id}`;
    expect(rows[0]).toMatchObject({ status: "publishing", attempts: 1 });
  });

  it("claims a direct completed avatar post", async () => {
    const blobUrl = `https://media.example.test/${randomUUID()}/avatar.mp4`;
    const avatarJobId = await createAvatar(blobUrl);
    const post = await createPost({ avatarJobId, imageUrl: blobUrl });

    await expect(claimScheduledPost(post)).resolves.toEqual({
      id: post.id,
      attempts: 1,
    });
  });

  it("claims a completed avatar composite", async () => {
    const avatarJobId = await createAvatar(
      `https://media.example.test/${randomUUID()}/avatar.mp4`,
    );
    const imageUrl = `https://media.example.test/compose/avatars/${avatarJobId}/${randomUUID()}.mp4`;
    const post = await createPost({ avatarJobId, imageUrl });

    await expect(claimScheduledPost(post)).resolves.toEqual({
      id: post.id,
      attempts: 1,
    });
  });

  it("allows only one concurrent claimant", async () => {
    const post = await createPost();

    const claims = await Promise.all([
      claimScheduledPost(post),
      claimScheduledPost(post),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const rows = await sql`
      SELECT status, attempts FROM scheduled_posts WHERE id = ${post.id}`;
    expect(rows[0]).toMatchObject({ status: "publishing", attempts: 1 });
  });

  it("fences a stale publisher after a newer attempt reclaims the row", async () => {
    const post = await createPost();
    await expect(claimScheduledPost(post)).resolves.toMatchObject({ attempts: 1 });
    await expect(
      requeueInterruptedPost({ ...post, attempts: 1 }),
    ).resolves.toBe("scheduled");
    await expect(claimScheduledPost(post)).resolves.toMatchObject({ attempts: 2 });

    await expect(
      markPublishStarted(post.id, post.workspace_id, 1),
    ).rejects.toThrow("no longer owned");
    await expect(
      requeueInterruptedPost({ ...post, attempts: 1 }),
    ).resolves.toBeNull();

    const rows = await sql`
      SELECT status, attempts, publish_started_at
      FROM scheduled_posts WHERE id = ${post.id}`;
    expect(rows[0]).toMatchObject({ status: "publishing", attempts: 2 });
    expect(rows[0].publish_started_at).toBeNull();

    await markPublishStarted(post.id, post.workspace_id, 2);
    const marked = await sql`
      SELECT publish_started_at FROM scheduled_posts WHERE id = ${post.id}`;
    expect(marked[0].publish_started_at).not.toBeNull();
  });

  it("stores a video id atomically with its fenced publish marker", async () => {
    const post = await createPost();
    await claimScheduledPost(post);

    await markPublishStarted(post.id, post.workspace_id, 1, "video-1");

    const rows = await sql`
      SELECT facebook_post_id, publish_started_at
      FROM scheduled_posts WHERE id = ${post.id}`;
    expect(rows[0].facebook_post_id).toBe("video-1");
    expect(rows[0].publish_started_at).not.toBeNull();
  });

  it("never requeues a row after the publish marker wins the race", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const post = await createPost();
      await sql`
        UPDATE scheduled_posts SET status = 'publishing'
        WHERE id = ${post.id}`;

      const [requeued] = await Promise.all([
        requeueInterruptedPost(post),
        markPublishStarted(post.id, post.workspace_id, post.attempts).catch(() => null),
      ]);

      const rows = await sql`
        SELECT status, publish_started_at FROM scheduled_posts WHERE id = ${post.id}`;
      if (requeued) {
        expect(rows[0]).toMatchObject({ status: requeued, publish_started_at: null });
      } else {
        expect(rows[0].status).toBe("publishing");
        expect(rows[0].publish_started_at).not.toBeNull();
      }
    }
  });
});
