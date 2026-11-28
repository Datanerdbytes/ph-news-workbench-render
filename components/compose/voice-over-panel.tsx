"use client";

import Link from "next/link";
import {
  AlertTriangle,
  AudioLines,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  providerSupportsLanguage,
  providerSupportsSpeed,
  ttsProviderLabel,
  voicesForProvider,
  type TtsProviderId,
} from "@/lib/tts/providers";
import { MAX_TTS_SPEED, MIN_TTS_SPEED } from "@/lib/tts/voices";
import { cn } from "@/lib/utils";

export type VoiceOverAudio = {
  blob: Blob;
  url: string;
  text: string;
  voiceId: string;
  provider: TtsProviderId;
  language: "en" | "tl";
  speed: number;
  duration: number;
};

type VoiceOverPanelProps = {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  showToggle?: boolean;
  provider: TtsProviderId;
  providerConfigured: boolean;
  providerLoading: boolean;
  providerRefreshing: boolean;
  providerLoadError: string;
  clonedVoiceIds: readonly string[];
  language: "en" | "tl";
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  originalVolume: number;
  onOriginalVolumeChange: (volume: number) => void;
  showOriginalVolume: boolean;
  audio: VoiceOverAudio | null;
  generating: boolean;
  error: string;
  stale: boolean;
  hasMedia: boolean;
  hasText: boolean;
  disabled: boolean;
  onGenerate: () => void;
  onRemove: () => void;
  onDurationChange: (duration: number) => void;
};

