import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { bakeReelAnimation, composeFrame } from "./bake";
import {
  breaking,
  endcard,
  headline,
  planEffects,
  type ReelAttachment,
} from "@/lib/reels/presets";

/**
 * bakeReelAnimation drives the browser's video + canvas + MediaRecorder
 * pipeline, so the node-env tests stub those globals and assert the contract
 * that protects real posts: native-resolution recording, no silent muting,
 * and clean failure before any recorder starts.
 */

type FakeCtx = {
  scale: Mock;
  translate: Mock;
  clearRect: Mock;
  drawImage: Mock;
  save: Mock;
  restore: Mock;
  fillRect: Mock;
  beginPath: Mock;
  roundRect: Mock;
  rect: Mock;
  arc: Mock;
  clip: Mock;
  fill: Mock;
  stroke: Mock;
  fillText: Mock;
  measureText: Mock;
  textBaseline: string;
  textAlign: string;
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  shadowColor: string;
  shadowBlur: number;
  globalAlpha: number;
};

function makeCtx(): FakeCtx {
  return {
    scale: vi.fn(),
    translate: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 42 })),
    textBaseline: "alphabetic",
    textAlign: "start",
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    shadowColor: "",
    shadowBlur: 0,
    globalAlpha: 1,
  };
}

type FakeVideo = {
  src: string;
  playsInline: boolean;
  preload: string;
  muted: boolean;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  play: Mock;
  pause: Mock;
  onended: ((event: Event) => void) | null;
  onerror: (() => void) | null;
};

let video: FakeVideo;
let canvas: {
  width: number;
  height: number;
  getContext: Mock;
  captureStream: Mock;
};
let ctx: FakeCtx;
let closes: number[];
let recorder: {
  state: string;
  start: Mock;
  stop: Mock;
  ondataavailable: ((event: { data: BlobPart }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
};
let captureStreamMock: Mock;

/**
 * Loaded-metadata resolves lazily the way a sniffed local blob does; `play`
 * may end the bake itself by firing `onended` once the loop has attached it.
 * `mimeSupport` narrows MediaRecorder.isTypeSupported: 'all' (default) lets
 * the MP4-first candidates win, 'webm-only' exercises the fallback container.
 */
function installBrowserStubs(
  play: (video: FakeVideo) => Promise<void>,
  mimeSupport: "all" | "webm-only" | "mp4-only" = "all"
) {
  video = {
    src: "",
    playsInline: false,
    preload: "",
    muted: false,
    currentTime: 0,
    duration: 5,
    videoWidth: 720,
    videoHeight: 1280,
    play: vi.fn(() => play(video)),
    pause: vi.fn(),
    onended: null,
    onerror: null,
  };
  let queued = 0;
  Object.defineProperty(video, "onloadedmetadata", {
    set(cb: (() => void) | null) {
      if (queued++ === 0) queueMicrotask(() => cb?.());
    },
  });

  ctx = makeCtx();
  captureStreamMock = vi.fn(() => ({ getTracks: () => [], addTrack: vi.fn() }));
  canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    captureStream: captureStreamMock,
  };

  let createdVideo = false;
  let createdCanvas = false;
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (!createdVideo && tag === "video") {
        createdVideo = true;
        return video;
      }
      if (!createdCanvas && tag === "canvas") {
        createdCanvas = true;
        return canvas;
      }
      return {};
    },
  });

  recorder = {
    state: "inactive",
    start: vi.fn(() => {
      recorder.state = "recording";
    }),
    stop: vi.fn(() => {
      recorder.state = "inactive";
      queueMicrotask(() => {
        recorder.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        recorder.onstop?.();
      });
    }),
    ondataavailable: null,
    onstop: null,
    onerror: null,
  };
  class MediaRecorderStub {
    static isTypeSupported(mime: string) {
      if (mimeSupport === "webm-only") return mime.includes("webm");
      if (mimeSupport === "mp4-only") return mime.includes("mp4");
      return true;
    }
    constructor() {
      return recorder as unknown as MediaRecorderStub;
    }
  }
  vi.stubGlobal("MediaRecorder", MediaRecorderStub);
  vi.stubGlobal("HTMLCanvasElement", class {});
  vi.stubGlobal(
    "AudioContext",
    class AudioContextStub {
      state = "running";
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {
        closes.push(1);
      });
      destination = {};
      createMediaElementSource() {
        return { connect: vi.fn() };
      }
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [] }, connect: vi.fn() };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn() };
      }
    }
  );

  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

