// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bakeVideoAnimation, composeVideoFrame, outputSize } from "./bake";
import { getVideoPreset, type PlannedVideoEffect } from "./presets";

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
    onended: (() => void) | null;
  };
  let frames: FrameRequestCallback[];
  let recorders: FakeRecorder[];
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
      this.onstop?.();
    }
  }

  class FakeAudioContext {
    state = "running";
    destination = {};
    createMediaElementSource() {
      return { connect: () => {} };
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ stop: () => {} }] } };
    }
    createGain() {
      return { gain: { value: 0 }, connect: () => {} };
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

  function makeVideo() {
    let src = "";
    let metadataFired = false;
    const element = {
      currentTime: 0,
      duration: 1,
      videoWidth: 1920,
      videoHeight: 1080,
      onloadedmetadata: null as (() => void) | null,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      play: () => Promise.resolve(),
      pause: vi.fn(),
    };
    Object.defineProperty(element, "src", {
      get: () => src,
      set: (value: string) => {
        src = value;
        if (value && !metadataFired) {
          metadataFired = true;
          setTimeout(() => element.onloadedmetadata?.(), 0);
        }
      },
    });
    return element;
  }

  beforeEach(() => {
    hidden = false;
    frames = [];
    recorders = [];
    video = makeVideo();

    originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ) =>
      tag === "video"
        ? (video as unknown as HTMLElement)
        : originalCreateElement.call(document, tag, options)) as typeof document.createElement);

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
