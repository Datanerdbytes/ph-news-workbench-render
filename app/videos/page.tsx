'use client';

import { useEffect, useRef, useState } from 'react';
import { Film, Play, TriangleAlert, Upload, Video } from 'lucide-react';
import { toast } from 'sonner';
import { AssistantChat } from '@/components/assistant-chat';
import { Button } from '@/components/ui/button';
import {
  ComposerCard,
  FieldLabel,
  FilePicker,
  PageSelector,
  PublishPage,
  ResultList,
  ScheduleField,
  defaultScheduleValue,
  inputClass,
  mediaFileError,
  textareaClass,
  useManagedPages,
  type PublishResult,
} from '@/components/publishing/publish-page';
import {
  SCHEDULE_TOO_SOON_ERROR,
  resolveScheduledFor,
} from '@/lib/publishing/schedule';
import {
  SERVER_FLOOR_TRANSIT_MS,
  retryAfterMessage,
  slowUploadMessage,
  useScheduleRetry,
} from '@/components/publishing/schedule-retry-dialog';
import {
  MediaPreviewCard,
  MediaPreviewMedia,
} from '@/components/publishing/media-preview-card';
import { VideoAnimationPicker } from '@/components/videos/video-animation-picker';
import { VideoAnimationOverlay } from '@/components/videos/video-animation-overlay';
import { bakeAndFinalizeVideo } from '@/lib/videos/bake';
import {
  attachmentsFromSlots,
  getVideoPreset,
  presetDefaultValues,
  type PresetSlot,
  type PresetValues,
} from '@/lib/videos/presets';
import type {
  VideoSlotLoops,
  VideoSlotSelection,
} from '@/components/videos/video-animation-picker';

const MAX_BYTES = 1024 * 1024 * 1024;

type VideosPublishResponse = {
  results?: PublishResult[];
  warning?: string;
  error?: string;
  /** The server's earliest acceptable slot, on a too-soon rejection. */
  earliest?: string;
};

