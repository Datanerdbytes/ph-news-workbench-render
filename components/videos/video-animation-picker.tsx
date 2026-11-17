'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  SLOT_ORDER,
  VIDEO_PRESET_CATEGORIES,
  VIDEO_PRESETS,
  getVideoPreset,
  presetDefaultValues,
  type PresetSlot,
  type PresetValues,
  type VideoPreset,
} from '@/lib/videos/presets';
import { mountVideoPreset } from '@/lib/videos/presets.preview';
import { FieldLabel, inputClass } from '@/components/publishing/publish-page';
import { cn } from 'cn';

const THUMB_W = 118;
const PREVIEW_BOX = { w: 320, h: 180 };
const EMPTY_VALUES: PresetValues = {};

/** Per-slot selection: which animation (if any) each slot has attached. */
export type VideoSlotSelection = Record<PresetSlot, string | null>;

/** Per-slot loop toggles: repeat the attached animation through the video. */
export type VideoSlotLoops = Record<PresetSlot, boolean>;

const SLOT_META: { key: PresetSlot; label: string; empty: string }[] = [
  { key: 'start', label: 'Open', empty: 'Pick an animation that opens the video.' },
  { key: 'middle', label: 'Middle', empty: 'Pick an animation for mid-video.' },
  { key: 'end', label: 'Close', empty: 'Pick an animation that closes the video.' },
];

function PresetThumb({
  presetId,
  values,
  width,
}: {
  presetId: string;
  values: PresetValues;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The preview samples this object on every tick, so field edits show live
  // without tearing down and restarting the tween.
  const live = useRef<PresetValues>({});

  useEffect(() => {
    Object.assign(live.current, presetDefaultValues(presetId), values);
  }, [presetId, values]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;inset:0;';
    el.appendChild(stage);
    const preview = mountVideoPreset(stage, presetId, live.current, PREVIEW_BOX);
    return () => {
      preview?.kill();
      stage.remove();
    };
  }, [presetId]);

  return (
    <div
      ref={ref}
      style={{ width, height: (width * 9) / 16 }}
      className="relative overflow-hidden rounded-md bg-ink"
      aria-hidden
    />
  );
}

function dotClass(filled: boolean, active: boolean) {
  if (filled) return 'bg-brand';
  return active ? 'bg-paper/50' : 'bg-muted-foreground/40';
}

function playbackHint(slot: PresetSlot, preset: VideoPreset, loops: boolean) {
  if (slot === 'end') return `Plays ${preset.window.toLowerCase()}.`;
  if (!loops) return 'Plays once.';
  if (preset.stream) {
    return 'Keeps scrolling through the video, stopping when the closing animation starts.';
  }
  return `Repeats every ${preset.duration.toFixed(1)}s — each pass follows the one before, stopping when the closing animation starts.`;
}

function SlotEditor({
  slot,
  preset,
  loop,
  values,
  disabled,
  onLoopChange,
  onFieldChange,
  onRemove,
}: {
  slot: PresetSlot;
  preset: VideoPreset;
  loop: boolean;
  values: PresetValues;
  disabled: boolean;
  onLoopChange: (loop: boolean) => void;
  onFieldChange: (key: string, text: string) => void;
  onRemove: () => void;
}) {
  const loops = loop && slot !== 'end';
  return (
    <div className="grid gap-2.5 rounded-lg border border-dashed border-border bg-background/60 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-ink px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-paper">
          {slot}
        </span>
        <Sparkles className="size-3.5 text-brand" aria-hidden />
        <span className="truncate text-[11.5px] font-semibold">{preset.name}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {slot !== 'end' && (
            <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px] font-semibold text-muted-foreground">
              <input
                type="checkbox"
                checked={loop}
                disabled={disabled}
                onChange={(event) => onLoopChange(event.target.checked)}
                className="size-4 accent-[var(--brand)]"
              />
              Loop
            </label>
          )}
          <button
            type="button"
            aria-label={`Remove ${preset.name} from the ${slot} slot`}
            onClick={onRemove}
            disabled={disabled}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      {preset.fields.map((field) => (
        <div key={field.key}>
          <FieldLabel htmlFor={`video-preset-${slot}-${preset.id}-${field.key}`}>
            {field.label}
          </FieldLabel>
          <input
            id={`video-preset-${slot}-${preset.id}-${field.key}`}
            type="text"
            value={values[field.key] ?? field.value}
            disabled={disabled}
            onChange={(event) => onFieldChange(field.key, event.target.value)}
            className={cn(inputClass, 'mt-1')}
          />
        </div>
      ))}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {playbackHint(slot, preset, loops)}
      </p>
    </div>
  );
}

