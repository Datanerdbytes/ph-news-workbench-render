// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAvatarVideo } from "./avatar-video";

function webmResponse(): Response {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "video/webm" },
  });
}

function mp4Response(size = 16): Response {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "video/mp4" },
  });
}

describe("loadAvatarVideo", () => {
  let video: {
    src: string;
    duration: number;
    videoWidth: number;
    videoHeight: number;
    readyState: number;
    currentTime: number;
    onloadeddata: (() => void) | null;
    onerror: (() => void) | null;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    removeAttribute: ReturnType<typeof vi.fn>;
  };
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let originalCreateObjectURL: PropertyDescriptor | undefined;
  let originalRevokeObjectURL: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "blob");
    let source = "";
    let objectUrlIndex = 0;
    video = {
      src: "",
      duration: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      readyState: 2,
      currentTime: 0,
      onloadeddata: null,
      onerror: null,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn((name: string) => {
        if (name === "src") source = "";
      }),
    };
    Object.defineProperty(video, "src", {
      get: () => source,
      set: (value: string) => {
        source = value;
        if (value) queueMicrotask(() => video.onloadeddata?.());
      },
    });
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ) => {
      if (tag === "video") return video as unknown as HTMLElement;
      return originalCreateElement.call(document, tag, options);
    }) as typeof document.createElement);

    originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    createObjectURL = vi.fn(() => `blob:loaded-avatar-${++objectUrlIndex}`);
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
    } else {
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("uses an existing blob URL without fetching or owning it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const loaded = await loadAvatarVideo("blob:avatar");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loaded.video.src).toBe("blob:avatar");
    loaded.release();
    expect(video.pause).toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("downloads an approved MP4 and revokes its object URL on release", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mp4Response());
    vi.stubGlobal("fetch", fetchMock);
    const loaded = await loadAvatarVideo(
      "https://store.public.blob.vercel-storage.com/avatar/source.mp4",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://store.public.blob.vercel-storage.com/avatar/source.mp4"),
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(loaded.video.src).toBe("blob:loaded-avatar-1");
    loaded.release();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:loaded-avatar-1");
  });

  it("downloads an approved WebM with alpha preserved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(webmResponse()));

    const loaded = await loadAvatarVideo(
      "https://store.public.blob.vercel-storage.com/avatar/source.webm",
    );

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("video/webm");
    expect(loaded.video.src).toBe("blob:loaded-avatar-1");
    loaded.release();
  });

  it("uses same-origin credentials for authenticated avatar media", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mp4Response());
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadAvatarVideo(
      "/api/avatar/syntheses/job-1/video",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/avatar/syntheses/job-1/video", window.location.href),
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "error",
      }),
    );
    loaded.release();
  });

  it("rejects an unapproved host before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      loadAvatarVideo("https://avatar.example.com/source.mp4"),
    ).rejects.toThrow("The avatar video source is not supported.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a redirect instead of following it in the browser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://avatar.example.com/source.mp4" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      loadAvatarVideo(
        "https://store.public.blob.vercel-storage.com/avatar/source.mp4",
      ),
    ).rejects.toThrow("The avatar video redirect could not be verified.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to follow an approved redirect instead of chasing hops in the browser", async () => {
    // The hop points at another approved host, but the browser never chases
    // it: redirect resolution happens server-side, where every hop is
    // validated before the media reaches the client.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://store.public.blob.vercel-storage.com/other.mp4",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadAvatarVideo(
        "https://store.public.blob.vercel-storage.com/avatar/source.mp4",
      ),
    ).rejects.toThrow("The avatar video redirect could not be verified.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://store.public.blob.vercel-storage.com/avatar/source.mp4"),
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an oversized response before reading its body", async () => {
    const response = mp4Response();
    response.headers.set("content-length", String(256 * 1024 * 1024 + 1));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      loadAvatarVideo(
        "https://store.public.blob.vercel-storage.com/avatar/source.mp4",
      ),
    ).rejects.toThrow("The avatar video is too large to composite in this browser.");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects a response that is not an MP4", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))),
    );
    await expect(
      loadAvatarVideo(
        "https://store.public.blob.vercel-storage.com/avatar/source.mp4",
      ),
    ).rejects.toThrow("The avatar source is not a valid MP4 or WebM video.");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("loads an avatar from the configured managed s3 origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "s3");
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/stage") {
        return Promise.resolve(
          Response.json({ publicOrigin: "https://media.example.com" }),
        );
      }
      return Promise.resolve(mp4Response());
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadAvatarVideo(
      "https://media.example.com/compose/avatars/avatar-1/source.mp4",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/stage",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    );
    expect(loaded.video.src).toBe("blob:loaded-avatar-1");
    loaded.release();
  });

  it("rejects lookalike and cross-origin s3 URLs", async () => {
    vi.resetModules();
    const { loadAvatarVideo: freshLoadAvatarVideo } = await import(
      "./avatar-video"
    );
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "s3");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ publicOrigin: "https://media.example.com" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      freshLoadAvatarVideo("https://media.example.com.evil.test/source.mp4"),
    ).rejects.toThrow("The avatar video source is not supported.");
    await expect(
      freshLoadAvatarVideo("https://media.example.com:8443/source.mp4"),
    ).rejects.toThrow("The avatar video source is not supported.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/stage",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed when the managed origin response is malformed", async () => {
    vi.resetModules();
    const { prepareAvatarVideoSource: freshPrepareAvatarVideoSource } =
      await import("./avatar-video");
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "s3");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ publicOrigin: "https://user:pass@media.example.com" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      freshPrepareAvatarVideoSource("https://media.example.com/source.mp4"),
    ).rejects.toThrow("The avatar video source is not supported.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a managed s3 redirect to a foreign origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "s3");
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/stage") {
        return Promise.resolve(
          Response.json({ publicOrigin: "https://media.example.com" }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/source.mp4" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadAvatarVideo("https://media.example.com/source.mp4"),
    ).rejects.toThrow("The avatar video redirect could not be verified.");
  });

  it("coalesces concurrent managed loads without sharing owned object URLs", async () => {
    vi.resetModules();
    const { prepareAvatarVideoSource: freshPrepareAvatarVideoSource } =
      await import("./avatar-video");
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "s3");
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/stage") {
        return Promise.resolve(
          Response.json({ publicOrigin: "https://media.example.com" }),
        );
      }
      return Promise.resolve(mp4Response());
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      freshPrepareAvatarVideoSource("https://media.example.com/source.mp4"),
      freshPrepareAvatarVideoSource("https://media.example.com/source.mp4"),
    ]);

    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/stage"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => input !== "/api/stage"),
    ).toHaveLength(1);
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(true);
    expect(first.url).not.toBe(second.url);
    URL.revokeObjectURL(first.url);
    URL.revokeObjectURL(second.url);
    expect(revokeObjectURL).toHaveBeenCalledWith(first.url);
    expect(revokeObjectURL).toHaveBeenCalledWith(second.url);
  });
});
