import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock, transactionMock } = vi.hoisted(() => {
  const transaction = vi.fn();
  return {
    transactionMock: transaction,
    sqlMock: Object.assign(vi.fn(), { transaction }),
  };
});

vi.mock("@/lib/db", () => ({ sql: sqlMock }));

import { ACTIVE_AVATAR_STATUSES, type AvatarJobRow } from "./jobs";
import {
  claimAvatarForPublish,
  claimNextAvatarJob,
  completeAvatarJob,
  enqueueAvatarJob,
  failAvatarJob,
  finishAvatarPublish,
  getAvatarJob,
  heartbeatAvatarJob,
  recordAvatarSubmission,
  recoverStaleAvatarJobs,
  releaseAvatarPublish,
  removeAvatarJob,
  requestAvatarCancellation,
  updateAvatarJob,
} from "./queue";

function row(overrides: Partial<AvatarJobRow> = {}): AvatarJobRow {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    user_id: "user-1",
    avatar_id: "max-business",
    avatar_kind: "video",
    avatar_style: "business",
    voice_id: "en-PH-RosaNeural",
    speed: 1.1,
    text: "Hello",
    characters: 5,
    estimated_seconds: 3,
    provider_synthesis_id: null,
    status: "queued",
    progress: null,
    status_message: "Queued",
    blob_url: null,
    output_format: "mp4",
    has_alpha: false,
    file_size: null,
    duration_seconds: null,
    error: null,
    worker_id: null,
    attempts: 0,
    cancel_requested: false,
    publish_state: "ready",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function owner(overrides: Partial<AvatarJobRow> = {}) {
  return row({
    status: "submitting",
    worker_id: "worker-1",
    attempts: 1,
    ...overrides,
  });
}

function query(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join("?");
}

function avatarClaimCall() {
  return sqlMock.mock.calls.find((call) =>
    query(call).includes("UPDATE avatar_jobs SET publish_state")
  )!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
  vi.stubEnv("AVATAR_DAILY_JOB_CAP", "7");
  vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", "900");
  vi.stubEnv("AVATAR_MAX_ACTIVE_JOBS", "3");
  sqlMock.mockResolvedValue([]);
  transactionMock.mockResolvedValue([[], [row()]]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("enqueueAvatarJob", () => {
  it("locks the workspace and atomically enforces active and daily quota", async () => {
    const inserted = row();
    transactionMock.mockResolvedValue([[], [inserted]]);
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }));

    const result = await enqueueAvatarJob({
      workspaceId: "ws-1",
      userId: "user-1",
      avatarId: "max-business",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
      text: "Hello",
    });

    expect(result.id).toBe(inserted.id);
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: "ReadCommitted",
    });
    const queries = transactionMock.mock.calls[0][0] as Array<{
      strings: TemplateStringsArray;
      values: unknown[];
    }>;
    expect(queries).toHaveLength(2);
    expect(queries[0].strings.join("?")).toBe(
      "SELECT id FROM workspaces WHERE id = ? FOR UPDATE",
    );
    expect(queries[0].values).toEqual(["ws-1"]);

    const quotaQuery = queries[1].strings.join("?");
    expect(quotaQuery).toContain("status = ANY(?::text[])");
    expect(quotaQuery).toContain("INSERT INTO avatar_usage_daily");
    expect(quotaQuery).toContain("SELECT ?, ?, ?, ?");
    expect(quotaQuery).toContain("ON CONFLICT (day, workspace_id) DO UPDATE");
    expect(quotaQuery).toContain("avatar_usage_daily.jobs < ?");
    expect(quotaQuery).toContain(
      "avatar_usage_daily.seconds_reserved + avatar_usage_daily.seconds_actual + ? <= ?",
    );
    expect(quotaQuery).toContain("(SELECT count FROM active) < ?");
    expect(quotaQuery).toContain("INSERT INTO avatar_jobs");
    expect(quotaQuery).toContain("FROM reserved");
    // The reservation day comes from the database clock, not the app clock,
    // so the reservation and the settlement (the job's UTC creation day)
    // agree.
    expect(quotaQuery).toContain("(now() AT TIME ZONE 'utc')::date");

    const values = queries[1].values;
    expect(values.slice(0, 2)).toEqual(["ws-1", ACTIVE_AVATAR_STATUSES]);
    expect(values.slice(2, 15)).toEqual([
      "ws-1",
      5,
      3,
      3,
      7,
      3,
      900,
      5,
      3,
      7,
      3,
      900,
      3,
    ]);
    expect(values.slice(15)).toEqual([
      expect.any(String),
      "ws-1",
      "user-1",
      "max-business",
      "video",
      "business",
      "en-PH-RosaNeural",
      1.1,
      "Hello",
      5,
      3,
      "mp4",
      false,
    ]);
  });

  it("persists native alpha metadata for a transparent standard avatar", async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }));

    await enqueueAvatarJob({
      workspaceId: "ws-1",
      userId: "user-1",
      avatarId: "meg-formal",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
      text: "Hello",
      transparent: true,
    });

    const queries = transactionMock.mock.calls[0][0] as Array<{
      strings: TemplateStringsArray;
      values: unknown[];
    }>;
    expect(queries[1].values.slice(-2)).toEqual(["webm", true]);
  });

  it("persists style-less full-body avatars without unsupported alpha", async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }));

    await enqueueAvatarJob({
      workspaceId: "ws-1",
      userId: "user-1",
      avatarId: "rowan",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
      text: "Hello",
      transparent: true,
    });

    const queries = transactionMock.mock.calls[0][0] as Array<{
      strings: TemplateStringsArray;
      values: unknown[];
    }>;
    expect(queries[1].values).toContain("rowan");
    expect(queries[1].values).toContain(null);
    expect(queries[1].values.slice(-2)).toEqual(["mp4", false]);
  });

  it("returns a quota error when the conditional usage insert reserves nothing", async () => {
    transactionMock.mockResolvedValue([[], []]);

    await expect(
      enqueueAvatarJob({
        workspaceId: "ws-1",
        userId: "user-1",
        avatarId: "anika",
        voiceId: "en-PH-RosaNeural",
        speed: 1,
        text: "Hello",
      }),
    ).rejects.toMatchObject({ status: 429, code: "quota_exceeded" });
  });
});

