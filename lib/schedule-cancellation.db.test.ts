import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteScheduledPostWithAvatarRelease } from "@/lib/schedule-cancellation";

describe.skipIf(!process.env.DATABASE_URL)("schedule cancellation", () => {
  let sql: typeof import("@/lib/db").sql;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/db"));
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email)
      VALUES (${userId}, ${`DB cancel ${userId}`}, ${`${userId}@example.test`})`;
    await sql`
      INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`DB cancel ${workspaceId}`}, ${userId})`;
  });

  afterEach(async () => {
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
  });

  async function createAvatar(): Promise<{ id: string; blobUrl: string }> {
    const id = randomUUID();
    const blobUrl = `https://media.example.test/avatars/${id}/avatar.mp4`;
    await sql`
      INSERT INTO avatar_jobs
        (id, workspace_id, user_id, avatar_id, avatar_kind, voice_id, speed,
         text, characters, estimated_seconds, status, blob_url, publish_state)
      VALUES
        (${id}, ${workspaceId}, ${userId}, 'lisa', 'photo', 'en-US-AvaMultilingualNeural', 1,
         'Database cancellation regression', 32, 12, 'completed', ${blobUrl}, 'scheduled')`;
    return { id, blobUrl };
  }

  async function createSchedule(
    avatarJobId: string,
    imageUrl: string,
    status = "scheduled",
    claim?: string,
  ): Promise<number> {
    const rows = await sql`
      INSERT INTO scheduled_posts
        (workspace_id, text, image_url, scheduled_for, status, error_message,
         created_by, avatar_job_id)
      VALUES
        (${workspaceId}, 'Database cancellation regression', ${imageUrl},
         now() - interval '1 minute', ${status}, ${claim ?? null},
         ${userId}, ${avatarJobId})
      RETURNING id`;
    return Number(rows[0].id);
  }

  it("atomically deletes a schedule and releases its reusable avatar", async () => {
    const avatar = await createAvatar();
    const compositeUrl = `https://media.example.test/compose/avatars/${avatar.id}/composite.mp4`;
    const scheduleId = await createSchedule(avatar.id, compositeUrl, "rescheduling", "claim-1");

    await expect(
      deleteScheduledPostWithAvatarRelease({
        id: scheduleId,
        workspaceId,
        status: "rescheduling",
        claim: "claim-1",
      }),
    ).resolves.toMatchObject({ id: scheduleId, avatar_job_id: avatar.id });

    const avatarRows = await sql`
      SELECT publish_state, blob_url FROM avatar_jobs WHERE id = ${avatar.id}`;
    expect(avatarRows[0]).toEqual({ publish_state: "ready", blob_url: avatar.blobUrl });
    const scheduleRows = await sql`
      SELECT id FROM scheduled_posts WHERE id = ${scheduleId}`;
    expect(scheduleRows).toHaveLength(0);
  });

  it("keeps an avatar scheduled while another schedule still references it", async () => {
    const avatar = await createAvatar();
    const firstId = await createSchedule(avatar.id, avatar.blobUrl);
    await createSchedule(
      avatar.id,
      `https://media.example.test/compose/avatars/${avatar.id}/composite.mp4`,
    );

    await deleteScheduledPostWithAvatarRelease({
      id: firstId,
      workspaceId,
      status: "scheduled",
    });

    const rows = await sql`
      SELECT publish_state FROM avatar_jobs WHERE id = ${avatar.id}`;
    expect(rows[0].publish_state).toBe("scheduled");
  });

  it("does not delete or release when the recovery claim is stale", async () => {
    const avatar = await createAvatar();
    const scheduleId = await createSchedule(avatar.id, avatar.blobUrl, "rescheduling", "claim-2");

    await expect(
      deleteScheduledPostWithAvatarRelease({
        id: scheduleId,
        workspaceId,
        status: "rescheduling",
        claim: "stale-claim",
      }),
    ).resolves.toBeNull();

    const scheduleRows = await sql`
      SELECT status FROM scheduled_posts WHERE id = ${scheduleId}`;
    const avatarRows = await sql`
      SELECT publish_state FROM avatar_jobs WHERE id = ${avatar.id}`;
    expect(scheduleRows[0].status).toBe("rescheduling");
    expect(avatarRows[0].publish_state).toBe("scheduled");
  });

  it("allows only one concurrent deletion", async () => {
    const avatar = await createAvatar();
    const scheduleId = await createSchedule(avatar.id, avatar.blobUrl);

    const results = await Promise.all([
      deleteScheduledPostWithAvatarRelease({
        id: scheduleId,
        workspaceId,
        status: "scheduled",
      }),
      deleteScheduledPostWithAvatarRelease({
        id: scheduleId,
        workspaceId,
        status: "scheduled",
      }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const rows = await sql`
      SELECT publish_state FROM avatar_jobs WHERE id = ${avatar.id}`;
    expect(rows[0].publish_state).toBe("ready");
  });

  it("takes the avatar lock before the release decision runs", async () => {
    const avatar = await createAvatar();
    const scheduleId = await createSchedule(avatar.id, avatar.blobUrl);
    const statements: string[] = [];
    const original = sql.transaction;
    const spy = vi
      .spyOn(sql, "transaction")
      .mockImplementation(((queries: unknown[], options?: unknown) => {
        for (const query of queries) {
          const prepared = query as {
            queryData?: { strings?: readonly string[] };
          };
          statements.push(
            (prepared.queryData?.strings ?? []).join("?") || String(query),
          );
        }
        return original(queries as never, options as never);
      }) as typeof sql.transaction);

    try {
      await deleteScheduledPostWithAvatarRelease({
        id: scheduleId,
        workspaceId,
        status: "scheduled",
      });
    } finally {
      spy.mockRestore();
    }

    // The lock is taken in an earlier statement of the same transaction, so
    // the delete and its NOT EXISTS check run afterwards on a fresh
    // snapshot that already sees the competing cancellation.
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("FROM avatar_jobs");
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[1]).toContain("DELETE FROM scheduled_posts");
    expect(statements[1]).toContain("NOT EXISTS");
  });

  it("releases a shared avatar when two schedules are cancelled together", async () => {
    const avatar = await createAvatar();
    const firstId = await createSchedule(avatar.id, avatar.blobUrl);
    const secondId = await createSchedule(
      avatar.id,
      `https://media.example.test/compose/avatars/${avatar.id}/composite.mp4`,
    );

    const results = await Promise.all([
      deleteScheduledPostWithAvatarRelease({
        id: firstId,
        workspaceId,
        status: "scheduled",
      }),
      deleteScheduledPostWithAvatarRelease({
        id: secondId,
        workspaceId,
        status: "scheduled",
      }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(2);
    const scheduleRows = await sql`
      SELECT id FROM scheduled_posts WHERE avatar_job_id = ${avatar.id}`;
    expect(scheduleRows).toHaveLength(0);
    const avatarRows = await sql`
      SELECT publish_state FROM avatar_jobs WHERE id = ${avatar.id}`;
    // Both cancellations see the other schedule, so neither may skip the
    // release: the lock makes the second one run after the first committed.
    expect(avatarRows[0].publish_state).toBe("ready");
  });
});