export default function VideosPage() {
  const pages = useManagedPages();
  const [file, setFile] = useState<File | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  // Bumped by every file pick/clear so an in-flight publish can tell its clip
  // from whatever the composer holds now.
  const fileGeneration = useRef(0);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targeting, setTargeting] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduleError, setScheduleError] = useState('');
  // The picker stays editable while the bake runs, so the submit-time value is
  // read from a ref instead of the closure that started publish().
  const scheduledForRef = useRef(scheduledFor);
  useEffect(() => {
    scheduledForRef.current = scheduledFor;
  }, [scheduledFor]);
  const scheduleRetry = useScheduleRetry();
  const [busy, setBusy] = useState(false);
  // Read by the assistant's reply handler, which can outlive the render that
  // sent the request.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  // Bumped whenever the composer is replaced or reset, so an assistant reply
  // that outlives its post cannot refill the next one.
  const [composerRevision, setComposerRevision] = useState(0);
  // The last slot the server refused. Cancelling the retry dialog must not
  // let the next attempt upload to the same refused time.
  const refusedSlotRef = useRef<{
    ms: number;
    label: string;
    /** Server-reported floor for the refused slot, if it sent one. */
    earliestMs: number;
    /** Monotonic reading when that floor was received. */
    observedMonoMs: number;
  } | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [results, setResults] = useState<PublishResult[] | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const [animSlots, setAnimSlots] = useState<VideoSlotSelection>({
    start: null,
    middle: null,
    end: null,
  });
  const [animLoops, setAnimLoops] = useState<VideoSlotLoops>({
    start: false,
    middle: false,
    end: false,
  });
  const [animValues, setAnimValues] = useState<Record<string, PresetValues>>({});
  const [bakePct, setBakePct] = useState<number | null>(null);
  const animations = attachmentsFromSlots(animSlots, animLoops);
  const animationLabel = animations
    .map((attachment) => getVideoPreset(attachment.presetId)?.name)
    .filter(Boolean)
    .map((name) => `“${name}”`)
    .join(' + ');

  // Field values are keyed by slot: the same preset can open and close the
  // video with different text. Attaching seeds the slot with preset defaults.
  function selectAnimation(slot: PresetSlot, presetId: string | null) {
    setAnimSlots((current) => ({ ...current, [slot]: presetId }));
    if (!presetId) return;
    setAnimValues((current) => ({
      ...current,
      [slot]: presetDefaultValues(presetId),
    }));
  }

  function setAnimationField(slot: PresetSlot, key: string, text: string) {
    setAnimValues((current) => ({
      ...current,
      [slot]: { ...current[slot], [key]: text },
    }));
  }

  function resetAnimations() {
    setAnimSlots({ start: null, middle: null, end: null });
    setAnimLoops({ start: false, middle: false, end: false });
    setAnimValues({});
  }

  function applyVideoFile(next: File | null) {
    // Every pick or clear invalidates an in-flight publish: it must not retry
    // under a replaced clip, nor clear fields the user has since re-filled.
    fileGeneration.current += 1;
    // A new clip (or the reset after publishing) starts a new composer, so a
    // revision reply still in flight belongs to the old one.
    setComposerRevision((revision) => revision + 1);
    // Settles a retry prompt opened for the replaced clip as cancelled, so
    // the abandoned attempt stops instead of waiting on an answer.
    scheduleRetry.cancel();
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFile(next);
    setFileUrl(next ? URL.createObjectURL(next) : null);
    setPreviewFailed(false);
    resetAnimations();
  }

  const videoPreview = (
    <MediaPreviewCard
      statusLabel={file ? 'Ready to publish' : 'Upload preview'}
      ready={Boolean(file)}
      label="Video"
      footer={
        <>
          {file && (
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold">{file.name}</p>
              <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">
                {(file.size / (1024 * 1024)).toFixed(1)} MB · ready to publish
              </p>
            </div>
          )}
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 p-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted-foreground">
              <Upload className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold">Chunked upload</p>
              <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">
                Title, description &amp; thumbnail · up to 45 minutes · 1 GB.
              </p>
            </div>
          </div>
        </>
      }
    >
      <MediaPreviewMedia className="aspect-video">
        {file && fileUrl && !previewFailed ? (
          <>
            <video
              key={fileUrl}
              ref={previewVideoRef}
              src={fileUrl}
              controls
              playsInline
              preload="metadata"
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-contain"
            />
            <VideoAnimationOverlay
              videoRef={previewVideoRef}
              slots={animSlots}
              loops={animLoops}
              values={animValues}
            />
          </>
        ) : file && previewFailed ? (
          <div className="flex flex-col items-center gap-1.5 px-4 text-center">
            <TriangleAlert className="size-4 text-warning" aria-hidden />
            <p className="text-[10px] font-semibold text-white/75">
              Can’t preview this file
            </p>
            <p className="text-[9.5px] leading-relaxed text-white/60">
              Its format may not play here, but it can still be published as-is.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 text-center text-white/60">
            <span className="grid size-9 place-items-center rounded-full border border-white/25 bg-white/10">
              <Play
                className="ml-0.5 size-3.5 fill-white/70 text-white/70"
                aria-hidden
              />
            </span>
            <p className="text-[9.5px] leading-relaxed">
              The video preview appears here
              <br />
              once you choose an MP4 or MOV.
            </p>
          </div>
        )}
      </MediaPreviewMedia>
    </MediaPreviewCard>
  );

  async function publish() {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error('Videos must be 1 GB or smaller.');
      return;
    }
    if (targeting.trim()) {
      try {
        const parsed = JSON.parse(targeting);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
      } catch {
        toast.error('Audience targeting must be a JSON object.', {
          description: 'Example: {"geo_locations":{"countries":["PH"]}}',
        });
        return;
      }
    }
    let scheduledForIso: string | null = null;
    // The refused slot and the server's reported floor advance with the
    // monotonic clock. The pre-bake check and the post-bake recheck share one
    // projection so a long bake cannot leave a slot below the server's floor.
    const serverFloorNow = () => {
      const refused = refusedSlotRef.current;
      if (!refused) return 0;
      return Math.max(
        refused.ms,
        refused.earliestMs
          ? refused.earliestMs +
              (performance.now() - refused.observedMonoMs)
          : 0
      );
    };
    if (scheduleOn) {
      const schedule = resolveScheduledFor(scheduledFor);
      if (schedule.iso === null) {
        setScheduleError(schedule.error);
        return;
      }
      // A refused slot stays refused: cancelling the retry dialog returns to
      // the composer with that time still selected, so block it here instead
      // of uploading the same video to earn the same 400.
      const refused = refusedSlotRef.current;
      const floorMs = serverFloorNow();
      if (refused && new Date(schedule.iso).getTime() <= floorMs) {
        setScheduleError(retryAfterMessage(refused.label));
        return;
      }
      scheduledForIso = schedule.iso;
      setScheduleError('');
    }

    setBusy(true);
    setResults(null);
    setUploadPct(0);
    const generation = fileGeneration.current;
    try {
      // Bake the attached animations into the footage first — the browser
      // plays the video once, records the composited canvas and the result is
      // finalized to a publishable MP4.
      let uploadFile = file;
      if (animations.length && fileUrl) {
        setBakePct(0);
        try {
          const baked = await bakeAndFinalizeVideo({
            videoUrl: fileUrl,
            attachments: animations,
            values: animValues,
            onProgress: setBakePct,
          });
          // The route enforces the 1 GB cap after this fallback window; throw
          // here so an oversized bake still posts the original clip.
          if (baked.size > MAX_BYTES) {
            throw new Error(
              'The animated video would exceed the 1 GB upload limit.'
            );
          }
          uploadFile = baked;
        } catch (error) {
          toast.warning('Posting without the animation', {
            description:
              error instanceof Error
                ? error.message
                : 'The animation could not be rendered in this browser.',
          });
        } finally {
          setBakePct(null);
        }
      }

      // A replacement picked during the bake makes this upload stale: the
      // fields now describe a different clip, so stop before prompting.
      if (generation !== fileGeneration.current) return;

      // The bake can run for the clip's full length; re-check against the
      // submit-time clock so the slot is still valid when the request lands.
      // On a miss, ask for a new time here — the baked file is reused, so
      // nothing is rendered or uploaded twice.
      if (scheduleOn) {
        const submit = await scheduleRetry.resolveSubmit(
          scheduledForRef.current,
          'video',
          {
            // The bake may have outlasted the slot's clearance of the server
            // floor, so the recheck must see the same advancing floor the
            // pre-bake check used.
            serverEarliestMs: serverFloorNow() || undefined,
            afterMs: refusedSlotRef.current?.ms,
            afterLabel: refusedSlotRef.current?.label,
          }
        );
        if (submit.kind === 'cancelled') return;
        // The dialog can sit open while the clip is replaced; the picked time
        // belongs to the abandoned attempt, so don't write it into the new one.
        if (generation !== fileGeneration.current) return;
        scheduledForIso = submit.iso;
        if (submit.picked) {
          scheduledForRef.current = submit.picked;
          setScheduledFor(submit.picked);
          setScheduleError('');
        }
      }

      const form = new FormData();
      form.append('video', uploadFile, uploadFile.name);
      form.append('title', title);
      form.append('description', description);
      if (thumbnail) form.append('thumbnail', thumbnail);
      if (targeting.trim()) form.append('feedTargeting', targeting.trim());
      form.append('pageIds', JSON.stringify(pages.selected));

      // Real progress for the browser→workbench leg (GB-scale transfers sit
      // on this path for minutes); the chunked server→Facebook leg that
      // follows is the "Publishing…" phase.
      const send = (body: FormData) =>
        new Promise<
          | { response: VideosPublishResponse }
          | { failure: { status: number; error: Error; earliest?: string } }
        >((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/videos');
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              setUploadPct(Math.round((event.loaded / event.total) * 100));
            }
          };
          xhr.onload = () => {
            let response: VideosPublishResponse | null = null;
            try {
              response = JSON.parse(xhr.responseText) as VideosPublishResponse;
            } catch {
              response = null;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve({ response: response ?? {} });
            } else {
              resolve({
                failure: {
                  status: xhr.status,
                  error: new Error(
                    response?.error ?? 'The video could not be published.'
                  ),
                  earliest:
                    typeof response?.earliest === 'string'
                      ? response.earliest
                      : undefined,
                },
              });
            }
          };
          xhr.onerror = () =>
            resolve({
              failure: {
                status: 0,
                error: new Error('The video could not be published.'),
              },
            });
          xhr.send(body);
        });

      // Unlike Reels/Compose this request carries the media itself, and the
      // server validates the slot only after the body arrives. A transfer
      // slower than the prompt's headroom would 400 the fresh time, so a
      // schedule rejection reopens the prompt with the measured upload time
      // added to the seed and resends — the bake and file in memory are
      // reused, only the transfer repeats.
      let data: VideosPublishResponse | null = null;
      let rejected = 0;
      // The picker value behind the slot in flight: a later edit must not
      // relabel the rejection message for a request already sent.
      let sentLabel = scheduledForRef.current;
      while (!data) {
        // Never resend a clip the user has already replaced.
        if (generation !== fileGeneration.current) return;
        if (scheduledForIso) form.set('scheduledFor', scheduledForIso);
        setUploadPct(0);
        const sentIso = scheduledForIso;
        const startedAt = performance.now();
        const result = await send(form);
        if ('response' in result) {
          data = result.response;
          break;
        }
        const { status, error, earliest } = result.failure;
        rejected += 1;
        const tooSoon =
          scheduleOn &&
          status === 400 &&
          error.message === SCHEDULE_TOO_SOON_ERROR;
        // The transfer clock is monotonic; wall-clock jumps must not fake a
        // longer (or shorter) upload than actually happened.
        const uploadMs = performance.now() - startedAt;
        // The server's own floor, kept as an absolute instant so the retry
        // hook can advance it with the monotonic clock while the dialog is
        // open — a browser clock correction must not shrink the lead.
        const serverEarliest = earliest ? new Date(earliest).getTime() : NaN;
        // Remember every matching refusal, even the one that spends the last
        // automatic retry: the composer would otherwise still hold that slot
        // and upload to it again from scratch.
        if (tooSoon && sentIso) {
          refusedSlotRef.current = {
            ms: new Date(sentIso).getTime(),
            label: sentLabel,
            // Pad the received floor: the server sampled its clock before the
            // response travelled back, so treating it as exact would project a
            // floor behind the server's and re-earn the rejection.
            earliestMs: Number.isNaN(serverEarliest)
              ? 0
              : serverEarliest + SERVER_FLOOR_TRANSIT_MS,
            observedMonoMs: performance.now(),
          };
        }
        if (!tooSoon || rejected > 2) {
          throw error;
        }
        // A replacement during the transfer makes this rejection stale: the
        // prompt and any picked time belong to the abandoned clip.
        if (generation !== fileGeneration.current) return;
        const submit = await scheduleRetry.resolveSubmit(
          scheduledForRef.current,
          'video',
          {
            seedAfterMs: uploadMs,
            serverEarliestMs: Number.isNaN(serverEarliest)
              ? undefined
              : serverEarliest,
            // The refused slot itself must not be offered again.
            afterMs: sentIso ? new Date(sentIso).getTime() : undefined,
            afterLabel: sentLabel,
            // The browser clock may still accept what the server refused.
            forcePrompt: true,
            message: slowUploadMessage(sentLabel),
          }
        );
        if (submit.kind === 'cancelled') return;
        if (generation !== fileGeneration.current) return;
        scheduledForIso = submit.iso;
        if (submit.picked) {
          sentLabel = submit.picked;
          scheduledForRef.current = submit.picked;
          setScheduledFor(submit.picked);
          setScheduleError('');
        }
      }
      refusedSlotRef.current = null;
      setResults(data.results ?? []);
      toast.success(scheduleOn ? 'Video scheduled' : 'Video published', {
        description: data.warning,
      });
      if (generation !== fileGeneration.current) return;
      applyVideoFile(null);
      setThumbnail(null);
      setTitle('');
      setDescription('');
      // Don't leak geo-targeting or the schedule toggle into the next video.
      setTargeting('');
      setScheduleOn(false);
      setScheduleError('');
    } catch (error) {
      toast.error('Video upload failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  }

  return (
    <PublishPage eyebrow="Publishing" title="Videos">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="min-w-0">
          <ComposerCard
            icon={<Film className="size-4" />}
            title="New video"
            badge="MP4/MOV · 1 GB max"
          >
            <FilePicker
            id="video-file"
            accept="video/mp4,video/quicktime"
            label="Choose an MP4 or MOV"
            hint="1 GB max"
            file={file}
            onPick={applyVideoFile}
            onClear={() => applyVideoFile(null)}
            icon={<Video className="size-3.5" />}
            validate={(picked) =>
              mediaFileError(picked, {
                types: ['video/mp4', 'video/quicktime'],
                extensions: ['.mp4', '.mov'],
                typeLabel: 'an MP4 or MOV file',
                maxBytes: MAX_BYTES,
                maxLabel: '1 GB',
              })
            }
          />

          {file && (
            <VideoAnimationPicker
              slots={animSlots}
              loops={animLoops}
              values={animValues}
              disabled={busy}
              onSelect={selectAnimation}
              onLoopChange={(slot, loop) =>
                setAnimLoops((current) => ({ ...current, [slot]: loop }))
              }
              onFieldChange={setAnimationField}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="video-title" hint={`${title.length}/200`}>
                Title
              </FieldLabel>
              <input
                id="video-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={busy}
                maxLength={200}
                placeholder="Headline for the video"
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="video-thumbnail" hint="JPEG/PNG/WebP · 20 MB">
                Thumbnail
              </FieldLabel>
              <input
                id="video-thumbnail"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const picked = event.target.files?.[0] ?? null;
                  event.target.value = '';
                  if (picked) {
                    const reason = mediaFileError(picked, {
                      types: ['image/jpeg', 'image/png', 'image/webp'],
                      typeLabel: 'a JPEG, PNG, or WebP image',
                      maxBytes: 20 * 1024 * 1024,
                      maxLabel: '20 MB',
                    });
                    if (reason) {
                      toast.error(reason);
                      return;
                    }
                  }
                  setThumbnail(picked);
                }}
                className="mt-1.5 block w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-foreground"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="video-description" hint={`${description.length}/5000`}>
              Description
            </FieldLabel>
            <textarea
              id="video-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={busy}
              rows={4}
              maxLength={5000}
              placeholder="Describe the video…"
              className={textareaClass}
            />
          </div>

          <div>
            <FieldLabel htmlFor="video-targeting" hint="Optional JSON">
              Audience targeting
            </FieldLabel>
            <textarea
              id="video-targeting"
              value={targeting}
              onChange={(event) => setTargeting(event.target.value)}
              disabled={busy}
              rows={3}
              spellCheck={false}
              placeholder={'{"geo_locations":{"countries":["PH"]}}'}
              className={`${textareaClass} font-mono text-xs`}
            />
          </div>

          <PageSelector
            pages={pages.pages}
            selected={pages.selected}
            onSelect={pages.selectOne}
            loading={pages.loading}
            disabled={busy}
          />

          <ScheduleField
            enabled={scheduleOn}
            onEnabled={setScheduleOn}
            value={scheduledFor}
            onChange={(next) => {
              setScheduledFor(next);
              setScheduleError('');
            }}
            error={scheduleError}
            disabled={busy}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="brand"
              size="sm"
              onClick={publish}
              disabled={!file || busy || !pages.selected.length}
            >
              <Video className="size-3.5" aria-hidden />
              {bakePct != null
                ? `Rendering ${Math.round(bakePct * 100)}%…`
                : busy
                  ? uploadPct != null && uploadPct < 100
                    ? `Uploading ${uploadPct}%…`
                    : 'Publishing…'
                  : scheduleOn
                    ? 'Schedule video'
                    : 'Publish video'}
            </Button>
            {file && (
              <span className="text-[10px] text-muted-foreground">
                {animations.length
                  ? bakePct != null
                    ? `Baking ${animationLabel} into the footage — keep this tab open.`
                    : `${animationLabel} ${animations.length > 1 ? 'are' : 'is'} rendered into the video when you post.`
                  : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
              </span>
            )}
          </div>

            <ResultList results={results ?? []} />
          </ComposerCard>
        </div>
        <aside className="self-start xl:sticky xl:top-[70px]">{videoPreview}</aside>
      </div>
      {scheduleRetry.dialog}
      <AssistantChat
        draft={description}
        disabled={busy}
        revision={composerRevision}
        // A reply that lands mid-attempt must not rewrite the description the
        // retry already captured; a ref avoids the stale closure from the
        // render that sent the request.
        onDraftChange={(text) => {
          if (busyRef.current) return false;
          setDescription(text);
          return true;
        }}
        contextLabel="video description (5,000 character limit)"
      />
    </PublishPage>
  );
}
