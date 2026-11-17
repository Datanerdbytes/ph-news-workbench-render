import { describe, expect, it } from "vitest";
import * as sharedPlan from "@/lib/animations/plan";
import {
  PRESET_CATEGORIES,
  REEL_PRESETS,
  SLOT_ORDER,
  attachmentsFromSlots,
  breaking,
  defaultPresetValues,
  effectLocals,
  getPreset,
  planEffects,
  plannedFrames,
  slotStart,
  punchzoom,
} from "./presets";

describe("REEL_PRESETS registry", () => {
  it("has unique ids and always includes 'none'", () => {
    const ids = REEL_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("none");
    expect(ids).toContain("headline");
  });

  it("gives every real preset a positive duration and usable fields", () => {
    for (const preset of REEL_PRESETS) {
      if (preset.id === "none") continue;
      expect(preset.duration, `${preset.id}.duration`).toBeGreaterThan(0);
      expect(preset.window.trim(), preset.id).not.toBe("");
      const keys = preset.fields.map((field) => field.key);
      expect(new Set(keys).size, preset.id).toBe(keys.length);
      for (const field of preset.fields) {
        expect(field.label.trim(), `${preset.id}.${field.key}`).not.toBe("");
      }
    }
  });

  it("keeps every preset inside a declared category", () => {
    const categories = PRESET_CATEGORIES.filter((category) => category !== "All");
    for (const preset of REEL_PRESETS) {
      expect(categories, preset.id).toContain(preset.category);
    }
  });

  it("declares at least one slot for every real preset, in valid slot names", () => {
    for (const preset of REEL_PRESETS) {
      if (preset.id === "none") {
        expect(preset.slots).toEqual([]);
        continue;
      }
      expect(preset.slots.length, preset.id).toBeGreaterThan(0);
      for (const slot of preset.slots) {
        expect(SLOT_ORDER, `${preset.id}: ${slot}`).toContain(slot);
      }
    }
  });

  it("places headline effects at the start and branding at the end", () => {
    expect(getPreset("headline")!.slots).toContain("start");
    expect(getPreset("quote")!.slots).toEqual(["middle"]);
    expect(getPreset("endcard")!.slots).toEqual(["end"]);
    expect(getPreset("logosting")!.slots).toContain("end");
  });
});

describe("getPreset", () => {
  it("resolves known ids and rejects everything else", () => {
    expect(getPreset("headline")?.name).toBe("Kinetic Headline");
    expect(getPreset("none")).not.toBeNull();
    expect(getPreset("does-not-exist")).toBeNull();
    expect(getPreset(null)).toBeNull();
    expect(getPreset(undefined)).toBeNull();
    expect(getPreset("")).toBeNull();
  });
});

describe("slotStart", () => {
  it("uses the preset's own start in the start slot", () => {
    expect(slotStart(getPreset("headline")!, "start", 60)).toBe(0);
    expect(slotStart(getPreset("lowerthird")!, "start", 60)).toBe(1);
    expect(slotStart(getPreset("captionpop")!, "start", 60)).toBe(1.5);
  });

  it("centers effects in the middle slot regardless of their own start", () => {
    expect(slotStart(getPreset("quote")!, "middle", 30)).toBe(15 - 2);
    expect(slotStart(getPreset("lowerthird")!, "middle", 30)).toBe(15 - 1.7);
    expect(slotStart(getPreset("headline")!, "middle", 3)).toBe(0);
  });

  it("anchors the end slot to the last seconds of the reel", () => {
    const endcard = getPreset("endcard")!;
    expect(slotStart(endcard, "end", 30)).toBeCloseTo(30 - 3.6 - 0.2, 5);
    expect(slotStart(getPreset("logosting")!, "end", 30)).toBeCloseTo(
      30 - 2.6 - 0.2,
      5
    );
  });

  it("never starts before the reel begins", () => {
    const endcard = getPreset("endcard")!;
    expect(slotStart(endcard, "end", 2)).toBe(0);
  });
});

describe("effectLocals", () => {
  const start = 2;
  const duration = 3;

  it("draws nothing before the effect starts", () => {
    expect(effectLocals(1.9, start, duration, false)).toEqual([]);
  });

  it("draws a single play inside its window", () => {
    expect(effectLocals(2.5, start, duration, false)).toEqual([0.5]);
    expect(effectLocals(5, start, duration, false)).toEqual([3]);
  });

  it("draws nothing after a single play finishes", () => {
    expect(effectLocals(5.1, start, duration, false)).toEqual([]);
  });

  it("restarts every duration, one pass at a time", () => {
    expect(effectLocals(start + 3, start, duration, true)).toEqual([0]);
    expect(effectLocals(start + 3.5, start, duration, true)).toEqual([0.5]);
    expect(effectLocals(start + 7.25, start, duration, true)).toEqual([1.25]);
  });

  it("never draws two passes at once — the next follows the previous", () => {
    for (let t = start; t < start + 3 * duration; t += 0.1) {
      expect(effectLocals(t, start, duration, true)).toHaveLength(1);
    }
  });

  it("hands off on the boundary without a blank frame from rounding", () => {
    const before = effectLocals(start + duration - 0.001, start, duration, true);
    expect(before).toHaveLength(1);
    expect(before[0]).toBeCloseTo(duration - 0.001, 6);
    expect(effectLocals(start + duration + 0.001, start, duration, true)[0]).toBeCloseTo(
      0.001,
      6
    );
  });

  it("stops looping at the closing effect's start", () => {
    expect(effectLocals(start + 10, start, duration, true, start + 8)).toEqual([]);
    // A single play ignores the cutoff — only loops are cut.
    expect(effectLocals(start + 1.5, start, duration, false, start + 1)).toEqual([
      1.5,
    ]);
  });

  it("does not loop when loop is false even after the cycle length", () => {
    expect(effectLocals(start + duration + 1, start, duration, false)).toEqual([]);
  });
});

