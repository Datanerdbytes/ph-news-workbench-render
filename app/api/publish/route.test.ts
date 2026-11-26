import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));
vi.mock("@/lib/publishing/connection", () => ({
  resolvePageTargets: vi.fn(),
}));
vi.mock("@/lib/facebook", () => ({
  publishPagePost: vi.fn(),
  parseImages: vi.fn(() => []),
  redactTokens: (value: string) => value,
  FacebookApiError: class FacebookApiError extends Error {},
}));
vi.mock("@/lib/notifications", () => ({
  notifyTokenInvalid: vi.fn(),
  notifyWorkspace: vi.fn(),
}));
vi.mock("@/lib/schedule-mirror", () => ({ recordNativeSchedule: vi.fn() }));
vi.mock("@/lib/avatar/queue", () => ({
  claimAvatarForPublish: vi.fn(),
  releaseAvatarPublish: vi.fn(),
  finishAvatarPublish: vi.fn(),
}));
vi.mock("@/lib/publishing/videos", () => ({
  downloadVideoFromUrl: vi.fn(),
  publishPageVideo: vi.fn(),
  MAX_VIDEO_BYTES: 1024 * 1024 * 1024,
}));
vi.mock("@/lib/reel-meta", () => ({ readMp4DurationSecondsFromFile: vi.fn() }));
vi.mock("@/lib/blob", () => ({ deleteStagedBlobs: vi.fn() }));

import { sql } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { resolvePageTargets } from "@/lib/publishing/connection";
import { publishPagePost } from "@/lib/facebook";
import { recordNativeSchedule } from "@/lib/schedule-mirror";
import {
  claimAvatarForPublish,
  finishAvatarPublish,
  releaseAvatarPublish,
} from "@/lib/avatar/queue";
import {
  downloadVideoFromUrl,
  publishPageVideo,
} from "@/lib/publishing/videos";
import { readMp4DurationSecondsFromFile } from "@/lib/reel-meta";
import { deleteStagedBlobs } from "@/lib/blob";
import { POST } from "./route";

const sqlMock = sql as unknown as Mock;
const sessionMock = requireWorkspace as unknown as Mock;
const targetsMock = resolvePageTargets as unknown as Mock;
const publishMock = publishPagePost as unknown as Mock;
const mirrorMock = recordNativeSchedule as unknown as Mock;
const claimMock = claimAvatarForPublish as unknown as Mock;
const releaseMock = releaseAvatarPublish as unknown as Mock;
const finishMock = finishAvatarPublish as unknown as Mock;
const downloadMock = downloadVideoFromUrl as unknown as Mock;
const videoMock = publishPageVideo as unknown as Mock;
const durationMock = readMp4DurationSecondsFromFile as unknown as Mock;
const deleteMock = deleteStagedBlobs as unknown as Mock;

const access = {
  user: { id: "u1" },
  workspace: { id: "ws_1", role: "owner" },
};

const targets = [
  { id: "page_1", name: "The Daily Buzz", accessToken: "page-token" },
];

const permalink = "https://www.facebook.com/dailybuzz/posts/post_1";
const avatarDbUrl = "https://store.example/avatar-owned.mp4";
const upload = {
  path: "/tmp/avatar.mp4",
  size: 10,
  type: "video/mp4",
  filename: "avatar.mp4",
};

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  sessionMock.mockResolvedValue(access);
  targetsMock.mockResolvedValue(targets);
  publishMock.mockResolvedValue({ id: "post_1", permalink });
  mirrorMock.mockResolvedValue(77);
  claimMock.mockResolvedValue(avatarDbUrl);
  releaseMock.mockResolvedValue(undefined);
  finishMock.mockResolvedValue(true);
  downloadMock.mockResolvedValue({ upload, cleanup: vi.fn().mockResolvedValue(undefined) });
  durationMock.mockResolvedValue(null);
  videoMock.mockResolvedValue({ id: "fb_avatar", permalink: null });
  deleteMock.mockResolvedValue(undefined);
  // 1) the connection scopes, 2) the story and its draft, 3) the draft flip.
  sqlMock
    .mockResolvedValueOnce([{ scopes: "pages_manage_posts" }])
    .mockResolvedValueOnce([{ id: 7, draft_id: 42 }])
    .mockResolvedValueOnce([]);
});

