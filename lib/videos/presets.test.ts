import { describe, expect, it } from "vitest";
import {
  SLOT_ORDER,
  VIDEO_PRESETS,
  VIDEO_PRESET_CATEGORIES,
  attachmentsFromSlots,
  getVideoPreset,
  planVideoEffects,
  plannedVideoFrames,
  presetDefaultValues,
  videoEffectRenderer,
} from "./presets";

describe("VIDEO_PRESETS registry", () => {
  it("has unique ids, keeps 'none' first, and offers professional presets", () => {
    const ids = VIDEO_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("none");
    expect(ids).toEqual(
      expect.arrayContaining([
        "cinema-title",
        "lower-third",
        "kinetic-caption",
        "stat-ring",
        "news-ticker",
        "frame-wipe",
        "logo-sting",
        "end-plate",
        "camera-push",
      ])
    );
  });

  it("gives every real preset a usable timeline, slot and renderer", () => {
    for (const preset of VIDEO_PRESETS) {
      if (preset.id === "none") {
        expect(preset.slots).toEqual([]);
        expect(preset.draw).toBeUndefined();
        continue;
      }
      expect(preset.duration, preset.id).toBeGreaterThan(0);
      expect(preset.start, preset.id).toBeGreaterThanOrEqual(0);
      expect(preset.slots.length, preset.id).toBeGreaterThan(0);
      for (const slot of preset.slots) {
        expect(SLOT_ORDER, `${preset.id}: ${slot}`).toContain(slot);
      }
      expect(
        typeof preset.draw === "function" || typeof preset.scale === "function",
        preset.id
      ).toBe(true);
      expect(preset.window.trim(), preset.id).not.toBe("");
    }
  });

  it("keeps every preset inside a declared category", () => {
    const categories = VIDEO_PRESET_CATEGORIES.filter((c) => c !== "All");
    for (const preset of VIDEO_PRESETS) {
      expect(categories, preset.id).toContain(preset.category);
    }
  });

  it("gives every preset unique field keys with defaults", () => {
    for (const preset of VIDEO_PRESETS) {
      const keys = preset.fields.map((field) => field.key);
      expect(new Set(keys).size, preset.id).toBe(keys.length);
      for (const field of preset.fields) {
        expect(field.label.trim(), `${preset.id}.${field.key}`).not.toBe("");
      }
    }
  });

  it("attaches the end plate only to the closing slot", () => {
    expect(getVideoPreset("end-plate")!.slots).toEqual(["end"]);
    expect(getVideoPreset("frame-wipe")!.slots).toContain("end");
    expect(getVideoPreset("cinema-title")!.slots).not.toContain("end");
  });

  it("lets the slow push run in every slot — it is camera motion", () => {
    expect(getVideoPreset("camera-push")!.slots).toEqual(SLOT_ORDER);
  });
});

describe("getVideoPreset", () => {
  it("resolves known ids and rejects the rest", () => {
    expect(getVideoPreset("lower-third")?.name).toBe("Editorial Lower Third");
    expect(getVideoPreset("none")).not.toBeNull();
    expect(getVideoPreset("ghost")).toBeNull();
    expect(getVideoPreset(null)).toBeNull();
    expect(getVideoPreset("")).toBeNull();
  });
});

describe("presetDefaultValues", () => {
  it("seeds a preset's fields and tolerates unknown ids", () => {
    expect(presetDefaultValues("cinema-title")).toEqual({
      kicker: "PH NEWS",
      title: "The story behind the headline",
    });
    expect(presetDefaultValues("none")).toEqual({});
    expect(presetDefaultValues("ghost")).toEqual({});
  });
});

