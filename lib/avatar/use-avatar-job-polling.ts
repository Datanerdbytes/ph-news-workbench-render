"use client";

import { useEffect } from "react";
import {
  ACTIVE_AVATAR_STATUSES,
  readAvatarJobResponse,
  type PublicAvatarJob,
} from "./jobs";

const POLL_INTERVAL_MS = 2_500;

type AvatarJobPollingOptions = {
  job: PublicAvatarJob | null;
  onJob: (job: PublicAvatarJob) => void;
  onError: (message: string) => void;
};

export function useAvatarJobPolling({
  job,
  onJob,
  onError,
}: AvatarJobPollingOptions) {
  const jobId = job?.id;
  const active = Boolean(job && ACTIVE_AVATAR_STATUSES.includes(job.status));

  useEffect(() => {
    if (!jobId || !active) return;
    const controller = new AbortController();
    let timeout: number | undefined;

    const schedule = () => {
      timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/avatar/syntheses/${encodeURIComponent(jobId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const next = await readAvatarJobResponse(
          response,
          "The avatar status could not be refreshed.",
        );
        if (controller.signal.aborted) return;
        onJob(next);
        onError("");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          onError(
            error instanceof Error
              ? error.message
              : "The avatar status could not be refreshed. Retrying…",
          );
        }
      } finally {
        if (!controller.signal.aborted) schedule();
      }
    };

    schedule();
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [jobId, active, onJob, onError]);
}
