import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  stageServerFile: vi.fn(),
  deleteStagedBlobs: vi.fn(),
  submitAvatarSynthesis: vi.fn(),
  getAvatarSynthesis: vi.fn(),
  deleteAvatarSynthesis: vi.fn(),
  downloadAvatarResult: vi.fn(),
  completeAvatarJob: vi.fn(),
  failAvatarJob: vi.fn(),
  getAvatarJob: vi.fn(),
  heartbeatAvatarJob: vi.fn(),
  recordAvatarSubmission: vi.fn(),
  updateAvatarJob: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
}));
vi.mock("@/lib/storage", () => ({
  stageServerFile: mocks.stageServerFile,
  deleteStagedBlobs: mocks.deleteStagedBlobs,
}));
vi.mock("./azure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./azure")>()),
  submitAvatarSynthesis: mocks.submitAvatarSynthesis,
  getAvatarSynthesis: mocks.getAvatarSynthesis,
  deleteAvatarSynthesis: mocks.deleteAvatarSynthesis,
  downloadAvatarResult: mocks.downloadAvatarResult,
}));
vi.mock("./queue", () => ({
  completeAvatarJob: mocks.completeAvatarJob,
  failAvatarJob: mocks.failAvatarJob,
  getAvatarJob: mocks.getAvatarJob,
  heartbeatAvatarJob: mocks.heartbeatAvatarJob,
  recordAvatarSubmission: mocks.recordAvatarSubmission,
  updateAvatarJob: mocks.updateAvatarJob,
}));

import { AvatarError } from "./azure";
import { MAX_AVATAR_OUTPUT_BYTES } from "./config";
import type { AvatarJobRow } from "./jobs";
import { processAvatarJob } from "./worker";

const WORK_DIR = path.join(os.tmpdir(), "ph-avatar-worker-test");
const FILE_PATH = path.join(WORK_DIR, "avatar.mp4");
const STAGED_URL = "https://store.test/avatars/ws-1/job-1/avatar.mp4";
const RESULT_URL = "https://account.blob.core.windows.net/output/avatar.mp4";

