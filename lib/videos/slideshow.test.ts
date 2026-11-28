// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bakeNarratedSlideshow,
  drawSlideshowImage,
} from "./slideshow";

describe("drawSlideshowImage", () => {
  it("cover-crops the photo into the 16:9 canvas", () => {
    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    const image = {
      naturalWidth: 800,
      naturalHeight: 600,
    } as HTMLImageElement;
    drawSlideshowImage(context, image);
    expect(drawImage).toHaveBeenCalledWith(
      image,
      0,
      -180,
      1920,
      1440,
    );
  });
});

describe("bakeNarratedSlideshow", () => {
  let frames: FrameRequestCallback[];
  let recorders: FakeRecorder[];
  let drawImage: ReturnType<typeof vi.fn>;
  let fill: ReturnType<typeof vi.fn>;
  let roundRect: ReturnType<typeof vi.fn>;
  let translate: ReturnType<typeof vi.fn>;
  let narrationStart: ReturnType<typeof vi.fn>;
  let avatar: ReturnType<typeof makeAvatarVideo>;
  let capturedCanvases: HTMLCanvasElement[];
  let audioDuration = 2;
  let avatarDuration = 2;
  let now = 0;
  let originalCaptureStream: unknown;

  class FakeImage {
    naturalWidth = 800;
    naturalHeight = 600;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

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

  function makeAvatarVideo() {
    let src = "";
    let loaded = false;
    const element = {
      src: "",
      currentTime: 0,
      duration: avatarDuration,
      videoWidth: 1920,
      videoHeight: 1080,
      readyState: 2,
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
        if (value && !loaded) {
          loaded = true;
          queueMicrotask(() => element.onloadeddata?.());
        }
      },
    });
    return element;
  }

  class FakeAudioContext {
    state = "running";
    destination = {};
    createMediaElementSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
      return {
        gain: { value: 0 },
        connect: () => {},
        disconnect: () => {},
      };
    }
    decodeAudioData() {
      return Promise.resolve({
        duration: audioDuration,
        getChannelData: () =>
          Float32Array.from([0.1, 0.8, 0.3, 0.9, 0.2, 0.7, 0.4, 1]),
      });
    }
    createBufferSource() {
      narrationStart = vi.fn();
      return {
        buffer: null,
        connect: vi.fn(),
        start: narrationStart,
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ stop: () => {} }] } };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    frames = [];
    recorders = [];
    now = 0;
    audioDuration = 2;
    drawImage = vi.fn();
    fill = vi.fn();
    roundRect = vi.fn();
    translate = vi.fn();
    narrationStart = vi.fn();
    avatarDuration = 2;
    avatar = makeAvatarVideo();
    capturedCanvases = [];
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation(((
      tag: string,
      options?: ElementCreationOptions
    ) => {
      if (tag === "video") return avatar as unknown as HTMLElement;
      return originalCreateElement.call(document, tag, options);
    }) as typeof document.createElement);
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    fill = vi.fn();
    roundRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      fill,
      roundRect,
      fillRect: vi.fn(),
      translate,
      rotate: vi.fn(),
      scale: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D);
    originalCaptureStream = (
      HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }
    ).captureStream;
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        capturedCanvases.push(this);
        return {
          getTracks: () => [{ stop: () => {} }],
          addTrack: vi.fn(),
        };
      }),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true,
      value: originalCaptureStream,
    });
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  it("gives each photo equal narration time and records the audio", async () => {
    const onProgress = vi.fn();
    const bake = bakeNarratedSlideshow({
      images: ["photo-1", "photo-2"],
      narration: new Blob(["speech"], { type: "audio/mpeg" }),
      onProgress,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(narrationStart).toHaveBeenCalledTimes(1);
    expect(capturedCanvases[0].width).toBe(1920);
    expect(capturedCanvases[0].height).toBe(1080);

    now = 40;
    frames.shift()?.(40);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    now = 1_100;
    frames.shift()?.(1_100);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    now = 2_100;
    frames.shift()?.(2_100);

    const blob = await bake;
    expect(blob.size).toBeGreaterThan(0);
    expect(drawImage).toHaveBeenCalledTimes(4);
    const drawnPhotos = drawImage.mock.calls.map((call) => call[0]);
    expect(drawnPhotos[0]).toBe(drawnPhotos[1]);
    expect(drawnPhotos[2]).toBe(drawnPhotos[3]);
    expect(drawnPhotos[0]).not.toBe(drawnPhotos[2]);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it("draws the avatar over each photo and records its audio", async () => {
    const onProgress = vi.fn();
    const bake = bakeNarratedSlideshow({
      images: ["photo-1", "photo-2"],
      avatarUrl: "blob:avatar",
      avatarPlacement: { x: 0.1, y: 0.2, width: 0.5 },
      onProgress,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(avatar.play).toHaveBeenCalledTimes(1);
    expect(narrationStart).not.toHaveBeenCalled();

    avatar.currentTime = 0.5;
    now = 40;
    frames.shift()?.(40);
    expect(drawImage).toHaveBeenCalledTimes(4);
    expect(drawImage.mock.calls[3]).toEqual([avatar, 192, 216, 960, 540]);

    avatar.currentTime = 2;
    now = 2_100;
    frames.shift()?.(2_100);
    avatar.onended?.();
    await expect(bake).resolves.toBeInstanceOf(Blob);
    expect(onProgress).toHaveBeenLastCalledWith(1);
    expect(avatar.pause).toHaveBeenCalled();
    expect(avatar.src).toBe("");
  });

  it("draws the narration waveform when showWaveform is set", async () => {
    const bake = bakeNarratedSlideshow({
      images: ["photo-1", "photo-2"],
      narration: new Blob(["speech"], { type: "audio/mpeg" }),
      showWaveform: true,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(narrationStart).toHaveBeenCalledTimes(1);
    // the pre-recording frame already painted the pill and the bars
    expect(fill).toHaveBeenCalled();
    expect(roundRect).toHaveBeenCalled();
    const fillsAfterFirstFrame = fill.mock.calls.length;

    now = 40;
    frames.shift()?.(40);
    expect(fill.mock.calls.length).toBeGreaterThan(fillsAfterFirstFrame);

    now = 1_100;
    frames.shift()?.(1_100);

    now = 2_100;
    frames.shift()?.(2_100);
    await expect(bake).resolves.toBeInstanceOf(Blob);
  });

  it("does not draw the waveform unless showWaveform is set", async () => {
    const bake = bakeNarratedSlideshow({
      images: ["photo-1", "photo-2"],
      narration: new Blob(["speech"], { type: "audio/mpeg" }),
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    now = 40;
    frames.shift()?.(40);
    now = 1_100;
    frames.shift()?.(1_100);
    now = 2_100;
    frames.shift()?.(2_100);

    expect(fill).not.toHaveBeenCalled();
    expect(roundRect).not.toHaveBeenCalled();
    await expect(bake).resolves.toBeInstanceOf(Blob);
  });

  it("animates photos with the carousel preset when one is set", async () => {
    const bake = bakeNarratedSlideshow({
      images: ["photo-1", "photo-2"],
      narration: new Blob(["speech"], { type: "audio/mpeg" }),
      presetId: "carousel",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    now = 40;
    frames.shift()?.(40);
    now = 1_100;
    frames.shift()?.(1_100);
    now = 2_100;
    frames.shift()?.(2_100);
    await expect(bake).resolves.toBeInstanceOf(Blob);
    // Coverflow paints a backdrop and transformed cards instead of the bare
    // full-frame photos of straight cuts (2 cards per frame here).
    expect(translate).toHaveBeenCalled();
    expect(drawImage.mock.calls.length).toBeGreaterThan(4);
  });

  it("waits for the avatar ended event after the slideshow timeline expires", async () => {
    const bake = bakeNarratedSlideshow({
      images: ["photo"],
      avatarUrl: "blob:avatar",
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    avatar.currentTime = 0.5;
    now = 2_100;
    frames.shift()?.(2_100);

    expect(recorders[0].state).toBe("recording");
    expect(frames).toHaveLength(1);
    avatar.onended?.();
    await expect(bake).resolves.toBeInstanceOf(Blob);
  });

  it("rejects a slideshow with both narration and an avatar", async () => {
    await expect(
      bakeNarratedSlideshow({
        images: ["photo"],
        narration: new Blob(["speech"], { type: "audio/mpeg" }),
        avatarUrl: "blob:avatar",
      }),
    ).rejects.toThrow("Choose either a voice-over or an avatar video for the slideshow.");
    expect(recorders).toHaveLength(0);
  });

  it("cleans up the avatar when playback is blocked", async () => {
    avatar.play.mockRejectedValueOnce(new Error("blocked"));
    await expect(
      bakeNarratedSlideshow({
        images: ["photo"],
        avatarUrl: "blob:avatar",
      }),
    ).rejects.toThrow("Playback was blocked, so the avatar slideshow bake was skipped.");
    expect(recorders[0].state).toBe("inactive");
    expect(avatar.pause).toHaveBeenCalled();
    expect(avatar.src).toBe("");
  });

  it("rejects avatar slideshows beyond the ten-minute cap before recording", async () => {
    avatar.duration = 601;
    await expect(
      bakeNarratedSlideshow({
        images: ["photo"],
        avatarUrl: "blob:avatar",
      }),
    ).rejects.toThrow("Avatar slideshows are limited to 10 minutes.");
    expect(recorders).toHaveLength(0);
  });

  it("rejects narration beyond the ten-minute cap before recording", async () => {
    audioDuration = 601;
    await expect(
      bakeNarratedSlideshow({
        images: ["photo"],
        narration: new Blob(["speech"], { type: "audio/mpeg" }),
      }),
    ).rejects.toThrow("Narrated slideshows are limited to 10 minutes.");
    expect(recorders).toHaveLength(0);
  });
});