describe("planVideoEffects", () => {
  it("resolves slot attachments into timed effects with edited values", () => {
    const effects = planVideoEffects(
      [
        { presetId: "cinema-title", slot: "start", loop: false },
        { presetId: "end-plate", slot: "end", loop: false },
      ],
      30,
      { start: { kicker: "PH NEWS", title: "Flood aid arrives" } }
    );
    expect(effects.map((effect) => effect.preset.id)).toEqual([
      "cinema-title",
      "end-plate",
    ]);
    expect(effects[0].start).toBe(0);
    expect(effects[0].values).toEqual({
      kicker: "PH NEWS",
      title: "Flood aid arrives",
    });
    expect(effects[1].start).toBeCloseTo(30 - 4 - 0.2, 6);
  });

  it("gives the same preset independent values per slot", () => {
    const effects = planVideoEffects(
      [
        { presetId: "cinema-title", slot: "start", loop: false },
        { presetId: "cinema-title", slot: "middle", loop: false },
      ],
      30,
      {
        start: { title: "Opening line" },
        middle: { title: "Midpoint line" },
      }
    );
    expect(effects.map((effect) => effect.values.title)).toEqual([
      "Opening line",
      "Midpoint line",
    ]);
  });

  it("rejects unknown, 'none' and slot-incompatible picks", () => {
    const effects = planVideoEffects(
      [
        { presetId: "ghost", slot: "start", loop: false },
        { presetId: "none", slot: "start", loop: false },
        { presetId: "end-plate", slot: "start", loop: false },
        { presetId: "lower-third", slot: "start", loop: false },
      ],
      30
    );
    expect(effects.map((effect) => effect.preset.id)).toEqual(["lower-third"]);
  });

  it("centers a middle attachment and never loops a closing one", () => {
    const [effect] = planVideoEffects(
      [{ presetId: "stat-ring", slot: "middle", loop: true }],
      30
    );
    expect(effect.start).toBeCloseTo(15 - 2, 6);
    expect(effect.loop).toBe(true);

    const [closing] = planVideoEffects(
      [{ presetId: "end-plate", slot: "end", loop: true }],
      30
    );
    expect(closing.loop).toBe(false);
  });
});

describe("plannedVideoFrames", () => {
  it("stops a looped opener once the end plate opens", () => {
    const effects = planVideoEffects(
      [
        { presetId: "kinetic-caption", slot: "start", loop: true },
        { presetId: "end-plate", slot: "end", loop: false },
      ],
      30
    );
    const closing = effects[1].start;
    expect(
      plannedVideoFrames(effects, closing - 1).map(({ effect }) => effect.preset.id)
    ).toEqual(["kinetic-caption"]);
    expect(
      plannedVideoFrames(effects, closing + 0.5).map(
        ({ effect }) => effect.preset.id
      )
    ).toEqual(["end-plate"]);
  });

  it("streams a rolling ticker past its own duration", () => {
    const effects = planVideoEffects(
      [{ presetId: "news-ticker", slot: "start", loop: true }],
      60
    );
    expect(plannedVideoFrames(effects, 14).map(({ local }) => local)).toEqual([14]);
  });
});

describe("attachmentsFromSlots", () => {
  it("reads the picker's slots into ordered bake attachments", () => {
    expect(
      attachmentsFromSlots(
        { start: "cinema-title", middle: "stat-ring", end: null },
        { start: false, middle: true, end: false }
      )
    ).toEqual([
      { presetId: "cinema-title", slot: "start", loop: false },
      { presetId: "stat-ring", slot: "middle", loop: true },
    ]);
  });
});

describe("videoEffectRenderer", () => {
  it("streams a looped ticker and draws every other effect", () => {
    const effects = planVideoEffects(
      [
        { presetId: "news-ticker", slot: "start", loop: true },
        { presetId: "cinema-title", slot: "middle", loop: true },
      ],
      30
    );
    const ticker = getVideoPreset("news-ticker")!;
    const title = getVideoPreset("cinema-title")!;
    expect(videoEffectRenderer(effects[0])).toBe(ticker.stream);
    expect(videoEffectRenderer(effects[1])).toBe(title.draw);
  });
});

describe("camera-push scale curve", () => {
  it("eases back to 1 before the effect ends or a loop repeats", () => {
    const push = getVideoPreset("camera-push")!;
    expect(push.scale!(0)).toBeCloseTo(1, 6);
    expect(push.scale!(push.duration * 0.6)).toBeGreaterThan(1.02);
    expect(push.scale!(push.duration)).toBeCloseTo(1, 6);
    // The planner drops the effect just past `duration`; a loop restarts at 0.
    expect(push.scale!(push.duration + 0.001)).toBeCloseTo(1, 5);
  });
});
