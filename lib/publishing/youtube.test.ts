import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blob", async (importOriginal) => {
  // stagedFileExtension stays real — the content type is derived from it.
  const actual = await importOriginal<typeof import("@/lib/blob")>();
  return {
    ...actual,
    assertStagedBlob: vi.fn(async () => undefined),
    stagedFileToTempFile: vi.fn(),
    deleteStagedBlobs: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/youtube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/youtube")>();
  return {
    ...actual,
    createYouTubeUploadSession: vi.fn(
      async () => "https://upload.google/session-1"
    ),
    uploadYouTubeFile: vi.fn(async () => "video-1"),
  };
});

import {
  createYouTubeUploadSession,
  uploadYouTubeFile,
} from "@/lib/youtube";
import { publishYouTubeVideo } from "./youtube";

const sessionMock = vi.mocked(createYouTubeUploadSession) as unknown as ReturnType<typeof vi.fn>;
const fileMock = uploadYouTubeFile as unknown as ReturnType<typeof vi.fn>;
const blobModule = await import("@/lib/blob");
const stagedMock = (blobModule as unknown as {
  stagedFileToTempFile: ReturnType<typeof vi.fn>;
}).stagedFileToTempFile;
const assertMock = (blobModule as unknown as {
  assertStagedBlob: ReturnType<typeof vi.fn>;
}).assertStagedBlob;

beforeEach(() => {
  sessionMock.mockClear();
  fileMock.mockClear();
  stagedMock.mockClear();
  assertMock.mockClear();
});

const metadata = {
  title: "Newsroom cut",
  description: "",
  privacyStatus: "unlisted" as const,
  madeForKids: false,
};

/** stagedFileToTempFile result with a real (cleanable) temp dir. */
async function stagedResult(size: number) {
  const workDir = await mkdtemp(path.join(tmpdir(), "youtube-publish-test-"));
  return { workDir, path: path.join(workDir, "video"), size };
}

describe("publishYouTubeVideo", () => {
  it("asserts staging, opens the session with the blob's size, and returns the watch link", async () => {
    stagedMock.mockResolvedValue(await stagedResult(1024));
    const result = await publishYouTubeVideo({
      accessToken: "token",
      metadata,
      videoUrl: "https://x.public.blob.vercel-storage.com/youtube/a.mp4",
    });
    expect(assertMock).toHaveBeenCalledTimes(1);
    const sessionArgs = sessionMock.mock.calls[0][0];
    expect(sessionArgs.sizeBytes).toBe(1024);
    expect(sessionArgs.contentType).toBe("video/mp4");
    expect(sessionArgs.metadata).toEqual(metadata);
    expect(fileMock).toHaveBeenCalledWith(
      "https://upload.google/session-1",
      expect.any(String),
      1024,
      "video/mp4"
    );
    expect(result).toEqual({
      id: "video-1",
      permalink: "https://www.youtube.com/watch?v=video-1",
    });
  });

  it("removes the temp download after publishing", async () => {
    const staged = await stagedResult(1024);
    stagedMock.mockResolvedValue(staged);
    await publishYouTubeVideo({
      accessToken: "token",
      metadata,
      videoUrl: "https://x.public.blob.vercel-storage.com/youtube/a.mp4",
    });
    await expect(rm(staged.workDir, { recursive: true })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the temp download when the upload fails", async () => {
    const staged = await stagedResult(1024);
    stagedMock.mockResolvedValue(staged);
    fileMock.mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      publishYouTubeVideo({
        accessToken: "token",
        metadata,
        videoUrl: "https://x.public.blob.vercel-storage.com/youtube/a.mp4",
      })
    ).rejects.toThrow(/upload failed/);
    await expect(rm(staged.workDir, { recursive: true })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("treats .mov staging as quicktime", async () => {
    stagedMock.mockResolvedValue(await stagedResult(1024));
    await publishYouTubeVideo({
      accessToken: "token",
      metadata,
      videoUrl: "https://x.public.blob.vercel-storage.com/youtube/b.mov",
    });
    expect(sessionMock.mock.calls[0][0].contentType).toBe("video/quicktime");
  });

  it("treats a staged .mov with the random key suffix as quicktime", async () => {
    // The s3 and hf drivers append "-<uuid8>" AFTER the pathname, so the
    // extension is only visible once that suffix is stripped.
    stagedMock.mockResolvedValue(await stagedResult(1024));
    await publishYouTubeVideo({
      accessToken: "token",
      metadata,
      videoUrl: "https://x.example.com/youtube/b.mov-a1b2c3d4",
    });
    expect(sessionMock.mock.calls[0][0].contentType).toBe("video/quicktime");
  });

  it("rejects empty staged files", async () => {
    stagedMock.mockResolvedValue(await stagedResult(0));
    await expect(
      publishYouTubeVideo({ accessToken: "t", metadata, videoUrl: "https://x.public.blob.vercel-storage.com/youtube/c.mp4" })
    ).rejects.toThrow(/empty/);
  });

  it("enforces the 1 GB staging cap", async () => {
    stagedMock.mockResolvedValue(await stagedResult(1024 * 1024 * 1024 + 1));
    await expect(
      publishYouTubeVideo({ accessToken: "t", metadata, videoUrl: "https://x.public.blob.vercel-storage.com/youtube/d.mp4" })
    ).rejects.toThrow(/1 GB staging cap/);
  });
});