export function VoiceOverPanel({
  enabled,
  onEnabledChange,
  showToggle = true,
  provider,
  providerConfigured,
  providerLoading,
  providerRefreshing,
  providerLoadError,
  clonedVoiceIds,
  language,
  voiceId,
  onVoiceChange,
  speed,
  onSpeedChange,
  originalVolume,
  onOriginalVolumeChange,
  showOriginalVolume,
  audio,
  generating,
  error,
  stale,
  hasMedia,
  hasText,
  disabled,
  onGenerate,
  onRemove,
  onDurationChange,
}: VoiceOverPanelProps) {
  const voices = voicesForProvider(provider, clonedVoiceIds);
  const languageSupported = providerSupportsLanguage(provider, language);
  let blockedReason: string | undefined;
  if (providerLoading) {
    blockedReason = "Loading the saved voice-over provider…";
  } else if (providerLoadError) {
    blockedReason = providerLoadError;
  } else if (!providerConfigured) {
    blockedReason = `${ttsProviderLabel(provider)} is not configured. Update the voice-over provider or credentials in Settings.`;
  } else if (!languageSupported) {
    blockedReason = "AssemblyAI supports English voice-over only. Switch the draft to English or choose Azure Speech in Settings for Filipino or Tagalog.";
  }
  const status = generating
    ? "Generating voice-over…"
    : blockedReason
      ? blockedReason
      : error
        ? error
        : stale
          ? "The draft, provider, or voice settings changed. Regenerate the voice-over before publishing."
          : audio
            ? "Voice-over ready."
            : providerRefreshing
              ? "Refreshing the saved voice-over provider…"
              : enabled
                ? "Generate a voice-over from the current draft."
                : "Voice-over is off.";

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors sm:p-4",
        enabled ? "border-primary/30 bg-primary/5" : "bg-muted/20",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {showToggle ? (
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => onEnabledChange(!enabled)}
              disabled={disabled}
              className="flex min-h-11 items-center gap-2 rounded-md text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <AudioLines className="h-4 w-4 text-primary" aria-hidden="true" />
              Voice-over
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  enabled
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {enabled ? "On" : "Off"}
              </span>
            </button>
          ) : (
            <div className="flex min-h-11 items-center gap-2 text-sm font-semibold">
              <AudioLines className="h-4 w-4 text-primary" aria-hidden="true" />
              Voice-over
            </div>
          )}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Narrate the current draft and bake it into your photo or video.
          </p>
        </div>
        {audio && enabled ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={disabled || generating}
            aria-label="Remove voice-over"
            className="h-11 w-11 shrink-0 text-muted-foreground"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {enabled ? (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-muted-foreground">
              Provider: <strong className="font-semibold text-foreground">{ttsProviderLabel(provider)}</strong>
            </p>
            <Link
              href="/settings#text-to-speech"
              className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Change in Settings
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium">
              Voice
              <select
                value={voiceId}
                onChange={(event) => onVoiceChange(event.target.value)}
                disabled={disabled || generating || providerLoading || providerRefreshing || Boolean(providerLoadError) || !providerConfigured || !languageSupported}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.cloned
                      ? `Cloned · ${voice.name}`
                      : `${voice.label} · ${voice.name} (${voice.gender})`}
                  </option>
                ))}
              </select>
            </label>

            {providerSupportsSpeed(provider) ? (
              <label className="space-y-1.5 text-xs font-medium">
                <span className="flex items-center justify-between gap-2">
                  Speaking speed
                  <span className="font-normal text-muted-foreground">
                    {speed.toFixed(2)}×
                  </span>
                </span>
                <input
                  type="range"
                  min={MIN_TTS_SPEED}
                  max={MAX_TTS_SPEED}
                  step={0.05}
                  value={speed}
                  onChange={(event) => onSpeedChange(Number(event.target.value))}
                  disabled={disabled || generating || providerLoading || providerRefreshing || Boolean(providerLoadError) || !providerConfigured}
                  className="mt-4 h-2 w-full cursor-pointer accent-primary disabled:opacity-60"
                />
              </label>
            ) : (
              <div className="space-y-1.5 text-xs font-medium">
                <p>Speaking speed</p>
                <div className="flex h-11 items-center rounded-md border border-input bg-muted/30 px-3 text-sm">
                  Natural (1.00×)
                </div>
                <p className="text-[11px] font-normal leading-relaxed text-muted-foreground">
                  AssemblyAI uses a fixed natural speaking speed.
                </p>
              </div>
            )}
          </div>

          {showOriginalVolume ? (
            <label className="block space-y-1.5 text-xs font-medium">
              <span className="flex items-center justify-between gap-2">
                Original video volume
                <span className="font-normal text-muted-foreground">
                  {Math.round(originalVolume * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={originalVolume}
                onChange={(event) =>
                  onOriginalVolumeChange(Number(event.target.value))
                }
                disabled={disabled}
                className="h-2 w-full cursor-pointer accent-primary"
              />
            </label>
          ) : null}

          {!hasMedia ? (
            <p className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              Add a photo or video to attach the voice-over to a post.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onGenerate}
              disabled={
                disabled ||
                generating ||
                providerLoading ||
                providerRefreshing ||
                Boolean(providerLoadError) ||
                !providerConfigured ||
                !languageSupported ||
                !hasMedia ||
                !hasText
              }
              className="min-h-11"
            >
              {generating ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : audio ? (
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <AudioLines className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {generating
                ? "Generating…"
                : audio
                  ? "Regenerate voice-over"
                  : "Generate voice-over"}
            </Button>
            {audio ? (
              <span className="text-xs text-muted-foreground">
                {audio.duration > 0
                  ? `${audio.duration.toFixed(1)} sec`
                  : "Audio ready"}
              </span>
            ) : null}
          </div>

          {audio ? (
            <audio
              controls
              src={audio.url}
              preload="metadata"
              onLoadedMetadata={(event) => {
                if (Number.isFinite(event.currentTarget.duration)) {
                  onDurationChange(event.currentTarget.duration);
                }
              }}
              className="h-11 w-full"
              aria-label="Voice-over preview"
            />
          ) : null}

          <p
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-start gap-2 text-xs leading-5",
              error || stale
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {error || stale ? (
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            ) : null}
            {status}
          </p>
        </div>
      ) : null}
    </div>
  );
}
