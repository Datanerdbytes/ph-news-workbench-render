'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isHlsUrl, proxyUrl } from '@/lib/live/preview-proxy';
import { cn } from 'cn';

/** The 200-shape of POST /api/live/resolve. `staged` means the pump can pipe
 * the source even though nothing here is playable in a browser: playableUrl
 * is null and Go live hands the original link to yt-dlp. */
export type ResolvedSource = {
  playableUrl: string | null;
  mode: 'direct' | 'staged';
  title: string;
  isLive: boolean;
  extractor: string;
};

/** The pump chip states GET /api/live reports for a stream row. */
export type PumpStatus = 'idle' | 'running' | 'stopped' | 'failed' | 'interrupted';

// Direct media files play through <video src> in every browser; only
// manifests (m3u8 and friends) need the native-HLS check or hls.js.
const DIRECT_FILE_PATTERN = /\.(mp4|webm)(?:[?#]|$)/i;
const PLAYER_LOAD_TIMEOUT_MS = 45_000;

/**
 * Inline preview of a resolved source. The page owns all fetching — this
 * component only plays `playableUrl`: direct files play cross-origin via
 * `<video src>` (no CORS needed for media elements), while HLS manifests
 * load same-origin through the preview proxy — both for native HLS (Safari)
 * and for hls.js, which is imported lazily exactly when a browser needs it.
 * The proxy matters because upstream HLS (googlevideo manifests and
 * segments) sends no `Access-Control-Allow-Origin`, so without it hls.js
 * fetches are blocked in Chrome/Firefox. A `staged` source has no playable
 * URL at all (the pump pipes it through yt-dlp), so it renders a calm
 * "preview unavailable" card instead of a player — that is a normal state,
 * not an error.
 */
export function SourcePreview({
  playableUrl,
  mode,
  title,
  isLive,
  extractor,
}: ResolvedSource) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playableUrl) return;
    // HLS must load same-origin (no CORS headers upstream), so manifests go
    // through the preview proxy; direct files keep their original URL. The
    // local const keeps the narrowed non-null type in the closures below.
    const isHls = isHlsUrl(playableUrl);
    const source: string = isHls ? proxyUrl(playableUrl) : playableUrl;
    const media: HTMLVideoElement = video;

    setPlayerError(null);
    let cancelled = false;
    let hls: { destroy(): void } | null = null;
    let failed = false;
    let hasMedia = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clearDeadline() {
      clearTimeout(timer);
      timer = undefined;
    }

    function onMediaReady() {
      hasMedia = true;
      clearDeadline();
    }

    function onPause() {
      // Pausing a stalled stream is intentional, but the initially paused
      // video must still report sources that never deliver their first frame.
      if (hasMedia) clearDeadline();
    }

    function fail(message: string) {
      if (cancelled || failed) return;
      failed = true;
      clearDeadline();
      hls?.destroy();
      hls = null;
      // Reset native playback as well: an error message alone leaves the
      // browser's loading spinner (and sometimes a pending request) alive.
      media.removeAttribute('src');
      media.load();
      setPlayerError(message);
    }

    function startDeadline() {
      if (
        cancelled || failed || timer !== undefined ||
        (hasMedia && (media.paused || media.readyState >= media.HAVE_FUTURE_DATA))
      ) return;
      timer = setTimeout(() => {
        fail('The stream took too long to load. Preview the link again to retry.');
      }, PLAYER_LOAD_TIMEOUT_MS);
    }

    function onMediaError() {
      fail('The stream could not be played. Preview the link again to retry.');
    }

    media.addEventListener('loadeddata', onMediaReady);
    media.addEventListener('canplay', onMediaReady);
    media.addEventListener('playing', onMediaReady);
    media.addEventListener('pause', onPause);
    media.addEventListener('play', startDeadline);
    media.addEventListener('waiting', startDeadline);
    media.addEventListener('stalled', startDeadline);
    media.addEventListener('error', onMediaError);
    startDeadline();

    async function playManifest() {
      try {
        const { default: Hls } = await import('hls.js');
        if (cancelled || failed) return;
        if (!Hls.isSupported()) {
          fail('This browser cannot play this stream.');
          return;
        }
        const instance = new Hls();
        hls = instance;
        // hls.js retries non-fatal errors on its own; a fatal one (dead
        // manifest, network drop) means the preview is over — tear the
        // player down and say so instead of crashing.
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          fail(
            'The stream stopped playing. Preview the link again to retry.'
          );
        });
        instance.loadSource(source);
        instance.attachMedia(media);
      } catch {
        fail('The preview player could not be loaded.');
      }
    }

    // Direct files play natively via <video src>. HLS manifests always go
    // through hls.js — Chrome's canPlayType('application/vnd.apple.mpegurl')
    // can return "maybe" and bypass hls.js, but native HLS support is
    // inconsistent across versions and browsers.
    if (
      DIRECT_FILE_PATTERN.test(source) ||
      (!isHls && video.canPlayType('application/vnd.apple.mpegurl'))
    ) {
      video.src = source;
    } else {
      void playManifest();
    }

    return () => {
      cancelled = true;
      clearDeadline();
      media.removeEventListener('loadeddata', onMediaReady);
      media.removeEventListener('canplay', onMediaReady);
      media.removeEventListener('playing', onMediaReady);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('play', startDeadline);
      media.removeEventListener('waiting', startDeadline);
      media.removeEventListener('stalled', startDeadline);
      media.removeEventListener('error', onMediaError);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
    };
  }, [playableUrl]);

  const staged = mode === 'staged';

  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-2">
        {/* Source titles can be long YouTube strings with dates and emoji —
            wrap to two lines instead of clipping to an unreadable single
            line; the chips shrink-0 so the title always yields the space. */}
        <p className="min-w-0 flex-1 line-clamp-2 text-xs font-semibold leading-snug">
          {title || 'Resolved source'}
        </p>
        {isLive && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] text-destructive">
            <span
              className="size-1.5 animate-pulse rounded-full bg-destructive"
              aria-hidden
            />
            LIVE
          </span>
        )}
        {extractor && (
          <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
            {extractor}
          </span>
        )}
      </div>
      {staged ? (
        // Same footprint as the player above so the card keeps its shape,
        // but muted text and no player chrome: nothing is broken here.
        // bg-black keeps the black media-box look the page's placeholder
        // states get from MediaPreviewMedia.
        <div className="flex aspect-video items-center justify-center bg-black px-6 text-center">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Preview unavailable for this source — Go live streams it through
            the pump.
          </p>
        </div>
      ) : (
        <>
          {/* muted + playsInline keep an autoplaying live preview allowed in
              every browser; controls leave the user in charge of playback. */}
          <video
            ref={videoRef}
            muted
            playsInline
            controls
            className="aspect-video w-full bg-black"
          />
          {playerError && (
            <p
              role="alert"
              className="border-t border-border/60 px-2.5 py-2 text-[11px] text-destructive"
            >
              {playerError}
            </p>
          )}
        </>
      )}
    </figure>
  );
}

