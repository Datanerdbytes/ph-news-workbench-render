// @vitest-environment node
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadVideoFromUrl } from "./videos";

function responseFor(body: Uint8Array, init?: { status?: number; type?: string }) {
  // Uint8Array<ArrayBufferLike> vs BodyInit: a narrow cast keeps the stub simple.
    return new Response(body as unknown as BodyInit, {
    status: init?.status ?? 200,
    headers: { "content-type": init?.type ?? "video/mp4" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
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
