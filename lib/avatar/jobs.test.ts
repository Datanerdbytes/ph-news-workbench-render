import { describe, expect, it } from "vitest";
import {
  avatarMediaUrl,
  preferredAvatarJob,
  readAvatarJobResponse,
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
    durationSeconds: 3,
    error: null,
    publishState: "ready",
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

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
