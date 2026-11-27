import { describe, expect, it } from "vitest";
import {
  avatarMediaUrl,
  preferredAvatarJob,
  publicAvatarJob,
  readAvatarJobResponse,
  type AvatarJobRow,
  type PublicAvatarJob,
} from "./jobs";

function job(overrides: Partial<PublicAvatarJob> = {}): PublicAvatarJob {
  return {
    id: "job-1",
    avatarId: "meg-formal",
    voiceId: "en-PH-RosaNeural",
    speed: 1,
    text: "Hello",
    status: "completed",
    statusMessage: "Ready",
    progress: 1,
    videoUrl: "https://store.test/avatar.mp4",
    outputFormat: "mp4",
    hasAlpha: false,
    durationSeconds: 3,
    error: null,
    publishState: "ready",
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("publicAvatarJob", () => {
  it("exposes alpha metadata and defaults legacy rows to opaque MP4", () => {
    const row = {
      id: "job-1",
      workspace_id: "ws-1",
      user_id: "user-1",
      avatar_id: "meg-formal",
      avatar_kind: "video",
      avatar_style: "formal",
      voice_id: "en-PH-RosaNeural",
      speed: 1,
      text: "Hello",
      characters: 5,
      estimated_seconds: 3,
      provider_synthesis_id: null,
      status: "completed",
      progress: 1,
      status_message: "Ready",
      blob_url: "https://store.test/avatar.webm",
      file_size: 100,
      duration_seconds: 3,
      error: null,
      worker_id: null,
      attempts: 1,
      cancel_requested: false,
      publish_state: "ready",
      created_at: "2026-11-17T10:00:00.000Z",
      updated_at: "2026-11-17T10:00:00.000Z",
    } as AvatarJobRow;

    expect(publicAvatarJob(row)).toMatchObject({
      outputFormat: "mp4",
      hasAlpha: false,
    });
    expect(
      publicAvatarJob({ ...row, output_format: "webm", has_alpha: true }),
    ).toMatchObject({ outputFormat: "webm", hasAlpha: true });
  });
});

describe("avatarMediaUrl", () => {
  it("builds an encoded authenticated playback path without the storage URL", () => {
    expect(avatarMediaUrl("job/1")).toBe(
      "/api/avatar/syntheses/job%2F1/video",
    );
  });
});

describe("preferredAvatarJob", () => {
  it("prefers an active job over newer ready and terminal jobs", () => {
    const active = job({ id: "active", status: "running", progress: 0.5 });

    expect(
      preferredAvatarJob([
        job({ id: "ready" }),
        job({ id: "failed", status: "failed", videoUrl: null }),
        active,
      ]),
    ).toBe(active);
  });

  it("falls back to the newest reusable completed avatar", () => {
    const ready = job({ id: "ready" });

    expect(
      preferredAvatarJob([
        job({ id: "published", publishState: "published" }),
        job({ id: "failed", status: "failed", videoUrl: null }),
        ready,
      ]),
    ).toBe(ready);
  });

  it("does not select a failed, canceled, scheduled, or published job", () => {
    expect(
      preferredAvatarJob([
        job({ id: "failed", status: "failed", videoUrl: null }),
        job({ id: "canceled", status: "cancelled", videoUrl: null }),
        job({ id: "scheduled", publishState: "scheduled" }),
        job({ id: "published", publishState: "published" }),
      ]),
    ).toBeNull();
    expect(preferredAvatarJob([])).toBeNull();
  });
});

describe("readAvatarJobResponse", () => {
  it("accepts a public job response", async () => {
    const value = job();
    const response = new Response(JSON.stringify(value), { status: 200 });

    await expect(readAvatarJobResponse(response, "fallback")).resolves.toEqual(value);
  });

  it("uses the API error without exposing malformed response bodies", async () => {
    const response = new Response(JSON.stringify({ error: "Try later." }), {
      status: 503,
    });

    await expect(readAvatarJobResponse(response, "fallback")).rejects.toThrow(
      "Try later.",
    );
  });
});
