// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SLIDESHOW_PRESET_ID,
  SLIDESHOW_PRESETS,
  drawSlideshowCard,
  drawSlideshowFrame,
  getSlideshowPreset,
} from "./slideshow-presets";

const BOX = { w: 1920, h: 1080 };

function makeContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  } as unknown as CanvasRenderingContext2D;
}

function makeImage(naturalWidth = 800, naturalHeight = 600) {
  return { naturalWidth, naturalHeight } as HTMLImageElement;
}

describe("slideshow preset registry", () => {
  it("offers straight cuts as the default and a carousel", () => {
    expect(SLIDESHOW_PRESETS.map((preset) => preset.id)).toEqual([
      "straight",
      "carousel",
    ]);
    expect(DEFAULT_SLIDESHOW_PRESET_ID).toBe("straight");
    expect(getSlideshowPreset("straight")?.name).toBe("Straight cuts");
    expect(getSlideshowPreset("carousel")?.draw).toBeTypeOf("function");
  });

  it("returns null for unknown preset ids", () => {
    expect(getSlideshowPreset("ken-burns")).toBeNull();
  });
});

describe("drawSlideshowFrame — straight cuts", () => {
  it("draws one full-frame photo per frame, switching at the window edge", () => {
    const context = makeContext();
    const first = makeImage();
    const second = makeImage();

    drawSlideshowFrame(context, [first, second], 0.5, 2, BOX);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(context.drawImage).toHaveBeenCalledWith(first, 0, -180, 1920, 1440);

    drawSlideshowFrame(context, [first, second], 1.5, 2, BOX);
    expect(context.drawImage).toHaveBeenLastCalledWith(second, 0, -180, 1920, 1440);
  });

  it("falls back to straight cuts for unknown preset ids", () => {
    const context = makeContext();
    const first = makeImage();
    drawSlideshowFrame(context, [first], 0.2, 2, BOX, "does-not-exist");
    expect(context.drawImage).toHaveBeenCalledWith(first, 0, -180, 1920, 1440);
    expect(context.translate).not.toHaveBeenCalled();
  });
});

describe("drawSlideshowFrame — carousel (coverflow)", () => {
  it("rests with the focused photo centered and the next photo to the right", () => {
    const context = makeContext();
    const photos = [makeImage(), makeImage(), makeImage()];
    // Window = 1s; t=0.1 is mid-dwell of photo 0.
    drawSlideshowFrame(context, photos, 0.1, 3, BOX, "carousel");

    // Backdrop plus two cards; the third photo paints no visible pixels.
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    // Farthest card first: photo 1 sits in the right slot (d = -1 → offset
    // +0.55·1920 = 1056px from center), photo 0 is focused at the center.
    expect(context.translate).toHaveBeenNthCalledWith(
      1,
      expect.closeTo(2016, 6),
      540,
    );
    expect(context.translate).toHaveBeenNthCalledWith(
      2,
      expect.closeTo(960, 6),
      540,
    );
    // Only the side card is tilted, squeezed, and darkened.
    expect(context.rotate).toHaveBeenCalledTimes(1);
    expect(context.rotate).toHaveBeenCalledWith(-4 * (Math.PI / 180));
    expect(context.scale).toHaveBeenNthCalledWith(1, 0.85, 1);
    expect(context.scale).toHaveBeenNthCalledWith(2, 1, 1);
    // First fillRect is the backdrop, second is the side card's darkening
    // over its shrunk 0.72-scale rect.
    expect(context.fillRect).toHaveBeenNthCalledWith(
      1,
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(1920, 6),
      expect.closeTo(1080, 6),
    );
    expect(context.fillRect).toHaveBeenNthCalledWith(
      2,
      expect.closeTo(-345.6, 6),
      expect.closeTo(-295.488, 6),
      expect.closeTo(691.2, 6),
      expect.closeTo(590.976, 6),
    );
  });

  it("advances the eased move midway through a transition", () => {
    const context = makeContext();
    const photos = [makeImage(), makeImage(), makeImage()];
    // t=0.9 of a 1s window: 75% through the 0.4s move → eased to 0.9375. The
    // outgoing photo has slid left of center, the next is nearly focused, and
    // the third card is just entering the frame from the right.
    drawSlideshowFrame(context, photos, 0.9, 3, BOX, "carousel");

    expect(context.drawImage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(context.translate).mock.calls).toEqual([
      [expect.closeTo(2082, 6), 540], // photo 2: d = -1.0625 → far right
      [expect.closeTo(-30, 6), 540], // photo 0: d = 0.9375 → sliding out
      [expect.closeTo(1026, 6), 540], // photo 1: d = -0.0625 → near focus
    ]);
  });

  it("keeps a lone photo front and center with a slow push-in", () => {
    const context = makeContext();
    const photo = makeImage();
    drawSlideshowFrame(context, [photo], 1.5, 3, BOX, "carousel");
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    // Halfway through: zoom 1.02 on the full-frame card (cover-fit 2.4 × 1.02).
    expect(context.drawImage).toHaveBeenCalledWith(
      photo,
      expect.closeTo(-979.2, 6),
      expect.closeTo(-734.4, 6),
      expect.closeTo(1958.4, 6),
      expect.closeTo(1468.8, 6),
    );
  });
});

describe("drawSlideshowCard", () => {
  it("cover-fits the photo into the card and darkens when asked", () => {
    const context = makeContext();
    drawSlideshowCard(context, makeImage(), {
      x: 480,
      y: 129.6,
      w: 960,
      h: 820.8,
      darken: 0.35,
    });
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.closeTo(-547.2, 6),
      expect.closeTo(-410.4, 6),
      expect.closeTo(1094.4, 6),
      expect.closeTo(820.8, 6),
    );
    expect(context.fillRect).toHaveBeenCalledWith(
      expect.closeTo(-480, 6),
      expect.closeTo(-410.4, 6),
      expect.closeTo(960, 6),
      expect.closeTo(820.8, 6),
    );
  });
});
