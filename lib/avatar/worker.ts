import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteStagedBlobs, stageServerFile } from "@/lib/storage";
import type { TtsVoiceId } from "@/lib/tts/voices";
import {
  deleteAvatarSynthesis,
  downloadAvatarResult,
  getAvatarSynthesis,
  submitAvatarSynthesis,
  AvatarError,
} from "./azure";
import type { AvatarId } from "./avatars";
import { MAX_AVATAR_OUTPUT_BYTES } from "./config";
import type { AvatarJobRow } from "./jobs";
import {
  completeAvatarJob,
  failAvatarJob,
  getAvatarJob,
  heartbeatAvatarJob,
  recordAvatarSubmission,
  updateAvatarJob,
} from "./queue";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const MAX_PROVIDER_WAIT_MS = 20 * 60_000;

function isTerminal(status: AvatarJobRow["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function safeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof AvatarError) {
    return { message: error.message, retryable: error.retryable };
  }
  return {
    message: "The avatar video could not be generated. Please try again.",
    retryable: true,
  };
}

async function removeProviderOutput(
  synthesisId: string | null,
  status: AvatarJobRow["status"],
): Promise<void> {
  if (!synthesisId || !isTerminal(status)) return;
  try {
    await deleteAvatarSynthesis(synthesisId);
  } catch {
    // Azure expires batch outputs; local cancellation must not wait on cleanup.
  }
}

async function failAndCleanupProvider(
  job: AvatarJobRow,
  synthesisId: string | null,
  error: { message: string; retryable: boolean },
) {
  const status = await failAvatarJob(job, error);
  if (status === "failed" || status === "cancelled") {
    await removeProviderOutput(synthesisId, status);
  }
  return status;
}

async function reconcileCompletion(job: AvatarJobRow): Promise<AvatarJobRow | null> {
  return getAvatarJob(job.id, job.workspace_id).catch(() => null);
}

async function stillOwned(job: AvatarJobRow): Promise<AvatarJobRow | null> {
  const current = await getAvatarJob(job.id, job.workspace_id);
  if (
    !current ||
    current.worker_id !== job.worker_id ||
    current.attempts !== job.attempts ||
    !["submitting", "running", "downloading", "finalizing"].includes(current.status)
  ) {
    return null;
  }
  return current;
}

export async function processAvatarJob(job: AvatarJobRow): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "ph-avatar-"));
  const filePath = path.join(workDir, "avatar.mp4");
  let stagedUrl: string | null = null;
  let completionAttempted = false;
  let synthesisId = job.provider_synthesis_id;
  const heartbeat = setInterval(() => {
    void heartbeatAvatarJob(job).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    let current = await stillOwned(job);
    if (!current) return;
    if (current.cancel_requested) {
      await failAndCleanupProvider(job, synthesisId, {
        message: "Avatar generation cancelled.",
        retryable: false,
      });
      return;
    }

    if (!synthesisId) {
      const recorded = await recordAvatarSubmission(job);
      if (!recorded) return;
      synthesisId = job.id;
    }

    let synthesis = job.provider_synthesis_id
      ? await getAvatarSynthesis(job.provider_synthesis_id)
      : null;
    if (!synthesis) {
      synthesis = await submitAvatarSynthesis({
        synthesisId: job.id,
        text: job.text,
        avatarId: job.avatar_id as AvatarId,
        voiceId: job.voice_id as TtsVoiceId,
        speed: Number(job.speed),
      });
    }
    if (synthesis.id !== job.id) {
      throw new AvatarError(502, "invalid_response", "The avatar service returned an invalid job.");
    }
    if (synthesis.status === "Failed") {
      throw new AvatarError(
        502,
        "avatar_failed",
        "The avatar service could not generate this video. Edit the draft and try again.",
        false,
      );
    }

    const startedAt = Date.now();
    while (synthesis.status !== "Succeeded") {
      current = await stillOwned(job);
      if (!current) return;
      if (current.cancel_requested) {
        await failAndCleanupProvider(job, synthesisId, {
          message: "Avatar generation cancelled.",
          retryable: false,
        });
        return;
      }
      if (Date.now() - startedAt > MAX_PROVIDER_WAIT_MS) {
        throw new AvatarError(
          504,
          "avatar_timeout",
          "Avatar generation took too long. Please try again.",
        );
      }
      await updateAvatarJob(job, "running", 0.25, "Azure is generating the avatar video…");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      synthesis = await getAvatarSynthesis(job.id);
      if (!synthesis) {
        throw new AvatarError(502, "provider_error", "The avatar job is unavailable. Please try again.");
      }
      if (synthesis.status === "Failed") {
        throw new AvatarError(
          502,
          "avatar_failed",
          "The avatar service could not generate this video. Edit the draft and try again.",
          false,
        );
      }
    }

    if (!synthesis.resultUrl) {
      throw new AvatarError(502, "invalid_result", "The generated avatar video is unavailable.");
    }
    current = await stillOwned(job);
    if (!current) return;
    if (current.cancel_requested) {
      await failAndCleanupProvider(job, synthesisId, {
        message: "Avatar generation cancelled.",
        retryable: false,
      });
      return;
    }

    await updateAvatarJob(job, "downloading", 0.75, "Downloading the avatar video…");
    const fileSize = await downloadAvatarResult({
      url: synthesis.resultUrl,
      destination: filePath,
      maxBytes: MAX_AVATAR_OUTPUT_BYTES,
    });
    current = await stillOwned(job);
    if (!current) return;
    if (current.cancel_requested) {
      await failAndCleanupProvider(job, synthesisId, {
        message: "Avatar generation cancelled.",
        retryable: false,
      });
      return;
    }

    await updateAvatarJob(job, "finalizing", 0.9, "Saving the avatar video…");
    const staged = await stageServerFile(
      `avatars/${job.workspace_id}/${job.id}/avatar.mp4`,
      filePath,
      "video/mp4",
      MAX_AVATAR_OUTPUT_BYTES,
    );
    stagedUrl = staged.url;
    completionAttempted = true;
    const completed = await completeAvatarJob(job, {
      blobUrl: staged.url,
      fileSize,
      durationSeconds: synthesis.billedAvatarSeconds ?? synthesis.durationSeconds ?? 0,
    });
    if (!completed) {
      const current = await reconcileCompletion(job);
      if (current && isTerminal(current.status)) {
        if (current.blob_url === staged.url) stagedUrl = null;
        if (current.provider_synthesis_id === synthesisId) {
          await removeProviderOutput(synthesisId, current.status);
        }
        return;
      }
      stagedUrl = null;
      return;
    }
    stagedUrl = null;
    await removeProviderOutput(synthesisId, "completed");
  } catch (error) {
    if (completionAttempted && stagedUrl) {
      const current = await reconcileCompletion(job);
      if (current && isTerminal(current.status)) {
        if (current.blob_url === stagedUrl) stagedUrl = null;
        if (current.provider_synthesis_id === synthesisId) {
          await removeProviderOutput(synthesisId, current.status);
        }
        return;
      }
    }
    const failure = safeError(error);
    const status = await failAndCleanupProvider(job, synthesisId, failure).catch(
      () => null,
    );
    if (completionAttempted && stagedUrl && status !== "failed" && status !== "cancelled") {
      stagedUrl = null;
    }
  } finally {
    clearInterval(heartbeat);
    if (stagedUrl) await deleteStagedBlobs([stagedUrl]);
    await rm(workDir, { recursive: true, force: true });
  }
}
