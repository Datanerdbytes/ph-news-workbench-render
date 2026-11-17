// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVideoPreset, presetDefaultValues } from "./presets";

const { toMock, killMock } = vi.hoisted(() => {
  const killMock = vi.fn();
  return { toMock: vi.fn(() => ({ kill: killMock })), killMock };
});
vi.mock("gsap", () => ({ gsap: { to: toMock } }));
// The registry has no draw-less preset today; mountVideoPreset still has to
// reject one, so expose a sentinel id that resolves to a scale-only preset.
vi.mock("./presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./presets")>();
  return {
    ...actual,
    getVideoPreset: (id: string | null | undefined) =>
      id === "ghost-drawless"
        ? { ...actual.getVideoPreset("cinema-title")!, id, draw: undefined }
        : actual.getVideoPreset(id),
  };
});

import { mountVideoPreset } from "./presets.preview";

const BOX = { w: 320, h: 180 };

function fakeContext() {
  const draws: string[] = [];
  const gradient = { addColorStop: vi.fn() };
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get(_, prop) {
      if (prop === "measureText") {
        return (text: string) => ({ width: String(text).length * 8 });
      }
      if (prop === "createRadialGradient" || prop === "createLinearGradient") {
        return () => gradient;
      }
      if (prop === "fillText") {
        return (text: string) => draws.push(String(text));
      }
      return () => {};
    },
    set() {
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

let context: ReturnType<typeof fakeContext>;

beforeEach(() => {
  context = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context.ctx
  );
  mockMatchMedia(false);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  toMock.mockClear();
  killMock.mockClear();
});

describe("mountVideoPreset", () => {
  it("returns null for unknown presets and the 'none' placeholder", () => {
    const stage = document.createElement("div");
    expect(mountVideoPreset(stage, "ghost", {}, BOX)).toBeNull();
    expect(mountVideoPreset(stage, "none", {}, BOX)).toBeNull();
    expect(stage.querySelector("canvas")).toBeNull();
    expect(toMock).not.toHaveBeenCalled();
  });

  it("returns null for presets that only move the camera and draw nothing", () => {
    const stage = document.createElement("div");
    expect(mountVideoPreset(stage, "ghost-drawless", {}, BOX)).toBeNull();
    expect(stage.querySelector("canvas")).toBeNull();
    expect(toMock).not.toHaveBeenCalled();
  });

  it("returns null and removes the canvas when 2D context is unavailable", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const stage = document.createElement("div");
    expect(mountVideoPreset(stage, "cinema-title", {}, BOX)).toBeNull();
    expect(stage.querySelector("canvas")).toBeNull();
    expect(toMock).not.toHaveBeenCalled();
  });

  it("draws one static frame at 55% of the duration under reduced motion", () => {
    mockMatchMedia(true);
    const stage = document.createElement("div");
    const handle = mountVideoPreset(
      stage,
      "cinema-title",
      presetDefaultValues("cinema-title"),
      BOX
    );
    expect(handle).not.toBeNull();
    expect(toMock).not.toHaveBeenCalled();
    // At t=0 the title tween has not started, so painted text proves the
    // mid-animation frame (2.31s) was sampled instead.
    expect(context.draws.length).toBeGreaterThan(0);
    expect(context.draws.some((text) => text.includes("THE STORY"))).toBe(true);

    handle!.kill();
    expect(stage.querySelector("canvas")).toBeNull();
  });

  it("drives the canvas with a looping GSAP tween outside reduced motion", () => {
    const stage = document.createElement("div");
    const values = presetDefaultValues("cinema-title");
    const handle = mountVideoPreset(stage, "cinema-title", values, BOX);
    expect(handle).not.toBeNull();

    expect(toMock).toHaveBeenCalledTimes(1);
    const [target, config] = toMock.mock.calls[0] as unknown as [
      { t: number },
      Record<string, unknown>,
    ];
    expect(target).toEqual({ t: 0 });
    const preset = getVideoPreset("cinema-title")!;
    expect(config.duration).toBe(preset.duration);
    expect(config.ease).toBe("none");
    expect(config.repeat).toBe(-1);
    expect(config.repeatDelay).toBe(0.55);

    handle!.kill();
    expect(killMock).toHaveBeenCalledTimes(1);
    expect(stage.querySelector("canvas")).toBeNull();
  });
});
