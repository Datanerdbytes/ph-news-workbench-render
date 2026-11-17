/**
 * Shared timing model for attachable video overlays.
 *
 * Reels and regular videos use the same slot rules — an effect is anchored by
 * the slot it is attached to (start / middle / end), loops replay back to back,
 * and a closing effect owns the frame while it plays — but draw different
 * canvases. This module holds the timing so both registries stay in sync.
 */

export type PresetValues = Record<string, string>;

export type PresetField = { key: string; label: string; value: string };

/** Where in the video an animation can be attached. */
export type PresetSlot = 'start' | 'middle' | 'end';

/** One animation picked for a slot; `loop` repeats it through the video. */
export type SlotAttachment = {
  presetId: string;
  slot: PresetSlot;
  loop: boolean;
  /**
   * Key under which this attachment's field values are looked up. Defaults to
   * the preset id; video pages key by slot so the same preset can fill two
   * slots with different text.
   */
  valuesKey?: string;
};

export const SLOT_ORDER: PresetSlot[] = ['start', 'middle', 'end'];

/** The timing surface every attachable preset must expose. */
export type SlotPresetShape = {
  id: string;
  duration: number;
  start: number;
  slots: PresetSlot[];
  draw?: SlotDrawFn;
  stream?: SlotDrawFn;
  scale?: (t: number) => number;
};

/**
 * Frame renderer shared by both registries. Reels draw into a fixed design
 * space and ignore `box`; regular videos lay out relative to it, so the
 * parameter is optional for those callers.
 */
export type SlotDrawFn = (
  ctx: CanvasRenderingContext2D,
  t: number,
  duration: number,
  values: PresetValues,
  box: { w: number; h: number }
) => void;

/** Effect start time for `slot` on a video of `videoDuration` seconds. */
export function slotStart(
  preset: Pick<SlotPresetShape, 'duration' | 'start'>,
  slot: PresetSlot,
  videoDuration: number
): number {
  if (slot === 'end') {
    return Math.max(0, videoDuration - preset.duration - 0.2);
  }
  if (slot === 'middle') {
    return Math.max(0, videoDuration / 2 - preset.duration / 2);
  }
  return preset.start;
}

/**
 * Local times to draw an effect at, for absolute video time `t`.
 *
 * A single play draws once inside its window. A looped effect replays its full
 * in/out cycle every `duration` seconds; passes run back to back, never
 * overlapping, so the next pass follows the previous one instead of landing
 * on top of it. `endAt` — the absolute time the closing effect starts — ends
 * the loop, so the end plate is never painted over by a repeated animation.
 */
export function effectLocals(
  t: number,
  start: number,
  duration: number,
  loop: boolean,
  endAt: number = Number.POSITIVE_INFINITY
): number[] {
  if (t < start || duration <= 0) return [];
  if (!loop) {
    const local = t - start;
    return local <= duration ? [local] : [];
  }
  if (t >= endAt) return [];
  return [(t - start) % duration];
}

/** A planned effect: a preset resolved to one absolute time on a video. */
export type PlannedEffectOf<P extends SlotPresetShape> = {
  preset: P;
  slot: PresetSlot;
  loop: boolean;
  /** Absolute video time the effect (or its first looped cycle) starts. */
  start: number;
  values: PresetValues;
};

/** One draw of a planned effect at its own local time. */
export type EffectFrameOf<P extends SlotPresetShape> = {
  effect: PlannedEffectOf<P>;
  local: number;
};

/**
 * Resolves the picker's attachments into concrete timed effects for one video:
 * slots become absolute times, unknown/incompatible picks are dropped, and
 * 'end' effects never loop (their single play already closes the video).
 */
export function planEffectsFor<P extends SlotPresetShape>(
  attachments: SlotAttachment[],
  videoDuration: number,
  values: Record<string, PresetValues>,
  resolve: (id: string) => P | null
): PlannedEffectOf<P>[] {
  const planned: PlannedEffectOf<P>[] = [];
  for (const attachment of attachments) {
    const preset = resolve(attachment.presetId);
    if (!preset || preset.id === 'none') continue;
    if (!preset.draw && !preset.scale) continue;
    if (!preset.slots.includes(attachment.slot)) continue;
    planned.push({
      preset,
      slot: attachment.slot,
      loop: attachment.loop && attachment.slot !== 'end',
      start: slotStart(preset, attachment.slot, videoDuration),
      values: values[attachment.valuesKey ?? attachment.presetId] ?? {},
    });
  }
  return planned;
}

/**
 * The draws one video frame needs: every planned effect that is on screen at
 * absolute time `t`, in attachment order. Streaming loops (a ticker) keep a
 * single unbounded local time so their content flows across repeats instead
 * of restarting; every other loop restarts every `duration` seconds. Loops
 * stop at the closing effect's start so the end plate keeps the frame to
 * itself.
 */
export function plannedFramesFor<P extends SlotPresetShape>(
  effects: PlannedEffectOf<P>[],
  t: number
): EffectFrameOf<P>[] {
  let endAt = Number.POSITIVE_INFINITY;
  for (const effect of effects) {
    if (effect.slot === 'end') endAt = Math.min(endAt, effect.start);
  }
  const frames: EffectFrameOf<P>[] = [];
  for (const effect of effects) {
    if (effect.loop && effect.preset.stream) {
      if (t >= effect.start && t < endAt) {
        frames.push({ effect, local: t - effect.start });
      }
      continue;
    }
    for (const local of effectLocals(
      t,
      effect.start,
      effect.preset.duration,
      effect.loop,
      endAt
    )) {
      frames.push({ effect, local });
    }
  }
  return frames;
}

/** Renderer for one planned frame: `stream` while streaming, else `draw`. */
export function effectRendererFor<P extends SlotPresetShape>(
  effect: PlannedEffectOf<P>
): P['draw'] | P['stream'] {
  return effect.loop && effect.preset.stream
    ? effect.preset.stream
    : effect.preset.draw;
}

/** Reads the picker's per-slot selection into bake-ready attachments. */
export function attachmentsFromSlots(
  slots: Record<PresetSlot, string | null>,
  loops: Record<PresetSlot, boolean>
): SlotAttachment[] {
  return SLOT_ORDER.flatMap((slot) => {
    const presetId = slots[slot];
    if (!presetId || presetId === 'none') return [];
    return [{ presetId, slot, loop: loops[slot] }];
  });
}