// Chip palette per pump status — mirrors the status chips on the stream
// cards (running green, failed destructive, interrupted amber like the
// scheduled dot on the live preview).
const PUMP_CHIP: Record<
  PumpStatus,
  { label: string; dot: string; chip: string }
> = {
  idle: {
    label: 'Idle',
    dot: 'bg-muted-foreground/50',
    chip: 'bg-surface-3 text-muted-foreground',
  },
  running: {
    label: 'Running',
    dot: 'bg-success',
    chip: 'bg-success/10 text-success',
  },
  stopped: {
    label: 'Stopped',
    dot: 'bg-muted-foreground/50',
    chip: 'bg-surface-3 text-muted-foreground',
  },
  interrupted: {
    label: 'Interrupted',
    dot: 'bg-[#f0b429]',
    chip: 'bg-[#f0b429]/15 text-foreground',
  },
  failed: {
    label: 'Failed',
    dot: 'bg-destructive',
    chip: 'bg-destructive/10 text-destructive',
  },
};

/**
 * Pump status chip + action for one stream card. `disabled` marks a card
 * without a resolved source: its Go live button locks and the hint explains
 * why. Running pumps always show Stop; an interrupted pump (DB said running,
 * process gone) offers one-click restart on the chip and the action button.
 */
export function PumpControls({
  pumpStatus,
  pumpError,
  disabled = false,
  onStart,
  onStop,
}: {
  pumpStatus: PumpStatus;
  pumpError?: string | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const chip = PUMP_CHIP[pumpStatus];
  const running = pumpStatus === 'running';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
            chip.chip
          )}
        >
          <span className={cn('size-1.5 rounded-full', chip.dot)} aria-hidden />
          {chip.label}
          {pumpStatus === 'interrupted' && (
            <button
              type="button"
              onClick={onStart}
              className="underline underline-offset-2 transition-opacity hover:opacity-80"
            >
              Restart
            </button>
          )}
        </span>
        <Button
          size="sm"
          variant={running ? 'outline' : 'brand'}
          onClick={running ? onStop : onStart}
          disabled={!running && pumpStatus !== 'interrupted' && disabled}
        >
          {running ? (
            <>
              <Square className="size-3.5" aria-hidden />
              Stop
            </>
          ) : pumpStatus === 'interrupted' ? (
            <>
              <RotateCcw className="size-3.5" aria-hidden />
              Restart
            </>
          ) : (
            <>
              <Play className="size-3.5" aria-hidden />
              Go live
            </>
          )}
        </Button>
      </div>
      {pumpStatus === 'failed' && pumpError && (
        <p role="alert" className="text-[11px] text-destructive">
          {pumpError}
        </p>
      )}
      {disabled && (
        <p className="text-[10px] text-muted-foreground">
          Resolve and preview a source URL for this stream to go live.
        </p>
      )}
    </div>
  );
}
