"use client";

import { useEffect, useRef } from "react";
import { Images } from "lucide-react";
import {
  SLIDESHOW_PRESETS,
  type SlideshowBox,
} from "@/lib/videos/slideshow-presets";
import { mountSlideshowPreset } from "@/lib/videos/slideshow-presets.preview";
import { cn } from "@/lib/utils";

const THUMB_W = 148;
// 16:9 like the bake canvas, scaled down for the card.
const PREVIEW_BOX: SlideshowBox = { w: 480, h: 270 };

function PresetThumb({
  presetId,
  images,
}: {
  presetId: string;
  images: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stage = document.createElement("div");
    stage.style.cssText = "position:absolute;inset:0;";
    el.appendChild(stage);
    let handle: { kill: () => void } | null = null;
    let cancelled = false;
    void mountSlideshowPreset(stage, presetId, images, PREVIEW_BOX).then(
      (mounted) => {
        // The mount loads photos first, so it may resolve after unmount.
        if (cancelled) mounted?.kill();
        else handle = mounted;
      },
    );
    return () => {
      cancelled = true;
      handle?.kill();
      stage.remove();
    };
  }, [presetId, images]);

  return (
    <div
      ref={ref}
      style={{ width: THUMB_W, height: (THUMB_W * 9) / 16 }}
      className="relative overflow-hidden rounded-md bg-foreground/90"
      aria-hidden="true"
    />
  );
}

type SlideshowStylePickerProps = {
  presetId: string;
  images: string[];
  disabled?: boolean;
  className?: string;
  onSelect: (presetId: string) => void;
};

export function SlideshowStylePicker({
  presetId,
  images,
  disabled = false,
  className,
  onSelect,
}: SlideshowStylePickerProps) {
  return (
    <div className={cn("rounded-xl border border-border/80 bg-muted/20 p-3 sm:p-4", className)}>
      <div className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <Images className="h-4 w-4 text-primary" aria-hidden="true" />
        Slideshow animation
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        How the attached photos move in the narrated slideshow video.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SLIDESHOW_PRESETS.map((preset) => {
          const active = preset.id === presetId;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(preset.id)}
              disabled={disabled}
              className={cn(
                "flex w-[164px] flex-col gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              <PresetThumb presetId={preset.id} images={images} />
              <span className="flex flex-col">
                <span className="text-xs font-semibold">{preset.name}</span>
                <span className="text-[11px] leading-4 text-muted-foreground">
                  {preset.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