describe("job lookup and claims", () => {
  it("scopes lookup by both job id and workspace", async () => {
    sqlMock.mockResolvedValue([row()]);
    await expect(getAvatarJob("job-1", "ws-1")).resolves.toEqual(row());
    expect(query(sqlMock.mock.calls[0])).toContain(
      "WHERE id = ? AND workspace_id = ?",
    );
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["job-1", "ws-1"]);

    sqlMock.mockResolvedValue([]);
    await expect(getAvatarJob("job-1", "other-ws")).resolves.toBeNull();
  });

  it("claims the oldest queued job with row locking and an attempt ceiling", async () => {
    const claimed = owner();
    sqlMock.mockResolvedValue([claimed]);

    await expect(claimNextAvatarJob("worker-1")).resolves.toEqual(claimed);
    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("status = 'submitting'");
    expect(text).toContain("attempts = attempts + 1");
    expect(text).toContain("status = 'queued' AND attempts < ?");
    expect(text).toContain("ORDER BY created_at ASC");
    expect(text).toContain("LIMIT 1");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["worker-1", 3]);
  });

  it("fences submission recording by worker, attempt, status, and missing provider id", async () => {
    sqlMock.mockResolvedValueOnce([{ id: "job-1" }]).mockResolvedValueOnce([]);

    await expect(recordAvatarSubmission(owner())).resolves.toBe(true);
    await expect(recordAvatarSubmission(owner())).resolves.toBe(false);
    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("provider_synthesis_id = id");
    expect(text).toContain("worker_id = ?");
    expect(text).toContain("attempts = ?");
    expect(text).toContain("status = 'submitting'");
    expect(text).toContain("provider_synthesis_id IS NULL");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["job-1", "worker-1", 1]);
  });

  it("fences progress updates and heartbeats to the owning active attempt", async () => {
    sqlMock.mockResolvedValue([{ id: "job-1" }]);

    await expect(
      updateAvatarJob(owner(), "downloading", 0.75, "Downloading…"),
    ).resolves.toBe(true);
    expect(query(sqlMock.mock.calls[0])).toContain(
      "status = ANY(?::text[])",
    );
    expect(sqlMock.mock.calls[0].slice(1)).toEqual([
      "downloading",
      0.75,
      "Downloading…",
      "job-1",
      "worker-1",
      1,
      ACTIVE_AVATAR_STATUSES,
    ]);

    await expect(heartbeatAvatarJob(owner())).resolves.toBe(true);
    expect(query(sqlMock.mock.calls[1])).toContain("attempts = ?");
    expect(query(sqlMock.mock.calls[1])).toContain(
      "status = ANY(?::text[])",
    );
    expect(sqlMock.mock.calls[1].slice(1)).toEqual([
      "job-1",
      "worker-1",
      1,
      ACTIVE_AVATAR_STATUSES,
    ]);
  });
});

