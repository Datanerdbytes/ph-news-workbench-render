'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Play, Radio, RefreshCw, Square, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { AssistantChat } from '@/components/assistant-chat';
import {
  PumpControls,
  SourcePreview,
  type PumpStatus,
  type ResolvedSource,
} from '@/components/live/source-preview';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { ErrorState } from '@/components/ui/error-state';
import { cn } from 'cn';
import {
  ComposerCard,
  FieldLabel,
  PublishPage,
  ScheduleField,
  defaultScheduleValue,
  inputClass,
  textareaClass,
} from '@/components/publishing/publish-page';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import {
  MediaPreviewCard,
  MediaPreviewMedia,
} from '@/components/publishing/media-preview-card';

type Stream = {
  id: number;
  facebookVideoId: string;
  title: string;
  description: string;
  status: string;
  streamKey: string | null;
  secureStreamUrl: string | null;
  permalink: string | null;
  plannedStartTime: string | null;
  createdAt: string;
  sourceUrl: string | null;
  sourceMode: 'direct' | 'staged' | null;
  pumpStatus: PumpStatus;
  pumpStartedAt: string | null;
  pumpError: string | null;
};

type Comment = {
  id: string;
  message: string;
  author: string;
  createdTime: string | null;
};

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Could not copy the ${label.toLowerCase()}.`);
  }
}

function toLocalInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A paste that resolves is stored as its resolved playable address; a direct
// media file can feed the pump as pasted. Page links (YouTube, Facebook, …)
// need yt-dlp first — ffmpeg cannot open them, so they are never attached
// without a Preview. Staged resolves (DASH-only sources such as Facebook
// replay VODs) have no playable URL at all, so create keeps the original
// pasted link and flags mode:'staged' — the pump pipes it through yt-dlp.
const DIRECT_SOURCE_PATTERN = /^https?:\/\/\S+\.(mp4|webm)(?:[?#]|$)/i;

export default function LivePage() {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [fresh, setFresh] = useState<Stream | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduleError, setScheduleError] = useState('');

  const [sourceUrl, setSourceUrl] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolvedSource, setResolvedSource] = useState<ResolvedSource | null>(
    null
  );
  const [resolveError, setResolveError] = useState('');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/live${refresh ? '?refresh=1' : ''}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not load live streams.');
      setStreams(data.streams ?? []);
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      toast.error('Live streams unavailable', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!streams.some((stream) => stream.pumpStatus === 'running')) return;

    let stopped = false;
    let inFlight = false;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Read runner state only; Facebook refresh remains a manual action.
        const res = await fetch('/api/live', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (stopped || !res.ok || !Array.isArray(data?.streams)) return;
        const latest = new Map<number, Stream>(
          data.streams.map((stream: Stream) => [stream.id, stream])
        );
        // Keep cards mounted and their editable fields unchanged. Only the
        // pump status/error needs to follow the runner in the background.
        setStreams((current) =>
          current.map((stream) => {
            const updated = latest.get(stream.id);
            return updated
              ? {
                  ...stream,
                  pumpStatus: updated.pumpStatus,
                  pumpStartedAt: updated.pumpStartedAt,
                  pumpError: updated.pumpError,
                }
              : stream;
          })
        );
      } catch {
        // Transient read failures leave the card intact; retry next tick.
      } finally {
        inFlight = false;
      }
    }, 5_000);

    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
    // Restart after a stream update so an older read cannot undo an action.
  }, [streams]);

  async function previewSource() {
    const url = sourceUrl.trim();
    if (!url) return;
    setResolving(true);
    setResolveError('');
    try {
      const res = await fetch('/api/live/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'The video link could not be resolved.');
      }
      setResolvedSource(data);
      // Auto-fill the title, but never clobber one the user already typed.
      if (!title.trim() && data.title) {
        setTitle(String(data.title).slice(0, 200));
      }
    } catch (error) {
      setResolvedSource(null);
      // The resolve API's message is already friendly — show it as-is and
      // keep Preview usable as the retry.
      setResolveError(
        error instanceof Error
          ? error.message
          : 'The video link could not be resolved.'
      );
    } finally {
      setResolving(false);
    }
  }

  async function create() {
    let scheduledForIso: string | null = null;
    if (scheduleOn) {
      const schedule = resolveScheduledFor(scheduledFor);
      if (schedule.iso === null) {
        setScheduleError(schedule.error);
        return;
      }
      scheduledForIso = schedule.iso;
    }
    setScheduleError('');
    setBusy(true);
    try {
      const pastedUrl = sourceUrl.trim();
      // Staged keeps the pasted page link (yt-dlp reads it itself); direct
      // stores the resolved playable file. Unpreviewed direct-file pastes
      // still attach as-is and stay 'direct'.
      const sourceUrlForCreate =
        resolvedSource?.mode === 'staged'
          ? pastedUrl
          : resolvedSource?.playableUrl ??
            (DIRECT_SOURCE_PATTERN.test(pastedUrl) ? pastedUrl : undefined);
      const res = await fetch('/api/live', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          scheduledFor: scheduledForIso,
          sourceUrl: sourceUrlForCreate,
          mode: resolvedSource?.mode ?? 'direct',
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'The live stream could not be created.');
      setFresh(data.stream);
      setTitle('');
      setDescription('');
      setScheduleOn(false);
      setSourceUrl('');
      setResolvedSource(null);
      setResolveError('');
      toast.success('Live stream created', {
        description: 'Copy the server URL and stream key into your encoder.',
      });
      await load();
    } catch (error) {
      toast.error('Live stream creation failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  // The pump API returns the fresh status on every start/stop — patch the
  // card in place so the chip flips without a refetch round-trip.
  const patchPump = useCallback(
    (id: number, pump: { status: PumpStatus; startedAt: string | null }) => {
      setStreams((current) =>
        current.map((stream) => {
          if (stream.id !== id) return stream;
          return {
            ...stream,
            pumpStatus: pump.status,
            pumpStartedAt: pump.startedAt,
            // A fresh start clears the old failure text, matching the row.
            pumpError: pump.status === 'running' ? null : stream.pumpError,
          };
        })
      );
    },
    []
  );

  const hasTitle = Boolean(title.trim());

  const livePreview = (
    <MediaPreviewCard
      statusLabel={hasTitle ? 'Ready to create' : 'Live preview'}
      ready={hasTitle}
      label="Live"
      footer={
        <>
          <p className="min-w-0 truncate font-mono text-[9px] text-muted-foreground">
            Title {title.length}/200 · Description {description.length}/5,000
          </p>
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 p-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted-foreground">
              <Radio className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold">Streaming endpoint</p>
              <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">
                Facebook returns an RTMPS server URL and stream key — paste both
                into OBS or any RTMP encoder.
              </p>
            </div>
          </div>
        </>
      }
    >
      <MediaPreviewMedia className="aspect-video">
        {resolvedSource ? (
          <SourcePreview {...resolvedSource} />
        ) : hasTitle ? (
          <>
            <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] text-white/85">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  scheduleOn ? 'bg-[#f0b429]' : 'bg-destructive animate-pulse'
                )}
                aria-hidden
              />
              {scheduleOn ? 'SCHEDULED' : 'LIVE'}
            </span>
            <div className="min-w-0 px-4 text-center">
              <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-white/90">
                {title}
              </p>
              {description.trim() && (
                <p className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-white/60">
                  {description}
                </p>
              )}
            </div>
            <span className="absolute bottom-2 right-2.5 font-mono text-[8px] text-white/60">
              {scheduleOn && !Number.isNaN(new Date(scheduledFor).getTime())
                ? `Planned ${new Date(scheduledFor).toLocaleString()}`
                : 'Goes live when the encoder connects'}
            </span>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 text-center text-white/60">
            <span className="grid size-9 place-items-center rounded-full border border-white/25 bg-white/10">
              <Radio className="size-3.5" aria-hidden />
            </span>
            <p className="text-[9.5px] leading-relaxed">
              The live preview appears here
              <br />
              once you add a title.
            </p>
          </div>
        )}
      </MediaPreviewMedia>
    </MediaPreviewCard>
  );

  return (
    <PublishPage eyebrow="Publishing" title="Live video">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_480px] xl:items-start">
        <div className="min-w-0 space-y-5">
          <ComposerCard icon={<Radio className="size-4" />} title="Create live stream">
            <div>
              <FieldLabel htmlFor="live-title" hint={`${title.length}/200`}>
                Title
              </FieldLabel>
              <input
                id="live-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="e.g. Afternoon news briefing"
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="live-description" hint={`${description.length}/5000`}>
                Description
              </FieldLabel>
              <textarea
                id="live-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="What is this broadcast about?"
                className={textareaClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="live-source-url" hint="Optional">
                Source URL
              </FieldLabel>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  id="live-source-url"
                  value={sourceUrl}
                  onChange={(event) => {
                    setSourceUrl(event.target.value);
                    setResolveError('');
                    setResolvedSource(null);
                  }}
                  maxLength={2048}
                  placeholder="https://… paste a public video link to restream"
                  className={inputClass}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void previewSource()}
                  disabled={resolving || !sourceUrl.trim()}
                >
                  <Play className="size-3.5" aria-hidden />
                  {resolving ? 'Resolving…' : resolveError ? 'Retry preview' : 'Preview'}
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Only stream content you own or have licensed.
              </p>
              {resolveError && (
                <p role="alert" className="mt-1 text-[11px] text-destructive">
                  {resolveError}
                </p>
              )}
            </div>
            <ScheduleField
              enabled={scheduleOn}
              onEnabled={setScheduleOn}
              value={scheduledFor}
              onChange={(value) => {
                setScheduledFor(value);
                setScheduleError('');
              }}
              error={scheduleError}
            />
            <Button
              variant="brand"
              size="sm"
              onClick={create}
              disabled={!title.trim() || busy}
            >
              <Radio className="size-3.5" aria-hidden />
              {busy ? 'Creating…' : scheduleOn ? 'Schedule stream' : 'Create stream'}
            </Button>

            {fresh && (
              <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
                <p className="text-xs font-semibold">{fresh.title}</p>
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">Server</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono">
                      {fresh.secureStreamUrl ?? '—'}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        fresh.secureStreamUrl &&
                        void copy(fresh.secureStreamUrl, 'Server URL')
                      }
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Copy server URL"
                    >
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-muted-foreground">Key</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono">
                      {fresh.streamKey ?? 'Read from Facebook — see the stream below'}
                    </code>
                    <button
                      type="button"
                      onClick={() => fresh.streamKey && void copy(fresh.streamKey, 'Stream key')}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Copy stream key"
                    >
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </ComposerCard>

          <ComposerCard
            icon={<Radio className="size-4" />}
            title="Live streams"
            headerRight={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void load(true)}
                disabled={loading}
              >
                <RefreshCw
                  className={cn('size-3.5', loading && 'animate-spin')}
                  aria-hidden
                />
                Refresh from Facebook
              </Button>
            }
          >
            <div className="divide-y divide-border/60">
              {loading && !streams.length && (
                <p className="py-6 text-xs text-muted-foreground">
                  Loading live streams…
                </p>
              )}
              {!loading && !streams.length && loadError && (
                <ErrorState
                  compact
                  title="Couldn't load live streams"
                  onRetry={() => load()}
                />
              )}
              {!loading && !streams.length && !loadError && (
                <p className="py-6 text-xs text-muted-foreground">
                  No live streams yet. Create one above to get an RTMPS server and key.
                </p>
              )}
              {streams.map((stream) => (
                <StreamCard
                  key={stream.id}
                  stream={stream}
                  onChanged={() => void load()}
                  onPumpChanged={patchPump}
                />
              ))}
            </div>
          </ComposerCard>
        </div>
        <aside className="self-start xl:sticky xl:top-[70px]">{livePreview}</aside>
      </div>
      <AssistantChat
        draft={description}
        onDraftChange={setDescription}
        contextLabel="live stream description (5,000 character limit)"
      />
    </PublishPage>
  );
}

function StreamCard({
  stream,
  onChanged,
  onPumpChanged,
}: {
  stream: Stream;
  onChanged: () => void;
  onPumpChanged: (
    id: number,
    pump: { status: PumpStatus; startedAt: string | null }
  ) => void;
}) {
  const [title, setTitle] = useState(stream.title);
  const [description, setDescription] = useState(stream.description);
  const [planned, setPlanned] = useState(toLocalInput(stream.plannedStartTime));
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentsStopped, setCommentsStopped] = useState(false);

  const ended = stream.status === 'ENDED' || stream.status === 'VOD';
  const commentsOpen = comments !== null;

  useEffect(() => {
    setTitle(stream.title);
    setDescription(stream.description);
    setPlanned(toLocalInput(stream.plannedStartTime));
  }, [stream.title, stream.description, stream.plannedStartTime]);

  // While the stream is live and the panel is open, refresh comments every
  // 10s. Stop after 3 consecutive failures (one toast) instead of silently
  // erroring forever.
  useEffect(() => {
    if (ended || !commentsOpen || commentsStopped) return;
    let stopped = false;
    let failures = 0;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/live/${stream.id}/comments`, {
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error ?? 'Could not refresh comments.');
        }
        if (stopped) return;
        failures = 0;
        setComments(data.comments ?? []);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        if (failures >= 3) {
          setCommentsStopped(true);
          toast.error('Live comments stopped refreshing', {
            description:
              error instanceof Error ? error.message : 'Please try again.',
          });
        }
      }
    }, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ended, commentsOpen, commentsStopped, stream.id]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/live/${stream.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          scheduledFor: planned ? new Date(planned).toISOString() : null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'The stream could not be updated.');
      toast.success('Live stream updated');
      onChanged();
    } catch (error) {
      toast.error('Update failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    try {
      const res = await fetch(`/api/live/${stream.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'The stream could not be ended.');
      toast.success('Live stream ended');
      onChanged();
    } catch (error) {
      toast.error('Could not end the stream', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function loadComments() {
    setCommentsBusy(true);
    setCommentsStopped(false);
    try {
      const res = await fetch(`/api/live/${stream.id}/comments`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not load comments.');
      setComments(data.comments ?? []);
    } catch (error) {
      toast.error('Comments unavailable', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setCommentsBusy(false);
    }
  }

  async function setPump(action: 'start' | 'stop') {
    try {
      const res = await fetch(`/api/live/${stream.id}/pump`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'The live pump could not be updated.');
      }
      onPumpChanged(stream.id, data.pump);
      toast.success(action === 'start' ? 'Going live' : 'Pump stopped', {
        description:
          action === 'start'
            ? 'The source is being copied into the Facebook broadcast.'
            : 'The Facebook broadcast stays open until you end the stream.',
      });
    } catch (error) {
      toast.error(
        action === 'start' ? 'Could not go live' : 'Could not stop the pump',
        {
          description: error instanceof Error ? error.message : undefined,
        }
      );
      // Start failures leave pump_status/pump_error on the row — resync the
      // card so the chip tells the same story as the server.
      onChanged();
    }
  }

  return (
    <div className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              ended
                ? 'bg-surface-3 text-muted-foreground'
                : 'bg-destructive/10 text-destructive'
            )}
          >
            {stream.status}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {stream.plannedStartTime
              ? `Planned ${new Date(stream.plannedStartTime).toLocaleString()}`
              : `Created ${new Date(stream.createdAt).toLocaleString()}`}
          </span>
          {stream.permalink && (
            <a
              href={stream.permalink}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-semibold text-brand underline-offset-2 hover:underline"
            >
              Open on Facebook
            </a>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            aria-label="Stream title"
            className={inputClass}
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={5000}
            placeholder="Description"
            aria-label="Stream description"
            className={inputClass}
          />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Planned start
          <input
            type="datetime-local"
            value={planned}
            onChange={(event) => setPlanned(event.target.value)}
            disabled={ended}
            aria-label="Planned start time"
            className={cn(inputClass, 'h-8 w-auto text-xs')}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={save}
            disabled={busy || ended || !title.trim()}
          >
            Save details
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={loadComments}
            disabled={commentsBusy}
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {commentsBusy ? 'Loading…' : 'Live comments'}
          </Button>
          <ConfirmButton
            size="sm"
            variant="destructive"
            onConfirm={end}
            disabled={busy || ended}
            confirmLabel="Confirm end"
            busyLabel="Ending…"
            cancelLabel="Keep streaming"
            icon={<Square className="size-3.5" aria-hidden />}
          >
            End stream
          </ConfirmButton>
        </div>
        {!ended && (
          <PumpControls
            pumpStatus={stream.pumpStatus}
            pumpError={stream.pumpError}
            disabled={!stream.sourceUrl}
            onStart={() => void setPump('start')}
            onStop={() => void setPump('stop')}
          />
        )}
        {comments && (
          <div
            aria-live="polite"
            className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-background/60 p-2"
          >
            {comments.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No comments yet.</p>
            ) : (
              comments.map((comment) => (
                <div key={comment.id} className="text-[11px]">
                  <span className="font-semibold">{comment.author}</span>{' '}
                  <span className="text-muted-foreground">{comment.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5 rounded-lg border border-border bg-surface-2 p-2.5 text-[11px]">
        <p className="font-semibold">Encoder settings</p>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono">
            {stream.secureStreamUrl ?? '—'}
          </code>
          <button
            type="button"
            onClick={() =>
              stream.secureStreamUrl &&
              void copy(stream.secureStreamUrl, 'Server URL')
            }
            className="tap-target rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Copy server URL"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono">
            {stream.streamKey ?? 'No stored key'}
          </code>
          <button
            type="button"
            onClick={() => stream.streamKey && void copy(stream.streamKey, 'Stream key')}
            className="tap-target rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Copy stream key"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