describe("POST /api/publish", () => {
  it("mirrors the publish so the platform counters see it", async () => {
    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline", pageId: "page_1" })
    );

    expect(response.status).toBe(200);
    // The publish reached the Page...
    expect(publishMock).toHaveBeenCalledWith({
      pageId: "page_1",
      accessToken: "page-token",
      message: "Behind the headline",
      images: [],
    });
    // ...and left a row behind, linked to the draft it published so the
    // activity log keeps one entry for it.
    expect(mirrorMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "u1",
      kind: "post",
      text: "Behind the headline",
      scheduledFor: null,
      results: [
        {
          page: { id: "page_1", name: "The Daily Buzz" },
          ok: true,
          id: "post_1",
          permalink,
        },
      ],
      newsItemId: 7,
      draftId: 42,
    });
  });

  it("records the publish without a draft when none was flipped", async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ scopes: "pages_manage_posts" }])
      // The story belongs to the workspace but has no draft yet.
      .mockResolvedValueOnce([{ id: 7, draft_id: null }]);

    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline" })
    );

    expect(response.status).toBe(200);
    expect(mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "post", newsItemId: 7, draftId: null })
    );
  });

  it("links no story the workspace does not own", async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ scopes: "pages_manage_posts" }])
      // The story belongs to another workspace: the lookup finds nothing.
      .mockResolvedValueOnce([]);

    const response = await POST(
      post({ newsItemId: 999, message: "Behind the headline" })
    );

    // The post still reaches the Page...
    expect(response.status).toBe(200);
    expect(publishMock).toHaveBeenCalled();
    // ...but nothing is linked to a foreign story, whose headline would
    // otherwise surface in this workspace's Activity feed.
    expect(mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ newsItemId: null, draftId: null })
    );
    // No draft was flipped either.
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it("mirrors nothing when the publish fails", async () => {
    publishMock.mockRejectedValue(new Error("Facebook said no"));

    const response = await POST(
      post({ newsItemId: 7, message: "Behind the headline" })
    );

    expect(response.status).toBe(500);
    expect(mirrorMock).not.toHaveBeenCalled();
  });

  it("claims an avatar before media access and cleans up only after durable completion", async () => {
    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://client.example/not-trusted.mp4",
      })
    );

    expect(claimMock).toHaveBeenCalledWith(
      "avatar-1",
      "ws_1",
      "https://client.example/not-trusted.mp4"
    );
    expect(response.status).toBe(200);
    expect(downloadMock).toHaveBeenCalledWith(avatarDbUrl);
    expect(videoMock).toHaveBeenCalledWith(
      expect.objectContaining({ video: upload, description: "Avatar update" })
    );
    expect(mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ avatarJobId: "avatar-1", kind: "video" })
    );
    expect(finishMock).toHaveBeenCalledWith("avatar-1", "ws_1", 77);
    expect(deleteMock).toHaveBeenCalledWith([avatarDbUrl]);
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      downloadMock.mock.invocationCallOrder[0]
    );
    expect(downloadMock.mock.invocationCallOrder[0]).toBeLessThan(
      videoMock.mock.invocationCallOrder[0]
    );
    expect(videoMock.mock.invocationCallOrder[0]).toBeLessThan(
      mirrorMock.mock.invocationCallOrder[0]
    );
    expect(mirrorMock.mock.invocationCallOrder[0]).toBeLessThan(
      finishMock.mock.invocationCallOrder[0]
    );
    expect(finishMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMock.mock.invocationCallOrder[0]
    );
  });

  it("rejects a stale or foreign avatar with 409 before downloading", async () => {
    claimMock.mockResolvedValue(null);

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-missing",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(409);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(videoMock).not.toHaveBeenCalled();
    expect(mirrorMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("requires an avatar video URL before claiming", async () => {
    const response = await POST(
      post({ newsItemId: 7, message: "Avatar update", avatarJobId: "avatar-1" })
    );

    expect(response.status).toBe(400);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("releases the avatar claim when the download fails before Graph", async () => {
    downloadMock.mockRejectedValue(new Error("storage unavailable"));

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(500);
    expect(releaseMock).toHaveBeenCalledWith("avatar-1", "ws_1");
    expect(videoMock).not.toHaveBeenCalled();
    expect(mirrorMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("releases the avatar claim on an early media-type validation return", async () => {
    downloadMock.mockResolvedValue({
      upload: { ...upload, type: "image/png" },
      cleanup: vi.fn().mockResolvedValue(undefined),
    });

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(400);
    expect(releaseMock).toHaveBeenCalledWith("avatar-1", "ws_1");
    expect(videoMock).not.toHaveBeenCalled();
  });

  it("releases the avatar claim on an early duration validation return", async () => {
    durationMock.mockResolvedValue(46 * 60);

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(400);
    expect(releaseMock).toHaveBeenCalledWith("avatar-1", "ws_1");
    expect(videoMock).not.toHaveBeenCalled();
  });

  it("releases the avatar claim on an early upload-size validation return", async () => {
    downloadMock.mockResolvedValue({
      upload: { ...upload, size: 1024 * 1024 * 1024 + 1 },
      cleanup: vi.fn().mockResolvedValue(undefined),
    });

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(400);
    expect(releaseMock).toHaveBeenCalledWith("avatar-1", "ws_1");
    expect(videoMock).not.toHaveBeenCalled();
  });

  it("retains the avatar claim when Graph may already have accepted the publish", async () => {
    videoMock.mockRejectedValue(new Error("connection lost after upload"));

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(500);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(mirrorMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("reports the external publish but retains media and claim when mirroring fails", async () => {
    mirrorMock.mockResolvedValue(null);

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe("fb_avatar");
    expect(data.warning).toContain("kept for recovery");
    expect(videoMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("does not delete avatar media until the ownership finish is confirmed", async () => {
    finishMock.mockResolvedValue(false);

    const response = await POST(
      post({
        newsItemId: 7,
        message: "Avatar update",
        avatarJobId: "avatar-1",
        videoUrl: "https://store.example/avatar.mp4",
      })
    );

    expect(response.status).toBe(200);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