describe("completion and failure accounting", () => {
  it("completes only the uncancelled owner and replaces reserved seconds with actual seconds", async () => {
    sqlMock.mockResolvedValue([row({ status: "completed" })]);

    await expect(
      completeAvatarJob(owner(), {
        blobUrl: "https://store.test/avatar.mp4",
        fileSize: 4096,
        durationSeconds: 12.2,
      }),
    ).resolves.toBe(true);

    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("status = 'completed'");
    expect(text).toContain("workspace_id = ?");
    expect(text).toContain("worker_id = ?");
    expect(text).toContain("attempts = ?");
    expect(text).toContain("cancel_requested = false");
    // Settlement uses the job's own creation day converted to UTC, matching
    // the UTC day the reservation was written under regardless of the
    // database session timezone.
    expect(text).toContain("(created_at AT TIME ZONE 'utc')::date AS day");
    expect(text).toContain(
      "seconds_reserved = GREATEST(0, usage.seconds_reserved - finished.estimated_seconds)",
    );
    expect(text).toContain("seconds_actual = usage.seconds_actual + ?");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual([
      "https://store.test/avatar.mp4",
      4096,
      12.2,
      "job-1",
      "ws-1",
      "worker-1",
      1,
      ACTIVE_AVATAR_STATUSES,
      13,
    ]);
  });

  it("returns false when completion loses the ownership fence", async () => {
    sqlMock.mockResolvedValue([]);
    await expect(
      completeAvatarJob(owner(), {
        blobUrl: "https://store.test/avatar.mp4",
        fileSize: 1,
        durationSeconds: 0,
      }),
    ).resolves.toBe(false);
    expect(sqlMock.mock.calls[0].slice(1)).toContain(1);
  });

  it.each([
    [true, 1, "queued"],
    [true, 3, "failed"],
    [false, 1, "failed"],
  ])(
    "accounts for retryable=%s at attempt %s as %s",
    async (retryable, attempts, status) => {
      sqlMock.mockResolvedValue([{ status }]);

      await expect(
        failAvatarJob(owner({ attempts }), { message: "Provider busy", retryable }),
      ).resolves.toBe(status);

      const text = query(sqlMock.mock.calls[0]);
      expect(text).toContain("WHEN cancel_requested THEN 'cancelled'");
      expect(text).toContain("attempts < ? THEN 'queued'");
      expect(text).toContain("worker_id = ?");
      expect(text).toContain("attempts = ?");
      expect(text).toContain("finished.status IN ('failed', 'cancelled')");
      expect(text).toContain("finished.provider_synthesis_id IS NULL");
      expect(sqlMock.mock.calls[0].slice(1)).toEqual([
        retryable,
        3,
        retryable,
        3,
        retryable,
        3,
        retryable,
        3,
        "Provider busy",
        "job-1",
        "worker-1",
        attempts,
        ACTIVE_AVATAR_STATUSES,
      ]);
    },
  );

  it("returns null when failure recording loses the attempt fence", async () => {
    sqlMock.mockResolvedValue([]);
    await expect(
      failAvatarJob(owner(), { message: "busy", retryable: true }),
    ).resolves.toBeNull();
  });
});

describe("cancellation and stale recovery", () => {
  it("cancels queued work immediately but releases quota only before provider submission", async () => {
    sqlMock.mockResolvedValue([row({ status: "cancelled", cancel_requested: true })]);

    await expect(
      requestAvatarCancellation("job-1", "ws-1"),
    ).resolves.toMatchObject({ status: "cancelled" });

    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("status = ANY(?::text[])");
    expect(text).toContain("publish_state = 'ready'");
    expect(text).toContain("WHEN status = 'queued' THEN 'cancelled'");
    expect(text).toContain("cancelled.status = 'cancelled'");
    expect(text).toContain("cancelled.provider_synthesis_id IS NULL");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual([
      "job-1",
      "ws-1",
      ACTIVE_AVATAR_STATUSES,
    ]);
  });

  it("recovers stale active jobs and releases only terminal pre-submission reservations", async () => {
    const recovered = [{ id: "job-1", provider_synthesis_id: "job-1" }];
    sqlMock.mockResolvedValue(recovered);

    await expect(recoverStaleAvatarJobs()).resolves.toEqual(recovered);
    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("status IN ('submitting', 'running', 'downloading', 'finalizing')");
    expect(text).toContain("updated_at < now() - ? * interval '1 minute'");
    expect(text).toContain("WHEN cancel_requested THEN 'cancelled'");
    expect(text).toContain("WHEN attempts >= ? THEN 'failed'");
    expect(text).toContain("ELSE 'queued'");
    expect(text).toContain("releasable AS");
    expect(text).toContain("SUM(estimated_seconds)::int AS seconds");
    expect(text).toContain("status IN ('failed', 'cancelled')");
    expect(text).toContain("provider_synthesis_id IS NULL");
    expect(text).toContain("GROUP BY workspace_id, day");
    expect(text).toContain("usage.seconds_reserved - releasable.seconds");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual([3, 3, 3, 20]);
  });
});

