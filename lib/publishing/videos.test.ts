// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadVideoFromUrl, publishPageVideo } from "./videos";

function responseFor(body: Uint8Array, init?: { status?: number; type?: string }) {
  // Uint8Array<ArrayBufferLike> vs BodyInit: a narrow cast keeps the stub simple.
    return new Response(body as unknown as BodyInit, {
    status: init?.status ?? 200,
    headers: { "content-type": init?.type ?? "video/mp4" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishPageVideo", () => {
  it("persists the publish marker after transfer and immediately before finish", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ph-video-test-"));
    const filePath = path.join(dir, "video.mp4");
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4, 5]));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ upload_session_id: "session-1", video_id: "video-1" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ id: "video-1" }))
      .mockResolvedValueOnce(jsonResponse({ permalink_url: "https://facebook.example/video-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const beforePublish = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(
        publishPageVideo({
          pageId: "pg1",
          accessToken: "tok",
          video: { path: filePath, size: 5, type: "video/mp4", filename: "video.mp4" },
          beforePublish,
        }),
      ).resolves.toEqual({ id: "video-1", permalink: "https://facebook.example/video-1" });

      expect(beforePublish).toHaveBeenCalledTimes(1);
      expect(beforePublish).toHaveBeenCalledWith("video-1");
      expect(beforePublish.mock.invocationCallOrder[0]).toBeGreaterThan(
        fetchMock.mock.invocationCallOrder[1]
      );
      expect(beforePublish.mock.invocationCallOrder[0]).toBeLessThan(
        fetchMock.mock.invocationCallOrder[2]
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("downloadVideoFromUrl", () => {
  it("streams the video to a temp file and cleans it up", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(bytes)));

    const { upload, cleanup } = await downloadVideoFromUrl(
      "https://store.example/v.mp4"
    );

    expect(existsSync(upload.path)).toBe(true);
    expect(upload.size).toBe(5);
    expect(upload.type).toBe("video/mp4");
    expect(upload.filename).toBe("video.mp4");

    await cleanup();
    expect(existsSync(upload.path)).toBe(false);
  });

  it("refuses loopback and private hosts before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://127.0.0.1:8080/v.mp4",
      "http://localhost/v.mp4",
      "http://192.168.1.10/v.mp4",
      "http://10.0.0.5/v.mp4",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      await expect(downloadVideoFromUrl(url)).rejects.toThrow(
        /not allowed/
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirect responses instead of following them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } })
      )
    );

    await expect(
      downloadVideoFromUrl("https://store.example/v.mp4")
    ).rejects.toThrow(/could not be read/);
  });

  it("rejects empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(new Uint8Array(0))));

    await expect(
      downloadVideoFromUrl("https://store.example/v.mp4")
    ).rejects.toThrow(/could not be read/);
  });
});
