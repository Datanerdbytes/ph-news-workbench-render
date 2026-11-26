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
  let narrationStart: ReturnType<typeof vi.fn>;
  let capturedCanvases: HTMLCanvasElement[];
  let audioDuration = 2;
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

  class FakeAudioContext {
    state = "running";
    destination = {};
    decodeAudioData() {
      return Promise.resolve({ duration: audioDuration });
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
    narrationStart = vi.fn();
    capturedCanvases = [];
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
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
