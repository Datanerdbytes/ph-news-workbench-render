// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bakeAndFinalizeVideo,
  bakeVideoAnimation,
  composeVideoFrame,
  outputSize,
  widescreenSize,
} from "./bake";
import { getVideoPreset, type PlannedVideoEffect } from "./presets";

const { finalizeBakedVideoMock } = vi.hoisted(() => ({
  finalizeBakedVideoMock: vi.fn(),
}));

// The finalizer runs a real ffmpeg transcode; the bake only owns the options
// it hands over, so the transcode itself is stubbed here.
vi.mock("@/lib/reels/browser-normalize", () => ({
  finalizeBakedVideo: finalizeBakedVideoMock,
}));

function stubCtx() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const BOX = { w: 1920, h: 1080 };

describe("outputSize", () => {
  it("keeps landscape sources at their own size", () => {
    expect(outputSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
  });

  it("keeps portrait sources portrait", () => {
    expect(outputSize(1080, 1920)).toEqual({ w: 1080, h: 1920 });
  });

  it("caps the longest side and preserves the aspect ratio", () => {
    expect(outputSize(3840, 2160)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize(2160, 3840)).toEqual({ w: 1080, h: 1920 });
    expect(outputSize(2560, 1080, 1280)).toEqual({ w: 1280, h: 540 });
  });

  it("rounds to even dimensions — encoders reject odd sizes", () => {
    const { w, h } = outputSize(1281, 721);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
    expect({ w, h }).toEqual({ w: 1282, h: 722 });
  });

  it("falls back to 1080p when the source reports no size", () => {
    expect(outputSize(0, 0)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize(Number.NaN, Number.NaN)).toEqual({ w: 1920, h: 1080 });
  });
});

describe("widescreenSize", () => {
  it("uses a 1920x1080 canvas for 16:9 bakes", () => {
    expect(widescreenSize()).toEqual({ w: 1920, h: 1080 });
  });

  it("uses 1280x720 when maxSide is 1280", () => {
    expect(widescreenSize(1280)).toEqual({ w: 1280, h: 720 });
  });
});

describe("composeVideoFrame", () => {
  const draws: string[] = [];

  function effect(
    presetId: string,
    slot: "start" | "middle" | "end",
    loop: boolean,
    start: number
  ): PlannedVideoEffect {
    const preset = getVideoPreset(presetId)!;
    return {
      preset: {
        ...preset,
        draw: (ctx, t) => {
          (ctx as unknown as { t: number }).t = t;
          draws.push(`${presetId}:${slot}:${t.toFixed(2)}`);
        },
        stream: preset.stream
          ? (ctx, t) => {
              (ctx as unknown as { t: number }).t = t;
              draws.push(`${presetId}:stream:${t.toFixed(2)}`);
            }
          : undefined,
      },
      slot,
      loop,
      start,
      values: {},
    };
  }

  it("draws footage first, then each overlay in attachment order", () => {
    draws.length = 0;
    const { ctx, calls } = stubCtx();
    const opener = effect("cinema-title", "start", false, 14);
    const mid = effect("stat-ring", "middle", false, 14);
    composeVideoFrame(ctx, [opener, mid], 14.5, (zoom) => {
      expect(zoom).toBe(1);
      calls.push("footage");
    }, BOX);
    expect(calls[0]).toBe("footage");
    expect(calls.filter((call) => call === "save")).toHaveLength(2);
    expect(draws).toEqual(["cinema-title:start:0.50", "stat-ring:middle:0.50"]);
  });

  it("multiplies camera zoom from every active scale preset", () => {
    draws.length = 0;
    const { ctx } = stubCtx();
    const camera = effect("camera-push", "middle", false, 0);
    const camera2 = effect("camera-push", "start", false, 0);
    const zooms: number[] = [];
    composeVideoFrame(ctx, [camera, camera2], 5.2, (zoom) => zooms.push(zoom), BOX);
    expect(zooms).toHaveLength(1);
    expect(zooms[0]).toBeGreaterThan(1);
  });

  it("streams a looped ticker through one unbounded local time", () => {
    draws.length = 0;
    const { ctx } = stubCtx();
    const ticker = effect("news-ticker", "start", true, 0);
    composeVideoFrame(ctx, [ticker], 11.5, () => {}, BOX);
    expect(draws).toEqual(["news-ticker:stream:11.50"]);
  });

  it("draws nothing extra when no effect is on screen", () => {
    draws.length = 0;
    const { ctx, calls } = stubCtx();
    composeVideoFrame(
      ctx,
      [effect("cinema-title", "start", false, 0)],
      9,
      () => calls.push("footage"),
      BOX
    );
    expect(calls).toEqual(["footage"]);
    expect(draws).toEqual([]);
  });
});

describe("bakeVideoAnimation playback lifecycle", () => {
  const attachments = [
    { presetId: "cinema-title", slot: "start" as const, loop: false },
  ];

  let hidden = false;
  let video: Record<string, unknown> & {
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  };
  let avatar: ReturnType<typeof makeVideo>;
  let frames: FrameRequestCallback[];
  let recorders: FakeRecorder[];
  let canvases: HTMLCanvasElement[];
  let drawImageCalls: unknown[][];
  let gains: Array<{
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: () => void;
    disconnect: () => void;
  }>;
  let mediaSources: unknown[];
  let narrationSources: Array<{
    buffer: unknown;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>;
  let audioDuration = 2;
  let avatarDuration = 2;
  let gainEvents: string[];
  let originalCreateElement: typeof document.createElement;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalCaptureStream: unknown;
  let originalRecorder: unknown;
  let originalAudioContext: unknown;
  let originalRaf: typeof requestAnimationFrame;
  let originalCaf: typeof cancelAnimationFrame;

  class FakeRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["video"]) });
      this.onstop?.();
    }
  }

  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createMediaElementSource(element: unknown) {
      mediaSources.push(element);
      return { connect: () => {}, disconnect: () => {} };
    }
    decodeAudioData() {
      return Promise.resolve({ duration: audioDuration });
    }
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      narrationSources.push(source);
      return source;
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ stop: () => {} }] } };
    }
    createGain() {
      const gain = {
        gain: {
          value: 0,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(() => {
            gainEvents.push("duck");
          }),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: () => {},
        disconnect: () => {},
      };
      gains.push(gain);
      return gain;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }

  function fakeCtx() {
    const store = new Map<PropertyKey, unknown>();
    const gradient = { addColorStop: () => {} };
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "drawImage") {
          return (...args: unknown[]) => drawImageCalls.push(args);
        }
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop === "createLinearGradient") return () => gradient;
        if (prop === "createRadialGradient") return () => gradient;
        if (!target.has(prop)) return () => undefined;
        return target.get(prop);
      },
      set(target, prop, value) {
        target.set(prop, value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  function makeVideo(duration = 1) {
    let src = "";
    let metadataFired = false;
    let dataFired = false;
    const element = {
      src: "",
      currentTime: 0,
      duration,
      videoWidth: 1920,
      videoHeight: 1080,
      readyState: 2,
      onloadedmetadata: null as (() => void) | null,
      onloadeddata: null as (() => void) | null,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn((name: string) => {
        if (name === "src") src = "";
      }),
    };
    Object.defineProperty(element, "src", {
      get: () => src,
      set: (value: string) => {
        src = value;
        if (value && !metadataFired) {
          metadataFired = true;
          queueMicrotask(() => element.onloadedmetadata?.());
        }
        if (value && !dataFired) {
          dataFired = true;
          queueMicrotask(() => element.onloadeddata?.());
        }
      },
    });
    return element;
  }

  beforeEach(() => {
    hidden = false;
    frames = [];
    recorders = [];
    canvases = [];
    drawImageCalls = [];
    gains = [];
    mediaSources = [];
    narrationSources = [];
    finalizeBakedVideoMock.mockReset();
    finalizeBakedVideoMock.mockResolvedValue(
      new File(["mp4"], "baked.mp4", { type: "video/mp4" }),
    );
    audioDuration = 2;
    avatarDuration = 2;
    gainEvents = [];
    video = makeVideo();
    avatar = makeVideo(avatarDuration);
    let createdVideos = 0;

    originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ) => {
      if (tag === "video") {
        const element = createdVideos++ === 0 ? video : avatar;
        return element as unknown as HTMLElement;
      }
      const element = originalCreateElement.call(document, tag, options);
      if (tag === "canvas") canvases.push(element as HTMLCanvasElement);
      return element;
    }) as typeof document.createElement);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });

    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;

    originalCaptureStream = (
      HTMLCanvasElement.prototype as unknown as {
        captureStream?: unknown;
      }
    ).captureStream;
    (
      HTMLCanvasElement.prototype as unknown as {
        captureStream: () => MediaStream;
      }
    ).captureStream = () => ({
      getTracks: () => [{ stop: () => {} }],
      addTrack: () => {},
    }) as unknown as MediaStream;

    originalRecorder = globalThis.MediaRecorder;
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    originalAudioContext = globalThis.AudioContext;
    globalThis.AudioContext =
      FakeAudioContext as unknown as typeof AudioContext;

    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { hidden?: boolean }).hidden;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    (
      HTMLCanvasElement.prototype as unknown as {
        captureStream?: unknown;
      }
    ).captureStream = originalCaptureStream;
    globalThis.MediaRecorder = originalRecorder as typeof MediaRecorder;
    globalThis.AudioContext = originalAudioContext as typeof AudioContext;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });

  it("cover-crops portrait footage onto a 16:9 canvas", async () => {
    video.videoWidth = 1080;
    video.videoHeight = 1920;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments,
      values: {},
      aspectRatio: "16:9",
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    expect(canvases).toHaveLength(1);
    expect({ width: canvases[0].width, height: canvases[0].height }).toEqual({
      width: 1920,
      height: 1080,
    });

    now = 34;
    frames.shift()?.(34);
    expect(drawImageCalls).toHaveLength(1);
    const [source, x, y, width, height] = drawImageCalls[0];
    expect(source).toBe(video);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(-1166.6666667);
    expect(width).toBe(1920);
    expect(height).toBeCloseTo(3413.3333333);

    recorders[0].onerror?.();
    await expect(bake).rejects.toThrow("Recording failed.");
  });

  it("rejects a bake that starts while the tab is already hidden", async () => {
    hidden = true;
    await expect(
      bakeVideoAnimation({ videoUrl: "blob:test", attachments, values: {} })
    ).rejects.toThrow("The tab was hidden, so the animation bake was stopped.");
    expect(video.pause).toHaveBeenCalled();
    // The guard runs before playback handlers are attached.
    expect(video.onended).toBeNull();
  });

  it("rejects when the tab hides while the take is recording", async () => {
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments,
      values: {},
    });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await expect(bake).rejects.toThrow(
      "The tab was hidden, so the animation bake was stopped."
    );
    expect(video.pause).toHaveBeenCalled();
  });

  it("ends the take as soon as the recorder fails", async () => {
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments,
      values: {},
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    // Playback is still running; the recorder fails mid-clip.
    expect(frames).toHaveLength(1);
    recorders[0].onerror?.();
    await expect(bake).rejects.toThrow("Recording failed.");
    expect(video.pause).toHaveBeenCalled();
  });
  it("layers the avatar over footage and restores original audio after it ends", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      aspectRatio: "16:9",
      avatarUrl: "blob:avatar",
      avatarPlacement: { x: 0.1, y: 0.2, width: 0.5 },
      originalAudioVolume: 0.25,
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    expect(mediaSources).toEqual([video, avatar]);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(avatar.play).toHaveBeenCalledTimes(1);
    expect(gains[0].gain.value).toBe(0.25);
    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledWith(0.25, 0);
    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledWith(0.25, 2);
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 2.2);

    video.currentTime = 0.5;
    avatar.currentTime = 0.5;
    now = 40;
    frames.shift()?.(40);
    expect(drawImageCalls).toHaveLength(2);
    expect(drawImageCalls[0][0]).toBe(video);
    expect(drawImageCalls[1]).toEqual([avatar, 192, 216, 960, 540]);

    video.currentTime = 1;
    avatar.currentTime = 2;
    now = 2_100;
    frames.shift()?.(2_100);
    avatar.onended?.();
    await expect(bake).resolves.toBeInstanceOf(Blob);
    expect(avatar.pause).toHaveBeenCalled();
    expect(avatar.src).toBe("");
  });

  it("starts the recorder before either element plays and ducks with the avatar", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const playOrder: string[] = [];
    video.play = vi.fn(() => {
      playOrder.push(`video:${recorders[0]?.state ?? "no-recorder"}`);
      return Promise.resolve();
    });
    avatar.play = vi.fn(() => {
      playOrder.push(`avatar:${recorders[0]?.state ?? "no-recorder"}`);
      return Promise.resolve();
    });

    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    await vi.waitFor(() => expect(playOrder).toHaveLength(2));

    // The recorder is already running when each element is asked to play, so
    // no part of the opening narration falls outside the recording.
    expect(playOrder).toEqual(["video:recording", "avatar:recording"]);

    // The ducking schedule is anchored to the avatar's play, before the first
    // frame is composited.
    const firstFrame = frames[0];
    frames[0] = (time: number) => {
      gainEvents.push("frame");
      firstFrame(time);
    };
    now = 40;
    frames.shift()?.(40);
    expect(gainEvents.indexOf("duck")).toBeLessThan(gainEvents.indexOf("frame"));

    recorders[0].onerror?.();
    await expect(bake).rejects.toThrow("Recording failed.");
  });

  it("preserves the source aspect when finalizing an avatar composite", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeAndFinalizeVideo({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    video.currentTime = 1;
    avatar.currentTime = 2;
    now = 2_100;
    frames.shift()?.(2_100);
    avatar.onended?.();

    await expect(bake).resolves.toBeInstanceOf(File);
    expect(finalizeBakedVideoMock).toHaveBeenCalledWith(
      expect.any(Blob),
      undefined,
      expect.objectContaining({
        preserveAspect: true,
        aspectRatio: undefined,
        name: "avatar-composite.mp4",
      }),
    );
  });

  it("leaves an explicit 16:9 avatar bake cropped as requested", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeAndFinalizeVideo({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
      aspectRatio: "16:9",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    video.currentTime = 1;
    avatar.currentTime = 2;
    now = 2_100;
    frames.shift()?.(2_100);
    avatar.onended?.();

    await expect(bake).resolves.toBeInstanceOf(File);
    expect(finalizeBakedVideoMock).toHaveBeenCalledWith(
      expect.any(Blob),
      undefined,
      expect.objectContaining({
        preserveAspect: false,
        aspectRatio: "16:9",
      }),
    );
  });

  it("removes the overlay after a shorter avatar ends", async () => {
    avatar.duration = 0.5;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    video.currentTime = 0.1;
    avatar.currentTime = 0.5;
    now = 40;
    frames.shift()?.(40);
    expect(drawImageCalls.map((call) => call[0])).toEqual([video, avatar]);

    avatar.onended?.();
    video.currentTime = 0.2;
    now = 80;
    frames.shift()?.(80);
    expect(drawImageCalls.map((call) => call[0])).toEqual([video, avatar, video]);
    recorders[0].onerror?.();
    await expect(bake).rejects.toThrow("Recording failed.");
  });

  it("rejects a stalled avatar without waiting for the full clip", async () => {
    avatar.duration = 20;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    video.currentTime = 1;
    now = 16_000;
    frames.shift()?.(16_000);
    await expect(bake).rejects.toThrow("The avatar stopped playing during the bake.");
    expect(avatar.pause).toHaveBeenCalled();
  });

  it("waits for the avatar ended event when the audio timeline expires", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    video.currentTime = 1;
    avatar.currentTime = 0.5;
    now = 2_100;
    frames.shift()?.(2_100);

    expect(recorders[0].state).toBe("recording");
    expect(frames).toHaveLength(1);
    avatar.onended?.();
    await expect(bake).resolves.toBeInstanceOf(Blob);
  });

  it("waits for a shorter avatar to end after the footage finishes", async () => {
    avatar.duration = 0.5;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    video.currentTime = 1;
    avatar.currentTime = 0.5;
    now = 1_100;
    frames.shift()?.(1_100);

    expect(recorders[0].state).toBe("recording");
    avatar.onended?.();
    await expect(bake).resolves.toBeInstanceOf(Blob);
  });

  it("rejects avatar composites beyond the ten-minute cap before recording", async () => {
    avatar.duration = 601;
    await expect(
      bakeVideoAnimation({
        videoUrl: "blob:test",
        attachments: [],
        values: {},
        avatarUrl: "blob:avatar",
      }),
    ).rejects.toThrow("Avatar composite videos are limited to 10 minutes.");
    expect(recorders).toHaveLength(0);
  });

  it("mixes narration over lowered original audio without requiring animations", async () => {
    const bake = bakeVideoAnimation({
      videoUrl: "blob:test",
      attachments: [],
      values: {},
      narration: new Blob(["speech"], { type: "audio/mpeg" }),
      originalAudioVolume: 0.25,
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    expect(gains[0].gain.value).toBe(0.25);
    expect(narrationSources).toHaveLength(1);
    expect(narrationSources[0].start).toHaveBeenCalledTimes(1);
    recorders[0].onerror?.();
    await expect(bake).rejects.toThrow("Recording failed.");
  });

  it("rejects narration longer than the ten-minute render cap", async () => {
    audioDuration = 601;
    await expect(
      bakeVideoAnimation({
        videoUrl: "blob:test",
        attachments,
        values: {},
        narration: new Blob(["speech"], { type: "audio/mpeg" }),
      }),
    ).rejects.toThrow("Narrated videos are limited to 10 minutes.");
    expect(recorders).toHaveLength(0);
  });
});

describe("bakeVideoAnimation validation", () => {
  it("rejects attachments that resolve to nothing drawable", async () => {
    await expect(
      bakeVideoAnimation({ videoUrl: "blob:test", attachments: [], values: {} })
    ).rejects.toThrow("Unknown animation preset.");
  });

  it("rejects browsers without canvas/MediaRecorder support", async () => {
    await expect(
      bakeVideoAnimation({
        videoUrl: "blob:test",
        attachments: [{ presetId: "cinema-title", slot: "start", loop: false }],
        values: {},
      })
    ).rejects.toThrow("This browser cannot record the animation.");
  });
});