describe("removal and publishing", () => {
  it("removes only terminal, unpublished jobs with no scheduled post", async () => {
    sqlMock.mockResolvedValue([
      {
        blob_url: "https://store.test/avatar.mp4",
        provider_synthesis_id: "job-1",
      },
    ]);

    await expect(removeAvatarJob("job-1", "ws-1")).resolves.toEqual({
      blobUrl: "https://store.test/avatar.mp4",
      providerSynthesisId: "job-1",
    });
    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(text).toContain("publish_state = 'ready'");
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("scheduled_posts WHERE avatar_job_id = avatar_jobs.id");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["job-1", "ws-1"]);

    sqlMock.mockResolvedValue([]);
    await expect(removeAvatarJob("job-1", "ws-1")).resolves.toBeNull();
  });

  it("claims a completed ready job only for its exact workspace and video URL", async () => {
    sqlMock.mockResolvedValue([{ blob_url: "https://store.test/avatar.mp4" }]);

    await expect(
      claimAvatarForPublish("job-1", "ws-1", "https://store.test/avatar.mp4"),
    ).resolves.toBe("https://store.test/avatar.mp4");
    const claim = avatarClaimCall();
    const text = query(claim);
    const urlFence = sqlMock.mock.calls.find((call) =>
      query(call).includes("AND blob_url = ?")
    );
    expect(text).toContain("publish_state = 'publishing'");
    expect(text).toContain("status = 'completed' AND publish_state = 'ready'");
    expect(urlFence).toBeDefined();
    expect(urlFence!.slice(1)).toEqual(["https://store.test/avatar.mp4"]);
    expect(claim.slice(1, 3)).toEqual(["job-1", "ws-1"]);
  });

  it("claims an owned avatar for a validated composite without trusting its URL as the source", async () => {
    sqlMock.mockResolvedValue([{ blob_url: "https://store.test/avatar.mp4" }]);

    await expect(
      claimAvatarForPublish(
        "job-1",
        "ws-1",
        "https://store.test/compose/avatars/job-1/composite.mp4",
        true,
      ),
    ).resolves.toBe("https://store.test/avatar.mp4");
    const claim = avatarClaimCall();
    const text = query(claim);
    expect(text).toContain("blob_url IS NOT NULL");
    expect(
      sqlMock.mock.calls.some((call) => query(call).includes("AND blob_url = ?"))
    ).toBe(false);
    expect(claim.slice(1, 3)).toEqual(["job-1", "ws-1"]);
    expect(claim).not.toContain(
      "https://store.test/compose/avatars/job-1/composite.mp4"
    );
  });

  it("releases only a publishing claim in the same workspace", async () => {
    await releaseAvatarPublish("job-1", "ws-1");
    expect(query(sqlMock.mock.calls[0])).toContain("publish_state = 'publishing'");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["job-1", "ws-1"]);
  });

  it("finishes publishing only after the mirrored post is published", async () => {
    sqlMock.mockResolvedValueOnce([{ id: "job-1" }]).mockResolvedValueOnce([]);

    await expect(finishAvatarPublish("job-1", "ws-1", 42)).resolves.toBe(true);
    await expect(finishAvatarPublish("job-1", "ws-1", 42)).resolves.toBe(false);
    const text = query(sqlMock.mock.calls[0]);
    expect(text).toContain("avatar_job_id = ?");
    expect(text).toContain("status = 'published'");
    expect(text).toContain("publish_state = 'publishing'");
    expect(sqlMock.mock.calls[0].slice(1)).toEqual([42, "ws-1", "job-1", "job-1", "ws-1"]);
  });
});