describe("plannedFrames", () => {
  it("stops a looped start effect once the end card opens", () => {
    const effects = planEffects(
      [
        { presetId: "headline", slot: "start", loop: true },
        { presetId: "endcard", slot: "end", loop: false },
      ],
      30
    );
    const endcardStart = effects[1].start;
    const before = plannedFrames(effects, endcardStart - 1);
    expect(before.some(({ effect }) => effect.preset.id === "headline")).toBe(true);
    const during = plannedFrames(effects, endcardStart + 0.5);
    expect(during.map(({ effect }) => effect.preset.id)).toEqual(["endcard"]);
  });

  it("keeps a streamed banner rolling past its own duration", () => {
    const effects = planEffects(
      [{ presetId: "breaking", slot: "start", loop: true }],
      60
    );
    const t = breaking.duration + 2.5;
    expect(plannedFrames(effects, t).map(({ local }) => local)).toEqual([t]);
  });

  it("cuts a streamed banner when the end card opens", () => {
    const effects = planEffects(
      [
        { presetId: "breaking", slot: "start", loop: true },
        { presetId: "endcard", slot: "end", loop: false },
      ],
      30
    );
    const endcardStart = effects[1].start;
    expect(
      plannedFrames(effects, endcardStart + 0.5).map(({ effect }) => effect.preset.id)
    ).toEqual(["endcard"]);
  });
});

describe("planEffects", () => {
  it("resolves slot attachments into ordered timed effects", () => {
    const effects = planEffects(
      [
        { presetId: "headline", slot: "start", loop: false },
        { presetId: "endcard", slot: "end", loop: false },
      ],
      30,
      { headline: { text: "Hello" } }
    );
    expect(effects.map((effect) => effect.preset.id)).toEqual([
      "headline",
      "endcard",
    ]);
    expect(effects[0].start).toBe(0);
    expect(effects[0].values).toEqual({ text: "Hello" });
    expect(effects[1].start).toBeCloseTo(30 - 3.6 - 0.2, 5);
  });

  it("drops unknown presets, 'none', and slot-incompatible picks", () => {
    const effects = planEffects(
      [
        { presetId: "ghost", slot: "start", loop: false },
        { presetId: "none", slot: "start", loop: false },
        { presetId: "endcard", slot: "start", loop: false },
        { presetId: "headline", slot: "start", loop: false },
      ],
      30
    );
    expect(effects.map((effect) => effect.preset.id)).toEqual(["headline"]);
  });

  it("keeps end-slot loop flags off — the end effect closes the reel", () => {
    const effects = planEffects(
      [{ presetId: "endcard", slot: "end", loop: true }],
      30
    );
    expect(effects[0].loop).toBe(false);
  });

  it("passes through empty values when none are supplied", () => {
    const effects = planEffects([{ presetId: "stat", slot: "middle", loop: false }], 30);
    expect(effects[0].values).toEqual({});
  });
});

describe("attachmentsFromSlots", () => {
  it("reads the picker's per-slot state into ordered attachments", () => {
    expect(
      attachmentsFromSlots(
        { start: "headline", middle: null, end: "endcard" },
        { start: true, middle: false, end: false }
      )
    ).toEqual([
      { presetId: "headline", slot: "start", loop: true },
      { presetId: "endcard", slot: "end", loop: false },
    ]);
  });

  it("skips empty slots and the 'none' placeholder", () => {
    expect(
      attachmentsFromSlots(
        { start: "none", middle: null, end: "quote" },
        { start: false, middle: false, end: true }
      )
    ).toEqual([{ presetId: "quote", slot: "end", loop: true }]);
  });
});

describe("defaultPresetValues", () => {
  it("seeds every preset's fields with their default values", () => {
    const values = defaultPresetValues();
    expect(Object.keys(values).sort()).toEqual(
      REEL_PRESETS.map((preset) => preset.id).sort()
    );
    expect(values.headline).toEqual({ text: "Big news today" });
    expect(values.none).toEqual({});
  });
});

describe("punchzoom scale curve", () => {
  it("starts at 1, peaks, and returns to 1", () => {
    expect(punchzoom.scale!(0)).toBeCloseTo(1, 5);
    expect(punchzoom.scale!(0.3)).toBeCloseTo(1.16, 5);
    expect(punchzoom.scale!(2.4)).toBeCloseTo(1, 5);
  });
});

describe("shared timing engine delegation", () => {
  it("re-exports the slot helpers unchanged", () => {
    expect(SLOT_ORDER).toBe(sharedPlan.SLOT_ORDER);
    expect(slotStart).toBe(sharedPlan.slotStart);
    expect(effectLocals).toBe(sharedPlan.effectLocals);
    expect(attachmentsFromSlots).toBe(sharedPlan.attachmentsFromSlots);
  });

  it("routes planEffects and plannedFrames through the shared planner", () => {
    const attachments = [
      { presetId: "headline", slot: "start" as const, loop: true },
      { presetId: "endcard", slot: "end" as const, loop: false },
    ];
    const effects = planEffects(attachments, 30);
    expect(effects).toEqual(
      sharedPlan.planEffectsFor(attachments, 30, {}, getPreset)
    );
    expect(plannedFrames(effects, 0.5)).toEqual(
      sharedPlan.plannedFramesFor(effects, 0.5)
    );
  });
});
