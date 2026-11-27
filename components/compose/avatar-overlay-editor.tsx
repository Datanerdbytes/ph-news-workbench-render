"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  CornerDownRight,
  Crosshair,
  Maximize2,
  Move,
  Pause,
  Play,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  COMPOSITION_HEIGHT,
  COMPOSITION_WIDTH,
  MIN_AVATAR_WIDTH,
  avatarPlacementHeight,
  avatarPlacementPreset,
  clampAvatarPlacement,
  clampOriginalAudioVolume,
  moveAvatarPlacement,
  resizeAvatarPlacement,
  type AvatarPlacement,
  type AvatarPlacementPreset,
} from "@/lib/videos/composition";
import { imageSrc } from "@/lib/format";
import { useAvatarPreview } from "@/lib/videos/use-avatar-preview";
import { cn } from "@/lib/utils";

type AvatarOverlayEditorProps = {
  avatarUrl: string;
  baseVideoUrl: string | null;
  images: string[];
  placement: AvatarPlacement;
  onPlacementChange: (placement: AvatarPlacement) => void;
  originalAudioVolume: number;
  onOriginalAudioVolumeChange: (volume: number) => void;
  transparent?: boolean;
  disabled: boolean;
};

type DragState = {
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  placement: AvatarPlacement;
  target: HTMLElement;
};

const PRESETS: {
  id: AvatarPlacementPreset;
  label: string;
  icon: typeof CornerDownRight;
}[] = [
  { id: "lower-right", label: "Lower right", icon: CornerDownRight },
  { id: "lower-left", label: "Lower left", icon: CornerDownLeft },
  { id: "center", label: "Center", icon: Crosshair },
  { id: "full-width", label: "Full width", icon: Maximize2 },
];

function samePlacement(a: AvatarPlacement, b: AvatarPlacement): boolean {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.width - b.width) < 0.001
  );
}