beforeEach(() => {
  closes = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bakeReelAnimation", () => {
  it("rejects unknown presets before touching the DOM", async () => {
    installBrowserStubs(() => Promise.resolve());
    await expect(
      bakeReelAnimation({
        videoUrl: "blob:x",
        attachments: [{ presetId: "nonexistent", slot: "start", loop: false }],
        values: {},
      })
    ).rejects.toThrow("Unknown animation preset.");
  });

  it("rejects a slot the preset does not suit", async () => {
    installBrowserStubs(() => Promise.resolve());
    await expect(
      bakeReelAnimation({
        videoUrl: "blob:x",
        attachments: [{ presetId: "endcard", slot: "start", loop: false }],
        values: {},
      })
    ).rejects.toThrow("Unknown animation preset.");
  });

  it("refuses browsers without MediaRecorder support", async () => {
    installBrowserStubs(() => Promise.resolve());
    vi.unstubAllGlobals();
    await expect(
      bakeReelAnimation({
        videoUrl: "blob:x",
        attachments: [{ presetId: "headline", slot: "start", loop: false }],
        values: {},
      })
    ).rejects.toThrow("This browser cannot record the animation.");
  });

  it("fails loudly when playback is blocked — never bakes a muted, silent reel", async () => {
    installBrowserStubs(async () => {
      throw new DOMException("NotAllowedError", "NotAllowedError");
    });

    await expect(
      bakeReelAnimation({
        videoUrl: "blob:x",
        attachments: [{ presetId: "headline", slot: "start", loop: false }],
        values: {},
      })
    ).rejects.toThrow(/Playback was blocked/);

    expect(recorder.start).not.toHaveBeenCalled();
    expect(closes.length).toBe(1);
    expect(video.muted).toBe(false);
    expect(captureStreamMock).toHaveBeenCalledWith(30);
  });

  it("records the composited reel at the reel's native 1080×1920, as MP4", async () => {
    installBrowserStubs((element) => {
      setTimeout(() => element.onended?.(new Event("ended")), 0);
      return Promise.resolve();
    });

    const blob = await bakeReelAnimation({
      videoUrl: "blob:x",
      attachments: [{ presetId: "headline", slot: "start", loop: false }],
      values: { headline: { text: "Big news today" } },
    });

    // MP4/H.264 recording wins when the browser supports it: the bake then
    // publishes without a transcode step (which Vercel cannot perform).
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBeGreaterThan(0);
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1920);
    expect(ctx.scale).toHaveBeenCalledWith(1, 1);
    expect(captureStreamMock).toHaveBeenCalledWith(30);
    expect(recorder.start).toHaveBeenCalledWith(250);
    expect(video.src).toBe("");
  });

  it("falls back to WebM when the browser cannot record MP4", async () => {
    installBrowserStubs(
      (element) => {
        setTimeout(() => element.onended?.(new Event("ended")), 0);
        return Promise.resolve();
      },
      "webm-only"
    );

    const blob = await bakeReelAnimation({
      videoUrl: "blob:x",
      attachments: [{ presetId: "headline", slot: "start", loop: false }],
      values: {},
    });

    expect(blob.type).toBe("video/webm");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("never seeks while recording — a seek per frame chopped the captured audio", async () => {
    installBrowserStubs(() => Promise.resolve());

    // Drive a few render ticks with a playhead that advances naturally, and
    // record every assignment to the media element's playhead.
    let ticks = 0;
    let playhead = 0;
    const writes: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => playhead,
      set: (value: number) => {
        writes.push(value);
        playhead = value;
      },
    });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      if (ticks++ < 6) {
        playhead += 1;
        cb();
      }
      return ticks;
    });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));

    const blob = await bakeReelAnimation({
      videoUrl: "blob:x",
      attachments: [{ presetId: "headline", slot: "start", loop: false }],
      values: {},
    });

    expect(blob.size).toBeGreaterThan(0);
    // Only the initial rewind before playback may touch currentTime.
    expect(writes).toEqual([0]);
  });

  it("preserves frame timing across sub-33ms callbacks", async () => {
    installBrowserStubs((element) => {
      setTimeout(() => element.onended?.(new Event("ended")), 0);
      return Promise.resolve();
    });

    let playhead = 0;
    let ticks = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => playhead,
      set: () => {},
    });
    // Each callback arrives just over one frame interval apart, so no remainder is lost.
    const intervals = [34, 34, 34];
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (ticks < intervals.length) {
        clock += intervals[ticks];
        playhead += intervals[ticks] / 1000;
        ticks++;
        cb(clock);
      }
      return ticks;
    });

    const blob = await bakeReelAnimation({
      videoUrl: "blob:x",
      attachments: [{ presetId: "headline", slot: "start", loop: false }],
      values: {},
    });

    expect(blob.size).toBeGreaterThan(0);
    expect(ctx.clearRect).toHaveBeenCalledTimes(3);
  });

  it("bakes every attached slot effect into one recording", async () => {
    installBrowserStubs((element) => {
      setTimeout(() => element.onended?.(new Event("ended")), 0);
      return Promise.resolve();
    });

    const blob = await bakeReelAnimation({
      videoUrl: "blob:x",
      attachments: [
        { presetId: "headline", slot: "start", loop: false },
        { presetId: "endcard", slot: "end", loop: false },
      ],
      values: {},
    });

    // One composited recording at native resolution covering both effects.
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBeGreaterThan(0);
    expect(canvas.width).toBe(1080);
    expect(recorder.start).toHaveBeenCalledWith(250);
    expect(recorder.stop).toHaveBeenCalled();
    expect(video.src).toBe("");
  });
});

