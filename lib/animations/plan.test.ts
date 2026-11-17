import { describe, expect, it } from "vitest";
import {
  SLOT_ORDER,
  attachmentsFromSlots,
  effectLocals,
  planEffectsFor,
  plannedFramesFor,
  slotStart,
  type SlotPresetShape,
} from "./plan";

type TestPreset = SlotPresetShape & { label: string };

const draw = () => {};

const opener: TestPreset = {
  id: "opener",
  label: "Opener",
  duration: 2,
  start: 0.5,
  slots: ["start", "middle"],
  draw,
};

const closer: TestPreset = {
  id: "closer",
  label: "Closer",
  duration: 3,
  start: 0,
  slots: ["end"],
  draw,
};

const ticker: TestPreset = {
  id: "ticker",
  label: "Ticker",
  duration: 2,
  start: 0,
  slots: ["start"],
  draw,
  stream: draw,
};

const camera: TestPreset = {
  id: "camera",
  label: "Camera",
  duration: 2,
  start: 0,
  slots: ["start", "middle", "end"],
  scale: (t) => 1 + t / 100,
};

const registry: TestPreset[] = [opener, closer, ticker, camera];
const resolve = (id: string) => registry.find((p) => p.id === id) ?? null;

describe("SLOT_ORDER", () => {
  it("runs open → middle → close", () => {
    expect(SLOT_ORDER).toEqual(["start", "middle", "end"]);
  });
});

describe("slotStart", () => {
  it("anchors the start slot at the preset's own offset", () => {
    expect(slotStart(opener, "start", 30)).toBe(0.5);
  });

  it("centers the middle slot", () => {
    expect(slotStart(opener, "middle", 30)).toBe(14);
  });

  it("leaves a 0.2s tail before the video ends for the close slot", () => {
    expect(slotStart(closer, "end", 30)).toBeCloseTo(30 - 3 - 0.2, 6);
  });

  it("never starts before the clip begins", () => {
    expect(slotStart(closer, "end", 1)).toBe(0);
    expect(slotStart(opener, "middle", 1)).toBe(0);
  });
});

describe("effectLocals", () => {
  it("draws nothing before the effect or after a single play", () => {
    expect(effectLocals(0.4, 0.5, 2, false)).toEqual([]);
    expect(effectLocals(2.6, 0.5, 2, false)).toEqual([]);
  });

  it("draws one local time inside a single play", () => {
    expect(effectLocals(1.5, 0.5, 2, false)).toEqual([1]);
  });

  it("replays a loop back to back", () => {
    expect(effectLocals(0.5 + 2, 0.5, 2, true)).toEqual([0]);
    expect(effectLocals(0.5 + 3, 0.5, 2, true)).toEqual([1]);
  });

  it("cuts a loop at the closing effect's start but not a single play", () => {
    expect(effectLocals(10, 0, 2, true, 6)).toEqual([]);
    expect(effectLocals(1.5, 0, 2, false, 1)).toEqual([1.5]);
  });
});

describe("planEffectsFor", () => {
  it("resolves attachments into timed effects with their values", () => {
    const effects = planEffectsFor(
      [
        { presetId: "opener", slot: "start", loop: false },
        { presetId: "closer", slot: "end", loop: false },
      ],
      30,
      { opener: { text: "Hi" } },
      resolve
    );
    expect(effects.map((e) => e.preset.id)).toEqual(["opener", "closer"]);
    expect(effects[0].start).toBe(0.5);
    expect(effects[0].values).toEqual({ text: "Hi" });
    expect(effects[1].start).toBeCloseTo(26.8, 6);
    expect(effects[1].values).toEqual({});
  });

  it("drops unknown presets, 'none' and slot-incompatible picks", () => {
    const effects = planEffectsFor(
      [
        { presetId: "ghost", slot: "start", loop: false },
        { presetId: "none", slot: "start", loop: false },
        { presetId: "closer", slot: "start", loop: false },
        { presetId: "opener", slot: "start", loop: false },
      ],
      30,
      {},
      resolve
    );
    expect(effects.map((e) => e.preset.id)).toEqual(["opener"]);
  });

  it("keeps camera-only presets — their zoom is drawn by the compositor", () => {
    const effects = planEffectsFor(
      [{ presetId: "camera", slot: "middle", loop: false }],
      30,
      {},
      resolve
    );
    expect(effects).toHaveLength(1);
  });

  it("never loops a closing effect", () => {
    const effects = planEffectsFor(
      [{ presetId: "closer", slot: "end", loop: true }],
      30,
      {},
      resolve
    );
    expect(effects[0].loop).toBe(false);
  });
});

describe("plannedFramesFor", () => {
  it("returns every effect on screen at a time, in attachment order", () => {
    const effects = planEffectsFor(
      [
        { presetId: "opener", slot: "start", loop: false },
        { presetId: "ticker", slot: "start", loop: true },
      ],
      30,
      {},
      resolve
    );
    const frames = plannedFramesFor(effects, 1);
    expect(frames.map(({ effect, local }) => [effect.preset.id, local])).toEqual([
      ["opener", 0.5],
      ["ticker", 1],
    ]);
  });

  it("streams a looped ticker with an unbounded local time", () => {
    const effects = planEffectsFor(
      [{ presetId: "ticker", slot: "start", loop: true }],
      30,
      {},
      resolve
    );
    expect(plannedFramesFor(effects, 9.5)[0].local).toBe(9.5);
  });

  it("stops loops when the closing effect opens the frame", () => {
    const effects = planEffectsFor(
      [
        { presetId: "ticker", slot: "start", loop: true },
        { presetId: "closer", slot: "end", loop: false },
      ],
      30,
      {},
      resolve
    );
    const closing = effects[1].start;
    expect(
      plannedFramesFor(effects, closing + 0.5).map(({ effect }) => effect.preset.id)
    ).toEqual(["closer"]);
  });
});

describe("attachmentsFromSlots", () => {
  it("reads per-slot picks into ordered attachments", () => {
    expect(
      attachmentsFromSlots(
        { start: "opener", middle: null, end: "closer" },
        { start: true, middle: false, end: false }
      )
    ).toEqual([
      { presetId: "opener", slot: "start", loop: true },
      { presetId: "closer", slot: "end", loop: false },
    ]);
  });

  it("skips empty and 'none' slots", () => {
    expect(
      attachmentsFromSlots(
        { start: "none", middle: null, end: null },
        { start: true, middle: true, end: true }
      )
    ).toEqual([]);
  });
});
