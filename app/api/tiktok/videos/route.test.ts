import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/blob", () => ({ assertStagedBlob: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/storage", () => ({ isManagedStagedUrl: () => true }));
vi.mock("@/lib/tiktok", () => ({
  ensureFreshTikTokToken: vi.fn(),
  // The route checks `error instanceof TikTokAuthError`, so the mock needs a
  // real class shape.
  TikTokAuthError: class TikTokAuthError extends Error {},
  tiktokPublicPostingApproved: () => true,
}));
vi.mock("@/lib/publishing/connection", () => ({
  requirePlatformConnection: vi.fn(),
}));
vi.mock("@/lib/publishing/tiktok", () => ({
  publishTikTokVideo: vi.fn(),
}));
vi.mock("@/lib/schedule-mirror", () => ({ recordNativeSchedule: vi.fn() }));
vi.mock("@/lib/publishing/errors", () => ({
  tiktokErrorResponse: vi.fn(() =>
    new Response(JSON.stringify({ error: "TikTok rejected the post." }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  ),
}));

import { ensureFreshTikTokToken } from "@/lib/tiktok";
import { recordNativeSchedule } from "@/lib/schedule-mirror";
import { publishTikTokVideo } from "@/lib/publishing/tiktok";
import { requirePlatformConnection } from "@/lib/publishing/connection";
import { POST } from "./route";

const requireMock = requirePlatformConnection as unknown as Mock;
const tokenMock = ensureFreshTikTokToken as unknown as Mock;
const publishMock = publishTikTokVideo as unknown as Mock;
const mirrorMock = recordNativeSchedule as unknown as Mock;

const access = {
  user: { id: "u1" },
  workspace: { id: "ws_1", role: "owner" },
};
const connection = {
  platform: "tiktok" as const,
  platformUserId: "tt_1",
  username: "@dailybuzz",
  accessToken: "cipher-token",
  scopes: ["video.publish"],
  expiresAt: null,
};

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/tiktok/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stagedBody = {
  title: "Newsroom cut",
  privacyStatus: "PUBLIC_TO_EVERYONE",
  videoUrl: "https://bucket.public.blob.vercel-storage.com/tiktok/v.mp4",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireMock.mockResolvedValue({ context: { access, connection } });
  tokenMock.mockResolvedValue("fresh-token");
  publishMock.mockResolvedValue({
    id: "tt_video_1",
    permalink: "https://www.tiktok.com/@dailybuzz/video/tt_video_1",
  });
  mirrorMock.mockResolvedValue(undefined);
});

describe("POST /api/tiktok/videos", () => {
  it("mirrors the publish so the platform counters see it", async () => {
    const response = await POST(post(stagedBody));

    expect(response.status).toBe(201);
    expect(mirrorMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "u1",
      kind: "video",
      text: "Newsroom cut",
      scheduledFor: null,
      results: [
        {
          page: { id: "tt_1", name: "@dailybuzz" },
          ok: true,
          id: "tt_video_1",
          permalink: "https://www.tiktok.com/@dailybuzz/video/tt_video_1",
        },
      ],
      platform: "tiktok",
    });
  });

  it("does not mirror a rejected publish", async () => {
    publishMock.mockRejectedValue(new Error("TikTok said no"));

    const response = await POST(post(stagedBody));

    expect(response.status).toBe(502);
    expect(mirrorMock).not.toHaveBeenCalled();
  });
});
