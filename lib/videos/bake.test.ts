import { describe, expect, it } from "vitest";
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