describe("composeFrame", () => {
  const ctx = makeCtx() as unknown as CanvasRenderingContext2D;

  function effects(attachments: ReelAttachment[], duration = 30) {
    return planEffects(attachments, duration, {});
  }

  it("draws the footage once, with the active camera zoom applied", () => {
    const drawFootage = vi.fn();
    composeFrame(
      ctx,
      effects([{ presetId: "punchzoom", slot: "start", loop: false }]),
      2.3, // punchzoom's start slot begins at 2s; local 0.3s is peak zoom.
      drawFootage
    );
    expect(drawFootage).toHaveBeenCalledWith(1.16);
  });

  it("multiplies the zoom of every simultaneously active camera effect", () => {
    const drawFootage = vi.fn();
    composeFrame(
      ctx,
      effects([
        { presetId: "punchzoom", slot: "start", loop: false },
        { presetId: "punchzoom", slot: "start", loop: true },
      ]),
      2.3,
      drawFootage
    );
    expect(drawFootage).toHaveBeenCalledWith(1.16 * 1.16);
  });

  it("draws each active overlay in attachment order with its own local time", () => {
    const headlineSpy = vi.spyOn(headline, "draw");
    const endcardSpy = vi.spyOn(endcard, "draw");
    const drawFootage = vi.fn();
    composeFrame(
      ctx,
      effects([
        { presetId: "endcard", slot: "end", loop: false },
        { presetId: "headline", slot: "start", loop: false },
      ]),
      1 // headline active (local 1s); endcard waits for the reel's end.
        ,
      drawFootage
    );
    expect(drawFootage).toHaveBeenCalledWith(1);
    expect(headlineSpy).toHaveBeenCalledWith(ctx, 1, headline.duration, {});
    expect(endcardSpy).not.toHaveBeenCalled();
    headlineSpy.mockRestore();
    endcardSpy.mockRestore();
  });

  it("replays a looped effect every duration, one pass at a time", () => {
    const headlineSpy = vi.spyOn(headline, "draw");
    const drawFootage = vi.fn();
    const looping = effects([{ presetId: "headline", slot: "start", loop: true }]);
    composeFrame(ctx, looping, 1, drawFootage);
    expect(headlineSpy).toHaveBeenCalledTimes(1);
    // headline.duration 3.4: the next pass starts at 3.4 with local 0 while
    // the previous one has finished — passes never draw over each other.
    composeFrame(ctx, looping, 3.4, drawFootage);
    expect(headlineSpy).toHaveBeenCalledTimes(2);
    expect(headlineSpy).toHaveBeenLastCalledWith(ctx, 0, headline.duration, {});
    headlineSpy.mockRestore();
  });

  it("streams a looped banner instead of restarting it", () => {
    const streamSpy = vi.spyOn(breaking, "stream");
    const drawSpy = vi.spyOn(breaking, "draw");
    const drawFootage = vi.fn();
    const looping = effects([{ presetId: "breaking", slot: "start", loop: true }]);
    composeFrame(ctx, looping, breaking.duration + 2.5, drawFootage);
    expect(streamSpy).toHaveBeenCalledWith(
      ctx,
      breaking.duration + 2.5,
      breaking.duration,
      {}
    );
    expect(drawSpy).not.toHaveBeenCalled();
    streamSpy.mockRestore();
    drawSpy.mockRestore();
  });

  it("stops a looped animation once the end card opens", () => {
    const headlineSpy = vi.spyOn(headline, "draw");
    const endcardSpy = vi.spyOn(endcard, "draw");
    const drawFootage = vi.fn();
    const planned = effects([
      { presetId: "headline", slot: "start", loop: true },
      { presetId: "endcard", slot: "end", loop: false },
    ]);
    const endcardStart = 30 - endcard.duration - 0.2;
    composeFrame(ctx, planned, endcardStart + 1, drawFootage);
    expect(headlineSpy).not.toHaveBeenCalled();
    expect(endcardSpy).toHaveBeenCalledTimes(1);
    headlineSpy.mockRestore();
    endcardSpy.mockRestore();
  });

  it("keeps the footage zoom at 1 when no camera effect is active", () => {
    const drawFootage = vi.fn();
    composeFrame(
      ctx,
      effects([{ presetId: "headline", slot: "start", loop: false }]),
      20,
      drawFootage
    );
    expect(drawFootage).toHaveBeenCalledWith(1);
  });
});