/**
 * Gallery of ready-made, broadcast-style animations for regular videos.
 * Pick a slot (open / middle / close), tap a card to attach it, edit its text,
 * and loop it. Each slot keeps its own field values, so the same preset can
 * open and close the video with different text. Attachments are baked into
 * the video when you post or schedule.
 */
export function VideoAnimationPicker({
  slots,
  loops,
  values,
  disabled = false,
  className,
  onSelect,
  onLoopChange,
  onFieldChange,
}: {
  slots: VideoSlotSelection;
  loops: VideoSlotLoops;
  /** Field values keyed by slot; missing slots fall back to preset defaults. */
  values: Record<string, PresetValues>;
  disabled?: boolean;
  className?: string;
  onSelect: (slot: PresetSlot, presetId: string | null) => void;
  onLoopChange: (slot: PresetSlot, loop: boolean) => void;
  onFieldChange: (slot: PresetSlot, key: string, text: string) => void;
}) {
  const [filter, setFilter] = useState<string>('All');
  const [activeSlot, setActiveSlot] = useState<PresetSlot>('start');

  const visible = VIDEO_PRESETS.filter(
    (preset) =>
      preset.id === 'none' ||
      (preset.slots.includes(activeSlot) &&
        (filter === 'All' || preset.category === filter))
  );

  return (
    <div className={className}>
      <FieldLabel hint="Rendered into the video on post">Animations</FieldLabel>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {SLOT_META.map(({ key, label }) => {
          const active = activeSlot === key;
          const filled = Boolean(slots[key]);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => setActiveSlot(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'border-ink bg-ink text-paper'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', dotClass(filled, active))}
              />
              {label}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {VIDEO_PRESET_CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            aria-pressed={filter === category}
            disabled={disabled}
            onClick={() => setFilter(category)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
              filter === category
                ? 'border-ink bg-ink text-paper'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            )}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="mt-2 flex gap-2 overflow-x-auto pb-2">
        {visible.map((preset) => {
          const selected = slots[activeSlot] === preset.id;
          const assignedSlot = SLOT_ORDER.find((slot) => slots[slot] === preset.id);
          const cardValues =
            slots[activeSlot] === preset.id
              ? values[activeSlot] ?? EMPTY_VALUES
              : EMPTY_VALUES;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() =>
                onSelect(
                  activeSlot,
                  preset.id === 'none' || selected ? null : preset.id
                )
              }
              className={cn(
                'relative w-[132px] shrink-0 rounded-[10px] border bg-card p-1.5 text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-ink ring-2 ring-ink/15'
                  : 'border-border hover:border-muted-foreground/40'
              )}
            >
              <PresetThumb
                presetId={preset.id}
                values={cardValues}
                width={THUMB_W}
              />
              {assignedSlot && (
                <span className="absolute right-2 top-2 rounded-full bg-ink px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-paper">
                  {assignedSlot}
                </span>
              )}
              <span className="mt-1.5 block truncate text-[11px] font-semibold leading-tight">
                {preset.name}
              </span>
              <span className="block truncate text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                {preset.id === 'none' ? 'Clear slot' : preset.category}
              </span>
            </button>
          );
        })}
      </div>

      {!slots[activeSlot] && (
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {SLOT_META.find((meta) => meta.key === activeSlot)?.empty}
        </p>
      )}

      <div className="mt-2 grid gap-2">
        {SLOT_ORDER.map((slot) => {
          const preset = getVideoPreset(slots[slot]);
          if (!preset || preset.id === 'none') return null;
          return (
            <SlotEditor
              key={slot}
              slot={slot}
              preset={preset}
              loop={loops[slot]}
              values={{
                ...presetDefaultValues(preset.id),
                ...values[slot],
              }}
              disabled={disabled}
              onLoopChange={(loop) => onLoopChange(slot, loop)}
              onFieldChange={(key, text) => onFieldChange(slot, key, text)}
              onRemove={() => onSelect(slot, null)}
            />
          );
        })}
      </div>
    </div>
  );
}
