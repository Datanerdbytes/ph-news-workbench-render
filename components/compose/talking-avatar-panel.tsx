"use client";

import {
  AlertTriangle,
  Info,
  Loader2,
  PersonStanding,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AVATARS,
  type AvatarId,
} from "@/lib/avatar/avatars";
import {
  ACTIVE_AVATAR_STATUSES,
  type PublicAvatarJob,
} from "@/lib/avatar/jobs";
import {
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
  TTS_VOICES,
  type TtsVoiceId,
} from "@/lib/tts/voices";
import { cn } from "@/lib/utils";

type TalkingAvatarPanelProps = {
  avatarId: AvatarId;
  onAvatarChange: (avatarId: AvatarId) => void;
  voiceId: TtsVoiceId;
  onVoiceChange: (voiceId: TtsVoiceId) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  job: PublicAvatarJob | null;
  busy: boolean;
  error: string;
  stale: boolean;
  hasText: boolean;
  hasMedia: boolean;
  disabled: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  onRemove: () => void;
};

export function TalkingAvatarPanel({
  avatarId,
  onAvatarChange,
  voiceId,
  onVoiceChange,
  speed,
  onSpeedChange,
  job,
  busy,
  error,
  stale,
  hasText,
  hasMedia,
  disabled,
  onGenerate,
  onCancel,
  onRemove,
}: TalkingAvatarPanelProps) {
  const active = Boolean(job && ACTIVE_AVATAR_STATUSES.includes(job.status));
  const terminal = Boolean(job && !active);
  const reusable = !job || job.publishState === "ready";
  const controlsDisabled = disabled || busy || active;
  const status = busy
    ? "Starting the avatar job…"
    : error
      ? error
      : active
        ? job?.statusMessage || "Azure is generating the avatar video…"
        : stale
          ? "The draft or avatar settings changed. Regenerate before publishing."
          : job?.status === "cancelled"
            ? "Avatar generation canceled."
            : job?.publishState === "scheduled"
              ? "This avatar video is attached to a scheduled post."
              : job?.publishState === "published"
                ? "This avatar video has been published."
                : job?.publishState === "publishing"
                  ? "This avatar video is being published."
                  : job?.status === "completed" && job.videoUrl
                    ? "Avatar video ready."
                    : "Generate a talking avatar from the current draft.";

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <PersonStanding className="h-4 w-4 text-primary" aria-hidden="true" />
            Talking avatar
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Turn the current draft into a narrated H.264 video for publishing or scheduling.
          </p>
        </div>
        {terminal && reusable && !busy ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={disabled}
            aria-label="Remove avatar video"
            className="h-11 w-11 shrink-0 text-muted-foreground"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
        <details className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            Paid Azure service — review avatar billing
          </summary>
          <p className="mt-1">
            Avatar video seconds and narration characters are billed separately. Eligible
            charges may use a new Azure Free Account&apos;s introductory $200 credit, which
            expires after 30 days; avatars are not permanently free. App limits reduce
            accidental usage but are not an Azure spending cap.
          </p>
        </details>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium">
            Avatar
            <select
              value={avatarId}
              onChange={(event) => onAvatarChange(event.target.value as AvatarId)}
              disabled={controlsDisabled}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <optgroup label="Full body">
                {AVATARS.filter((avatar) => avatar.kind === "video").map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {avatar.name} · {avatar.style}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Photo">
                {AVATARS.filter((avatar) => avatar.kind === "photo").map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {avatar.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="space-y-1.5 text-xs font-medium">
            Voice
            <select
              value={voiceId}
              onChange={(event) => onVoiceChange(event.target.value as TtsVoiceId)}
              disabled={controlsDisabled}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {TTS_VOICES.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.locale === "fil-PH" ? "Filipino" : "English (PH)"} · {voice.name}{" "}
                  ({voice.gender})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block space-y-1.5 text-xs font-medium">
          <span className="flex items-center justify-between gap-2">
            Speaking speed
            <span className="font-normal text-muted-foreground">{speed.toFixed(2)}×</span>
          </span>
          <input
            type="range"
            min={MIN_TTS_SPEED}
            max={MAX_TTS_SPEED}
            step={0.05}
            value={speed}
            onChange={(event) => onSpeedChange(Number(event.target.value))}
            disabled={controlsDisabled}
            className="mt-4 h-2 w-full cursor-pointer accent-primary"
          />
        </label>

        {!hasText ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            Write or generate a draft before creating an avatar.
          </p>
        ) : null}
        {hasMedia ? (
          <p className="text-xs leading-5 text-muted-foreground">
            When this avatar is ready, position it over attached photos or clips and
            bake both into one 16:9 video.
          </p>
        ) : null}

        {active ? (
          <div className="space-y-2">
            <div
              role="progressbar"
              aria-label="Avatar generation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((job?.progress ?? 0) * 100)}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${Math.round((job?.progress ?? 0.05) * 100)}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy || disabled} className="min-h-11">
                <X className="mr-2 h-4 w-4" aria-hidden="true" />
                Cancel generation
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round((job?.progress ?? 0) * 100)}%
              </span>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={onGenerate}
            disabled={disabled || busy || !hasText || !reusable}
            className="min-h-11"
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : job?.status === "completed" ? (
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <PersonStanding className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Starting…" : job?.status === "completed" ? "Regenerate avatar" : "Generate avatar"}
          </Button>
        )}

        {job?.status === "completed" && job.videoUrl ? (
          <video
            controls
            preload="metadata"
            src={job.videoUrl}
            className="aspect-video w-full rounded-lg border border-border bg-black"
            aria-label={hasMedia ? "Source talking avatar preview" : "Talking avatar preview"}
          />
        ) : null}
        {job?.durationSeconds ? (
          <p className="text-xs tabular-nums text-muted-foreground">
            {job.durationSeconds.toFixed(1)} sec
          </p>
        ) : null}

        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "flex items-start gap-2 text-xs leading-5",
            error || stale ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error || stale ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : null}
          {status}
        </p>
      </div>
    </div>
  );
}