function job(overrides: Partial<AvatarJobRow> = {}): AvatarJobRow {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    user_id: "user-1",
    avatar_id: "meg-formal",
    avatar_kind: "video",
    avatar_style: "formal",
    voice_id: "en-PH-RosaNeural",
    speed: 1.1,
    text: "Hello",
    characters: 5,
    estimated_seconds: 3,
    provider_synthesis_id: null,
    status: "submitting",
    progress: 0.05,
    status_message: "Preparing the avatar…",
    blob_url: null,
    file_size: null,
    duration_seconds: null,
    error: null,
    worker_id: "worker-1",
    attempts: 1,
    cancel_requested: false,
    publish_state: "ready",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function synthesis(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "Succeeded",
    resultUrl: RESULT_URL,
    durationSeconds: 12.5,
    billedAvatarSeconds: 13.4,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
  mocks.mkdtemp.mockResolvedValue(WORK_DIR);
  mocks.rm.mockResolvedValue(undefined);
  mocks.stageServerFile.mockResolvedValue({
    url: STAGED_URL,
    pathname: "avatars/ws-1/job-1/avatar.mp4",
    contentType: "video/mp4",
  });
  mocks.deleteStagedBlobs.mockResolvedValue(undefined);
  mocks.submitAvatarSynthesis.mockResolvedValue(synthesis({ status: "Running" }));
  mocks.getAvatarSynthesis.mockResolvedValue(synthesis());
  mocks.deleteAvatarSynthesis.mockResolvedValue(undefined);
  mocks.downloadAvatarResult.mockResolvedValue(4096);
  mocks.completeAvatarJob.mockResolvedValue(true);
  mocks.failAvatarJob.mockResolvedValue("failed");
  mocks.getAvatarJob.mockResolvedValue(job());
  mocks.heartbeatAvatarJob.mockResolvedValue(true);
  mocks.recordAvatarSubmission.mockResolvedValue(true);
  mocks.updateAvatarJob.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("processAvatarJob", () => {
  it("submits, polls, downloads, stages, completes, and cleans up", async () => {
    const current = job();
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.getAvatarSynthesis.mockResolvedValueOnce(synthesis());

    const processing = processAvatarJob(current);
    await vi.advanceTimersByTimeAsync(5_000);
    await processing;

    expect(mocks.mkdtemp).toHaveBeenCalledWith(
      path.join(os.tmpdir(), "ph-avatar-"),
    );
    expect(mocks.recordAvatarSubmission).toHaveBeenCalledWith(current);
    expect(mocks.submitAvatarSynthesis).toHaveBeenCalledWith({
      synthesisId: "job-1",
      text: "Hello",
      avatarId: "meg-formal",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
    });
    expect(mocks.getAvatarSynthesis).toHaveBeenCalledTimes(1);
    expect(mocks.updateAvatarJob).toHaveBeenNthCalledWith(
      1,
      current,
      "running",
      0.25,
      "Azure is generating the avatar video…",
    );
    expect(mocks.downloadAvatarResult).toHaveBeenCalledWith({
      url: RESULT_URL,
      destination: FILE_PATH,
      maxBytes: MAX_AVATAR_OUTPUT_BYTES,
    });
    expect(mocks.updateAvatarJob).toHaveBeenNthCalledWith(
      2,
      current,
      "downloading",
      0.75,
      "Downloading the avatar video…",
    );
    expect(mocks.stageServerFile).toHaveBeenCalledWith(
      "avatars/ws-1/job-1/avatar.mp4",
      FILE_PATH,
      "video/mp4",
      MAX_AVATAR_OUTPUT_BYTES,
    );
    expect(mocks.updateAvatarJob).toHaveBeenNthCalledWith(
      3,
      current,
      "finalizing",
      0.9,
      "Saving the avatar video…",
    );
    expect(mocks.completeAvatarJob).toHaveBeenCalledWith(current, {
      blobUrl: STAGED_URL,
      fileSize: 4096,
      durationSeconds: 13.4,
    });
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
    expect(mocks.deleteStagedBlobs).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(WORK_DIR, {
      recursive: true,
      force: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses a recorded provider id instead of submitting again", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);

    await processAvatarJob(current);

    expect(mocks.getAvatarSynthesis).toHaveBeenCalledWith("job-1");
    expect(mocks.recordAvatarSubmission).not.toHaveBeenCalled();
    expect(mocks.submitAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.completeAvatarJob).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });

  it("heartbeats while a provider job is still running", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.getAvatarSynthesis.mockResolvedValue(synthesis({ status: "Running" }));

    const processing = processAvatarJob(current);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.heartbeatAvatarJob).toHaveBeenCalledWith(current);
    mocks.getAvatarSynthesis.mockResolvedValueOnce(synthesis());
    await vi.advanceTimersByTimeAsync(5_000);
    await processing;

    expect(mocks.completeAvatarJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cancellation boundaries", () => {
  it("cancels before submission and removes any recorded provider output", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue({ ...current, cancel_requested: true });
    mocks.failAvatarJob.mockResolvedValue("cancelled");

    await processAvatarJob(current);

    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message: "Avatar generation cancelled.",
      retryable: false,
    });
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
    expect(mocks.recordAvatarSubmission).not.toHaveBeenCalled();
    expect(mocks.getAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("does not delete provider output when cancellation loses its fence", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue({ ...current, cancel_requested: true });
    mocks.failAvatarJob.mockResolvedValue(null);

    await processAvatarJob(current);

    expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
  });

  it("cancels at the first polling boundary", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, cancel_requested: true });
    mocks.getAvatarSynthesis.mockResolvedValue(synthesis({ status: "Running" }));

    const processing = processAvatarJob(current);
    await vi.advanceTimersByTimeAsync(0);
    await processing;

    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message: "Avatar generation cancelled.",
      retryable: false,
    });
    expect(mocks.downloadAvatarResult).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });

  it("cancels after provider success but before downloading", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, cancel_requested: true });

    await processAvatarJob(current);

    expect(mocks.downloadAvatarResult).not.toHaveBeenCalled();
    expect(mocks.stageServerFile).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });

  it("cancels after download but before staging", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, cancel_requested: true });

    await processAvatarJob(current);

    expect(mocks.downloadAvatarResult).toHaveBeenCalledTimes(1);
    expect(mocks.stageServerFile).not.toHaveBeenCalled();
    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message: "Avatar generation cancelled.",
      retryable: false,
    });
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("does not let provider cleanup failure break cancellation", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue({ ...current, cancel_requested: true });
    mocks.deleteAvatarSynthesis.mockRejectedValue(new Error("provider unavailable"));

    await expect(processAvatarJob(current)).resolves.toBeUndefined();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
});

