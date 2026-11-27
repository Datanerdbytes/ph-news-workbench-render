import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Usage = {
  jobs: number;
  characters: number;
  seconds_reserved: number;
  seconds_actual: number;
};

describe.skipIf(!process.env.DATABASE_URL)("avatar quota accounting", () => {
  let sql: typeof import("@/lib/db").sql;
  let enqueueAvatarJob: typeof import("./queue").enqueueAvatarJob;
  let claimNextAvatarJob: typeof import("./queue").claimNextAvatarJob;
  let completeAvatarJob: typeof import("./queue").completeAvatarJob;
  let recoverStaleAvatarJobs: typeof import("./queue").recoverStaleAvatarJobs;
  let estimateAvatarSeconds: typeof import("./config").estimateAvatarSeconds;
  let utcDay: typeof import("./config").utcDay;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/db"));
    ({
      enqueueAvatarJob,
      claimNextAvatarJob,
      completeAvatarJob,
      recoverStaleAvatarJobs,
    } = await import("./queue"));
    ({ estimateAvatarSeconds, utcDay } = await import("./config"));
  });

  beforeEach(async () => {
    vi.stubEnv("AVATAR_DAILY_JOB_CAP", "5");
    vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", "900");
    vi.stubEnv("AVATAR_MAX_ACTIVE_JOBS", "2");
    userId = randomUUID();
    workspaceId = randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email)
      VALUES (${userId}, ${`DB avatar ${userId}`}, ${`${userId}@example.test`})`;
    await sql`
      INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`DB avatar ${workspaceId}`}, ${userId})`;
  });

  afterEach(async () => {
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
    vi.unstubAllEnvs();
  });

  function enqueue(text = "Hello") {
    return enqueueAvatarJob({
      workspaceId,
      userId,
      avatarId: "max-business",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
      text,
    });
  }

  async function usage(): Promise<Usage> {
    const rows = await sql`
      SELECT jobs, characters, seconds_reserved, seconds_actual
      FROM avatar_usage_daily
      WHERE day = ${utcDay()} AND workspace_id = ${workspaceId}`;
    return rows[0] as unknown as Usage;
  }

  async function seedUsage(overrides: Partial<Usage>) {
    const values = {
      jobs: 1,
      characters: 5,
      seconds_reserved: 0,
      seconds_actual: 0,
      ...overrides,
    };
    await sql`
      INSERT INTO avatar_usage_daily
        (day, workspace_id, jobs, characters, seconds_reserved, seconds_actual)
      VALUES
        (${utcDay()}, ${workspaceId}, ${values.jobs}, ${values.characters},
         ${values.seconds_reserved}, ${values.seconds_actual})`;
  }

  it("rejects the first reservation when its estimate exceeds the daily cap", async () => {
    const estimated = estimateAvatarSeconds("Hello", 1);
    vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", String(estimated - 1));

    await expect(enqueue()).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
    });
    const rows = await sql`
      SELECT workspace_id FROM avatar_usage_daily
      WHERE day = ${utcDay()} AND workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(0);
  });

  it("counts actual seconds when deciding whether another reservation fits", async () => {
    const estimated = estimateAvatarSeconds("Hello", 1);
    const dailySeconds = estimated + 5;
    const actualSeconds = dailySeconds - estimated + 1;
    vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", String(dailySeconds));
    await seedUsage({ seconds_actual: actualSeconds });

    await expect(enqueue()).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await usage()).toMatchObject({
      jobs: 1,
      seconds_reserved: 0,
      seconds_actual: actualSeconds,
    });
  });

  it("accepts a reservation that exactly reaches the daily cap", async () => {
    const estimated = estimateAvatarSeconds("Hello", 1);
    vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", String(estimated + 5));
    await seedUsage({ seconds_actual: estimated + 5 - estimated });

    const job = await enqueue();

    expect(job.estimated_seconds).toBe(estimated);
    expect(await usage()).toMatchObject({
      jobs: 2,
      seconds_reserved: estimated,
      seconds_actual: 5,
    });
  });

  it("allows only one of two concurrent first reservations under a one-job cap", async () => {
    vi.stubEnv("AVATAR_DAILY_JOB_CAP", "1");

    const results = await Promise.allSettled([enqueue(), enqueue()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await usage()).toMatchObject({ jobs: 1, seconds_reserved: 3 });
    const rows = await sql`
      SELECT id FROM avatar_jobs WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
  });

  it("replaces the reservation with rounded-up actual seconds on completion", async () => {
    const job = await enqueue();
    const claimed = await claimNextAvatarJob("db-avatar-worker");
    expect(claimed?.id).toBe(job.id);

    await expect(
      completeAvatarJob(claimed!, {
        blobUrl: `https://media.example.test/${randomUUID()}/avatar.mp4`,
        fileSize: 1024,
        durationSeconds: 4.2,
      }),
    ).resolves.toBe(true);

    expect(await usage()).toMatchObject({
      jobs: 1,
      seconds_reserved: 0,
      seconds_actual: 5,
    });
  });

  it("releases the sum of every stale terminal pre-submission reservation", async () => {
    await seedUsage({
      jobs: 3,
      characters: 15,
      seconds_reserved: 17,
      seconds_actual: 2,
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const estimates = [5, 8, 4];
    for (const [index, id] of ids.entries()) {
      await sql`
        INSERT INTO avatar_jobs
          (id, workspace_id, user_id, avatar_id, avatar_kind, voice_id, speed,
           text, characters, estimated_seconds, provider_synthesis_id, status,
           attempts, worker_id, updated_at)
        VALUES
          (${id}, ${workspaceId}, ${userId}, 'lisa', 'photo',
           'en-US-AvaMultilingualNeural', 1, 'Stale avatar', 11,
           ${estimates[index]}, ${index === 2 ? ids[index] : null}, 'running', 3,
           'db-avatar-worker', now() - interval '30 minutes')`;
    }

    const recovered = await recoverStaleAvatarJobs();

    expect(recovered).toHaveLength(3);
    expect(await usage()).toMatchObject({
      jobs: 3,
      seconds_reserved: 4,
      seconds_actual: 2,
    });
    const rows = await sql`
      SELECT status, provider_synthesis_id FROM avatar_jobs
      WHERE workspace_id = ${workspaceId} ORDER BY id`;
    expect(rows.every((row) => row.status === "failed")).toBe(true);
  });
});
