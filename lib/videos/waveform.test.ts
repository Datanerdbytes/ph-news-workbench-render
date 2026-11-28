import { describe, expect, it } from "vitest";
import {
  computeNarrationPeaks,
  drawNarrationWaveform,
  WAVEFORM_BAR_COUNT,
} from "./waveform";

function makeBuffer(samples: number[]): AudioBuffer {
  return {
    getChannelData: () => Float32Array.from(samples),
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / 8000,
    sampleRate: 8000,
  } as unknown as AudioBuffer;
}

function fakeCtx() {
  const store = new Map<PropertyKey, unknown>();
  const calls = {
    roundRect: [] as Array<[number, number, number, number, number]>,
    fill: [] as number[],
    alphas: [] as number[],
  };
  return {
    calls,
    context: new Proxy(store, {
      get(target, prop) {
        if (prop === "roundRect") {
          return (...args: number[]) => {
            calls.roundRect.push([
              args[0],
              args[1],
              args[2],
              args[3],
              args[4],
            ]);
          };
        }
        if (prop === "fill") {
          return () => {
            calls.fill.push(calls.alphas.at(-1) ?? 1);
          };
        }
        if (prop === "globalAlpha") {
          return target.get(prop);
        }
        if (!target.has(prop)) return () => undefined;
        return target.get(prop);
      },
      set(target, prop, value) {
        if (prop === "globalAlpha") calls.alphas.push(value);
        target.set(prop, value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D,
  };
}

describe("computeNarrationPeaks", () => {
  it("takes the max amplitude per bucket and normalizes to the loudest", () => {
    // 4 buckets of 4 samples; bucket maxima 0.1, 0.5, 1, 0.25
    const buffer = makeBuffer([0.1, -0.05, 0.08, 0, -0.5, 0.2, 0.1, 0, 1, -1, 0.5, 0, 0.25, 0.1, -0.2, 0]);
    const peaks = computeNarrationPeaks(buffer, 4);
    expect(peaks.map((peak) => Number(peak.toFixed(6)))).toEqual([
      0.1, 0.5, 1, 0.25,
    ]);
  });

  it("handles a channel shorter than the bar count", () => {
    const peaks = computeNarrationPeaks(makeBuffer([0.5, -1, 0.25]), 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[1]).toBe(1);
    expect(peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
  });

  it("returns silence for an empty channel", () => {
    expect(computeNarrationPeaks(makeBuffer([]), 6)).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it("defaults to the standard bar count", () => {
    const samples = Array.from({ length: 8000 * 3 }, (_, i) =>
      Math.sin(i / 40)
    );
    expect(computeNarrationPeaks(makeBuffer(samples))).toHaveLength(
      WAVEFORM_BAR_COUNT
    );
  });
});

describe("drawNarrationWaveform", () => {
  const box = { w: 1920, h: 1080 };
  const peaks = [0.2, 0.8, 0.5, 0.9];

  it("draws the pill once and one bar per peak", () => {
    const { calls, context } = fakeCtx();

    drawNarrationWaveform(context, {
      box,
      peaks,
      elapsed: 1.2,
      duration: 4,
    });

    expect(calls.fill).toHaveLength(peaks.length + 1); // pill + bars
    expect(calls.roundRect).toHaveLength(peaks.length + 1);
    // pill is the first shape, bottom-centered on a 1920x1080 canvas
    const [pillX, pillY, pillW, pillH] = calls.roundRect[0];
    expect(pillX).toBeGreaterThan(600);
    expect(pillX + pillW).toBeLessThan(1320);
    expect(pillY + pillH).toBeGreaterThan(980);
    expect(pillH).toBeLessThan(120);
  });

  it("is deterministic for the same elapsed time", () => {
    const first = fakeCtx();
    const second = fakeCtx();
    const options = { box, peaks, elapsed: 1.37, duration: 4 };

    drawNarrationWaveform(first.context, options);
    drawNarrationWaveform(second.context, options);

    expect(first.calls.roundRect).toEqual(second.calls.roundRect);
    expect(first.calls.alphas).toEqual(second.calls.alphas);
  });

  it("renders the played portion bright and the rest dimmed", () => {
    const { calls, context } = fakeCtx();

    drawNarrationWaveform(context, {
      box,
      peaks,
      elapsed: 2, // half of a 4s narration
      duration: 4,
    });

    // fill order: pill (alpha 1), then bars; the boundary bar counts as played
    const barAlphas = calls.fill.slice(1);
    expect(barAlphas[0]).toBeGreaterThan(0.9);
    expect(barAlphas[1]).toBeGreaterThan(0.9);
    expect(barAlphas[2]).toBeGreaterThan(0.9);
    expect(barAlphas[3]).toBeLessThan(0.5);
  });

  it("pops bars in during the first moments of the bake", () => {
    const early = fakeCtx();
    const settled = fakeCtx();

    drawNarrationWaveform(early.context, { box, peaks, elapsed: 0, duration: 4 });
    drawNarrationWaveform(settled.context, {
      box,
      peaks,
      elapsed: 2,
      duration: 4,
    });

    const earlyHeights = early.calls.roundRect
      .slice(1)
      .map(([, y, , h]) => y);
    const settledHeights = settled.calls.roundRect
      .slice(1)
      .map(([, y, , h]) => y);
    expect(earlyHeights.join()).not.toBe(settledHeights.join());
    // bars grow downward/upward from a shared center: settled tops sit higher
    expect(Math.min(...settledHeights)).toBeLessThanOrEqual(
      Math.min(...earlyHeights)
    );
  });

  it("treats a non-positive duration as fully played", () => {
    const { calls, context } = fakeCtx();

    drawNarrationWaveform(context, {
      box,
      peaks,
      elapsed: 0,
      duration: 0,
    });

    expect(calls.fill.slice(1).every((alpha) => alpha > 0.9)).toBe(true);
  });

  it("draws nothing without peaks", () => {
    const { calls, context } = fakeCtx();

    drawNarrationWaveform(context, { box, peaks: [], elapsed: 1, duration: 4 });

    expect(calls.fill).toHaveLength(0);
    expect(calls.roundRect).toHaveLength(0);
  });
});