describe("fenced ownership", () => {
  it.each([
    ["missing", null],
    ["different worker", job({ worker_id: "worker-2" })],
    ["different attempt", job({ attempts: 2 })],
    ["terminal status", job({ status: "completed" })],
  ])("stops before provider work when ownership is %s", async (_label, current) => {
    mocks.getAvatarJob.mockResolvedValue(current);

    await processAvatarJob(job());

    expect(mocks.recordAvatarSubmission).not.toHaveBeenCalled();
    expect(mocks.getAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.submitAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.failAvatarJob).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("stops when submission recording loses the fence", async () => {
    const current = job();
    mocks.recordAvatarSubmission.mockResolvedValue(false);

    await processAvatarJob(current);

    expect(mocks.getAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.submitAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.failAvatarJob).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the attempt is reclaimed", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mocks.getAvatarSynthesis.mockResolvedValue(synthesis({ status: "Running" }));

    const processing = processAvatarJob(current);
    await vi.advanceTimersByTimeAsync(5_000);
    await processing;

    expect(mocks.failAvatarJob).not.toHaveBeenCalled();
    expect(mocks.downloadAvatarResult).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("retains a staged output when completion loses the fence without a terminal state", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.completeAvatarJob.mockResolvedValue(false);

    await processAvatarJob(current);

    expect(mocks.deleteStagedBlobs).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("deletes a staged output only after a terminal state confirms it is unused", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(
        job({ status: "failed", provider_synthesis_id: "job-1", worker_id: null }),
      );
    mocks.completeAvatarJob.mockResolvedValue(false);

    await processAvatarJob(current);

    expect(mocks.deleteStagedBlobs).toHaveBeenCalledWith([STAGED_URL]);
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });

  it("retains a staged output when another attempt completed with the same URL", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(
        job({
          status: "completed",
          provider_synthesis_id: "job-1",
          blob_url: STAGED_URL,
          worker_id: null,
        }),
      );
    mocks.completeAvatarJob.mockResolvedValue(false);

    await processAvatarJob(current);

    expect(mocks.deleteStagedBlobs).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });
});

describe("failure handling", () => {
  it("records retryable provider failures without deleting a possibly reused id", async () => {
    const current = job();
    mocks.getAvatarSynthesis.mockResolvedValue(null);
    mocks.submitAvatarSynthesis.mockRejectedValue(
      new AvatarError(502, "provider_error", "The provider is busy."),
    );
    mocks.failAvatarJob.mockResolvedValue("queued");

    await processAvatarJob(current);

    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message: "The provider is busy.",
      retryable: true,
    });
    expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("records terminal provider failure and removes its output", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.getAvatarSynthesis.mockResolvedValue(synthesis({ status: "Failed" }));

    await processAvatarJob(current);

    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message:
        "The avatar service could not generate this video. Edit the draft and try again.",
      retryable: false,
    });
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
    expect(mocks.downloadAvatarResult).not.toHaveBeenCalled();
  });

  it.each([null, "queued"] as const)(
    "does not delete provider output when terminal failure recording returns %s",
    async (status) => {
      const current = job({ provider_synthesis_id: "job-1" });
      mocks.getAvatarJob.mockResolvedValue(current);
      mocks.getAvatarSynthesis.mockResolvedValue(synthesis({ status: "Failed" }));
      mocks.failAvatarJob.mockResolvedValue(status);

      await processAvatarJob(current);

      expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
    },
  );

  it("sanitizes unexpected errors and treats them as retryable", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.downloadAvatarResult.mockRejectedValue(new Error("secret local detail"));
    mocks.failAvatarJob.mockResolvedValue("queued");

    await processAvatarJob(current);

    expect(mocks.failAvatarJob).toHaveBeenCalledWith(current, {
      message: "The avatar video could not be generated. Please try again.",
      retryable: true,
    });
    expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("cleans a staged upload if completion accounting throws", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.completeAvatarJob.mockRejectedValue(new Error("database unavailable"));

    await expect(processAvatarJob(current)).resolves.toBeUndefined();

    expect(mocks.deleteStagedBlobs).toHaveBeenCalledWith([STAGED_URL]);
    expect(mocks.failAvatarJob).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it("retains a committed staged output when completion accounting throws", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(
        job({
          status: "completed",
          provider_synthesis_id: "job-1",
          blob_url: STAGED_URL,
          worker_id: null,
        }),
      );
    mocks.completeAvatarJob.mockRejectedValue(new Error("response lost"));

    await expect(processAvatarJob(current)).resolves.toBeUndefined();

    expect(mocks.failAvatarJob).not.toHaveBeenCalled();
    expect(mocks.deleteStagedBlobs).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).toHaveBeenCalledWith("job-1");
  });

  it("retains a staged output when completion and failure recording are uncertain", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.completeAvatarJob.mockRejectedValue(new Error("response lost"));
    mocks.failAvatarJob.mockRejectedValue(new Error("database unavailable"));

    await expect(processAvatarJob(current)).resolves.toBeUndefined();

    expect(mocks.deleteStagedBlobs).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarSynthesis).not.toHaveBeenCalled();
  });

  it("still removes the temp directory when failure recording fails", async () => {
    const current = job({ provider_synthesis_id: "job-1" });
    mocks.getAvatarJob.mockResolvedValue(current);
    mocks.downloadAvatarResult.mockRejectedValue(new Error("download failed"));
    mocks.failAvatarJob.mockRejectedValue(new Error("database unavailable"));

    await expect(processAvatarJob(current)).resolves.toBeUndefined();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