export function AvatarOverlayEditor({
  avatarUrl,
  baseVideoUrl,
  images,
  placement,
  onPlacementChange,
  originalAudioVolume,
  onOriginalAudioVolumeChange,
  transparent = false,
  disabled,
}: AvatarOverlayEditorProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const baseVideoRef = useRef<HTMLVideoElement>(null);
  const avatarVideoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const preview = useAvatarPreview(avatarUrl);
  const avatarPreviewUrl = preview.url;
  const [avatarAspect, setAvatarAspect] = useState(16 / 9);
  const [playingSource, setPlayingSource] = useState<string | null>(null);
  const [duckOriginal, setDuckOriginal] = useState(false);
  const isPlaying =
    playingSource === avatarUrl && !disabled && Boolean(avatarPreviewUrl);
  const safePlacement = clampAvatarPlacement(placement, avatarAspect);
  const safeVolume = clampOriginalAudioVolume(originalAudioVolume);
  const baseImage = images[0];
  const imageCount = images.length;
  const height = avatarPlacementHeight(safePlacement, avatarAspect);
  const maxWidth = Math.min(
    1,
    (avatarAspect * COMPOSITION_HEIGHT) / COMPOSITION_WIDTH,
  );
  const minWidth = Math.min(MIN_AVATAR_WIDTH, maxWidth);

  useEffect(() => {
    const videos = [baseVideoRef.current, avatarVideoRef.current].filter(
      (video): video is HTMLVideoElement => Boolean(video),
    );
    if (!isPlaying) {
      for (const video of videos) video.pause();
      return;
    }
    void Promise.all(videos.map((video) => video.play())).catch(() => {
      setPlayingSource(null);
      setDuckOriginal(false);
    });
  }, [isPlaying, avatarUrl, baseVideoUrl]);

  useEffect(() => {
    const base = baseVideoRef.current;
    if (!base) return;
    base.volume = isPlaying && duckOriginal ? safeVolume : 1;
  }, [isPlaying, duckOriginal, safeVolume, baseVideoUrl]);

  function beginDrag(
    event: PointerEvent<HTMLElement>,
    mode: DragState["mode"],
  ) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      placement: safePlacement,
      target: event.currentTarget,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const preview = previewRef.current;
    if (!drag || !preview || drag.pointerId !== event.pointerId) return;
    const bounds = preview.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = (event.clientX - drag.startX) / bounds.width;
    const deltaY = (event.clientY - drag.startY) / bounds.height;
    if (drag.mode === "move") {
      onPlacementChange(
        moveAvatarPlacement(drag.placement, deltaX, deltaY, avatarAspect),
      );
      return;
    }
    const verticalWidth =
      (deltaY * avatarAspect * COMPOSITION_HEIGHT) / COMPOSITION_WIDTH;
    onPlacementChange(
      resizeAvatarPlacement(
        drag.placement,
        drag.placement.width + (deltaX + verticalWidth) / 2,
        avatarAspect,
      ),
    );
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.target.hasPointerCapture(event.pointerId)) {
      drag.target.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  function handleOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const movements: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const movement = movements[event.key];
    if (movement) {
      event.preventDefault();
      onPlacementChange(
        moveAvatarPlacement(safePlacement, movement[0], movement[1], avatarAspect),
      );
      return;
    }
    if (["+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "-" || event.key === "_" ? -1 : 1;
      onPlacementChange(
        resizeAvatarPlacement(
          safePlacement,
          safePlacement.width + direction * 0.02,
          avatarAspect,
        ),
      );
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      onPlacementChange(avatarPlacementPreset("lower-right", avatarAspect));
    }
  }

  function togglePlayback() {
    if (disabled || !avatarPreviewUrl) return;
    if (!isPlaying) {
      for (const video of [baseVideoRef.current, avatarVideoRef.current]) {
        if (video?.ended) video.currentTime = 0;
      }
      setDuckOriginal(Boolean(baseVideoRef.current));
    } else {
      setDuckOriginal(false);
    }
    setPlayingSource(isPlaying ? null : avatarUrl);
  }

  function stopWhenFinished() {
    const base = baseVideoRef.current;
    const avatar = avatarVideoRef.current;
    if (avatar?.ended) setDuckOriginal(false);
    if (avatar?.ended && (!base || base.ended)) setPlayingSource(null);
  }

  return (
    <section
      aria-labelledby="avatar-overlay-heading"
      className="rounded-xl border border-border bg-card p-3 sm:p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="avatar-overlay-heading"
            className="flex min-h-11 items-center gap-2 text-sm font-semibold"
          >
            <Move className="h-4 w-4 text-primary" aria-hidden="true" />
            Avatar overlay
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Position the avatar over your attachment, then bake both into one 16:9 video.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={togglePlayback}
          disabled={disabled || !avatarPreviewUrl}
          className="min-h-11 shrink-0"
          aria-label={isPlaying ? "Pause overlay preview" : "Play overlay preview"}
        >
          {isPlaying ? (
            <Pause className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {isPlaying ? "Pause" : "Preview"}
        </Button>
      </div>

      <div
        ref={previewRef}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative mt-3 aspect-video w-full overflow-visible rounded-lg border border-border bg-black"
      >
        <div className="absolute inset-0 overflow-hidden rounded-lg">
          {baseVideoUrl ? (
            <video
              ref={baseVideoRef}
              src={baseVideoUrl}
              playsInline
              preload="metadata"
              onEnded={stopWhenFinished}
              onLoadedMetadata={() => {
                setPlayingSource(null);
                for (const video of [baseVideoRef.current, avatarVideoRef.current]) {
                  if (video?.readyState) video.currentTime = 0;
                }
              }}
              className="h-full w-full object-cover"
              aria-label="Attached video beneath the avatar"
            />
          ) : baseImage ? (
            <img
              src={imageSrc(baseImage)}
              alt="Attached photo beneath the avatar"
              className="h-full w-full object-cover"
            />
          ) : null}
        </div>

        <div
          className="pointer-events-none absolute"
          style={{
            left: `${safePlacement.x * 100}%`,
            top: `${safePlacement.y * 100}%`,
            width: `${safePlacement.width * 100}%`,
            height: `${height * 100}%`,
          }}
        >
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label="Avatar overlay. Use arrow keys to move, plus or minus to resize, and Home to reset."
            aria-describedby="avatar-overlay-help"
            aria-disabled={disabled}
            aria-roledescription="movable video overlay"
            onPointerDown={(event) => beginDrag(event, "move")}
            onKeyDown={handleOverlayKeyDown}
            className={cn(
              // The preview wrapper disables pointer events so the footage
              // beneath stays non-interactive; the movable overlay must
              // opt back in or drag and keyboard focus stop working.
              "pointer-events-auto group relative h-full w-full touch-none select-none border-2 border-white shadow-lg outline-none transition-[box-shadow]",
              transparent ? "bg-transparent" : "bg-black",
              disabled
                ? "cursor-not-allowed"
                : "cursor-move focus-visible:ring-4 focus-visible:ring-primary/70",
            )}
          >
            {avatarPreviewUrl ? (
              <video
                ref={avatarVideoRef}
                src={avatarPreviewUrl}
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  setPlayingSource(null);
                  for (const source of [baseVideoRef.current, avatarVideoRef.current]) {
                    if (source?.readyState) source.currentTime = 0;
                  }
                  const video = event.currentTarget;
                  const aspect = video.videoWidth / video.videoHeight;
                  if (!Number.isFinite(aspect) || aspect <= 0) return;
                  setAvatarAspect(aspect);
                  onPlacementChange(clampAvatarPlacement(safePlacement, aspect));
                }}
                onEnded={stopWhenFinished}
                className="pointer-events-none h-full w-full object-fill"
                aria-hidden="true"
              />
            ) : null}
            <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
              Avatar
            </span>
          </div>
          <button
            type="button"
            onPointerDown={(event) => beginDrag(event, "resize")}
            disabled={disabled}
            aria-label="Resize avatar overlay"
            className="pointer-events-auto absolute -bottom-2 -right-2 grid size-11 touch-none place-items-center rounded-full border-2 border-white bg-primary text-primary-foreground shadow-md outline-none transition-transform hover:scale-105 focus-visible:ring-4 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Maximize2 className="size-4" aria-hidden="true" />
          </button>
        </div>

        {imageCount > 1 && !baseVideoUrl ? (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] font-medium text-white">
            Photo 1 of {imageCount}
          </span>
        ) : null}
      </div>

      {preview.error ? (
        <p
          role="alert"
          className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive"
        >
          {preview.error}
        </p>
      ) : null}

      <p
        id="avatar-overlay-help"
        className="mt-2 text-xs leading-5 text-muted-foreground"
      >
        Drag to move or use the corner handle to resize. Keyboard: arrow keys move,
        Shift + arrows move faster, + / − resize, and Home resets the position.
        Preview includes the avatar&apos;s audio and ducks the attached video while
        the avatar speaks.
      </p>

      <div className="mt-4 space-y-4 border-t border-border/60 pt-3">
        <fieldset>
          <legend className="text-xs font-medium">Position presets</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRESETS.map((preset) => {
              const Icon = preset.icon;
              const selected = samePlacement(
                safePlacement,
                avatarPlacementPreset(preset.id, avatarAspect),
              );
              return (
                <Button
                  key={preset.id}
                  type="button"
                  variant={selected ? "secondary" : "outline"}
                  size="sm"
                  onClick={() =>
                    onPlacementChange(
                      avatarPlacementPreset(preset.id, avatarAspect),
                    )
                  }
                  disabled={disabled}
                  aria-pressed={selected}
                  className="min-h-11 w-full"
                >
                  <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                  {preset.label}
                </Button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="text-xs font-medium">Fine movement</span>
            <div className="mt-2 flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  onPlacementChange(
                    moveAvatarPlacement(safePlacement, -0.02, 0, avatarAspect),
                  )
                }
                disabled={disabled}
                aria-label="Move avatar left"
                className="h-11 w-11"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  onPlacementChange(
                    moveAvatarPlacement(safePlacement, 0, -0.02, avatarAspect),
                  )
                }
                disabled={disabled}
                aria-label="Move avatar up"
                className="h-11 w-11"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  onPlacementChange(
                    moveAvatarPlacement(safePlacement, 0, 0.02, avatarAspect),
                  )
                }
                disabled={disabled}
                aria-label="Move avatar down"
                className="h-11 w-11"
              >
                <ArrowDown className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  onPlacementChange(
                    moveAvatarPlacement(safePlacement, 0.02, 0, avatarAspect),
                  )
                }
                disabled={disabled}
                aria-label="Move avatar right"
                className="h-11 w-11"
              >
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <label className="block space-y-1.5 text-xs font-medium">
            <span className="flex items-center justify-between gap-2">
              Avatar size
              <span className="font-normal tabular-nums text-muted-foreground">
                {Math.round(safePlacement.width * 100)}%
              </span>
            </span>
            <input
              type="range"
              min={minWidth}
              max={maxWidth}
              step={0.01}
              value={safePlacement.width}
              onChange={(event) =>
                onPlacementChange(
                  resizeAvatarPlacement(
                    safePlacement,
                    Number(event.target.value),
                    avatarAspect,
                  ),
                )
              }
              disabled={disabled}
              className="mt-4 h-2 w-full cursor-pointer accent-primary"
            />
          </label>
        </div>

        {baseVideoUrl ? (
          <label className="block space-y-1.5 text-xs font-medium">
            <span className="flex items-center justify-between gap-2">
              Original video volume
              <span className="font-normal tabular-nums text-muted-foreground">
                {Math.round(safeVolume * 100)}%
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={safeVolume}
              onChange={(event) =>
                onOriginalAudioVolumeChange(
                  clampOriginalAudioVolume(Number(event.target.value)),
                )
              }
              disabled={disabled}
              className="h-2 w-full cursor-pointer accent-primary"
            />
            <span className="block text-[11px] font-normal leading-5 text-muted-foreground">
              The attached audio plays at this level while the avatar speaks, then
              returns to full volume.
            </span>
          </label>
        ) : null}

        <p className="rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
          Overlay edits do not regenerate the paid avatar. They are applied when you
          publish or schedule. Without an attachment, the avatar video is used as-is.
        </p>
      </div>
    </section>
  );
}
