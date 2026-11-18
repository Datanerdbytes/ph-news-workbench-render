'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Video } from 'lucide-react';
import { toast } from 'sonner';
import { stageUpload } from '@/lib/stage-client';
import { deleteStagedBlob } from '@/lib/blob-cleanup';
import { AnimationPicker } from '@/components/reels/animation-picker';
import { FinalReelPreview } from '@/components/publishing/final-reel-preview';
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
  mediaFileError,
  textareaClass,
  useManagedPages,
  type PublishResult,
} from '@/components/publishing/publish-page';
import { useScheduleRetry } from '@/components/publishing/schedule-retry-dialog';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import { bakeReelAnimation } from '@/lib/reels/bake';
import {
  finalizeBakedVideo,
  normalizeVideo,
} from '@/lib/reels/browser-normalize';
import { fetchDownloadedVideo, parseVideoParam } from '@/lib/reels/import-download';
import {
  attachmentsFromSlots,
  defaultPresetValues,
  getPreset,
  type PresetValues,
} from '@/lib/reels/presets';
import type { SlotLoops, SlotSelection } from '@/components/reels/animation-picker';

const MAX_BYTES = 1024 * 1024 * 1024;

/** Connection-guard responses that return before the request body is read. */
const PRE_BODY_REJECTION_CODES = new Set([
  'not_connected',
  'scope_missing',
  'connection_failed',
]);

export default function ReelsPage() {
  const pages = useManagedPages();
  const [file, setFile] = useState<File | null>(null);
  const [normalizing, setNormalizing] = useState(false);
  const [caption, setCaption] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduleError, setScheduleError] = useState('');
  // The picker stays editable while the bake runs, so the submit-time value is
  // read from a ref instead of the closure that started post().
  const scheduledForRef = useRef(scheduledFor);
  useEffect(() => {
    scheduledForRef.current = scheduledFor;
  }, [scheduledFor]);
  const scheduleRetry = useScheduleRetry();
  // Stable across renders, so handlePick can cancel an obsolete prompt without
  // re-triggering the Downloads handover effect that depends on it.
  const cancelRetry = scheduleRetry.cancel;
  const [busy, setBusy] = useState(false);
  // Read by the assistant's reply handler, which can outlive the render that
  // sent the request.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  // Bumped when the reel is replaced or the composer resets after publishing,
  // so an assistant reply for the old clip cannot refill the new caption.
  const [composerRevision, setComposerRevision] = useState(0);
  const [results, setResults] = useState<PublishResult[] | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // Each pick/clear bumps this; an in-flight normalization whose generation
  // is stale must not touch state (previously a cleared file "resurrected"
  // when its async normalize completed).
  const pickGeneration = useRef(0);

  const [slots, setSlots] = useState<SlotSelection>({
    start: null,
    middle: null,
    end: null,
  });
  const [loops, setLoops] = useState<SlotLoops>({
    start: false,
    middle: false,
    end: false,
  });
  const [presetValues, setPresetValues] = useState<Record<string, PresetValues>>(
    () => defaultPresetValues()
  );
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [normalizePct, setNormalizePct] = useState<number | null>(null);
  // Attachments in overlay draw order (start → middle → end).
  const attachments = attachmentsFromSlots(slots, loops);
  const attachmentPresets = attachments
    .map((attachment) => getPreset(attachment.presetId))
    .filter((preset) => preset !== null);
  const attachmentLabel = attachmentPresets
    .map((preset) => `“${preset.name}”`)
    .join(' + ');

  /**
   * Picked videos are normalized to H.264 1080×1920 before anything else:
   * Safari cannot preview AV1/HEVC downloads, and Facebook prefers standard
   * encodings. Server-side when available, otherwise in-browser (ffmpeg.wasm)
   * for clips the browser cannot play; playable originals pass through as-is.
   */
  const handlePick = useCallback(async (picked: File | null) => {
    // Reject wrong-type/oversized picks before touching state, so an invalid
    // pick never interrupts an in-flight normalization of the current file.
    if (picked) {
      const reason = mediaFileError(picked, {
        types: ['video/mp4', 'video/quicktime'],
        extensions: ['.mp4', '.mov'],
        typeLabel: 'an MP4 or MOV file',
        maxBytes: MAX_BYTES,
        maxLabel: '1 GB',
      });
      if (reason) {
        toast.error(reason);
        return;
      }
    }
    const generation = ++pickGeneration.current;
    // A reply in flight belongs to the previous clip's composer.
    setComposerRevision((revision) => revision + 1);
    // A retry prompt opened for the previous reel is obsolete now: settle it
    // as cancelled so that attempt releases its staged upload and stops.
    cancelRetry();
    setFile(picked);
    if (!picked) return;
    setNormalizing(true);
    setNormalizePct(null);
    try {
      const {
        file: normalized,
        normalized: didNormalize,
        error,
      } = await normalizeVideo(picked, picked.name, setNormalizePct);
      if (generation !== pickGeneration.current) return;
      setFile(normalized);
      if (error) throw new Error(error);
      if (didNormalize) {
        toast.success('Video normalized', {
          description: 'Converted to H.264 1080×1920 — previews everywhere and uploads cleanly.',
        });
      }
    } catch (error) {
      if (generation !== pickGeneration.current) return;
      toast.warning('Using the original video', {
        description:
          error instanceof Error ? error.message : 'Normalization failed.',
      });
    } finally {
      if (generation === pickGeneration.current) {
        setNormalizing(false);
        setNormalizePct(null);
      }
    }
  }, []);

  function clearFile() {
    // Invalidates any in-flight normalization so the cleared file can't
    // come back when the async work settles.
    pickGeneration.current += 1;
    setComposerRevision((revision) => revision + 1);
    cancelRetry();
    setFile(null);
    setNormalizing(false);
    setNormalizePct(null);
  }

  // A download handed over from the Downloads page arrives as ?video=<jobId>.
  useEffect(() => {
    const jobId = parseVideoParam(window.location.search);
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { file: downloaded } = await fetchDownloadedVideo(jobId);
        if (!cancelled) await handlePick(downloaded);
      } catch (error) {
        if (cancelled) return;
        toast.error('Could not open the download', {
          description:
            error instanceof Error ? error.message : 'The download is unavailable.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cancelRetry]);
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function post() {
    if (!file || normalizing) return;
    if (file.size > MAX_BYTES) {
      toast.error('Reels must be 1 GB or smaller.');
      return;
    }
    let scheduledForIso: string | null = null;
    if (scheduleOn) {
      const schedule = resolveScheduledFor(scheduledFor);
      if (schedule.iso === null) {
        setScheduleError(schedule.error);
        return;
      }
      scheduledForIso = schedule.iso;
      setScheduleError('');
    }
    setBusy(true);
    setResults(null);
    setRenderPct(null);
    // The picker stays live during the bake and upload; a replacement must
    // abandon this attempt instead of posting the old clip and then clearing
    // the new one from the editor.
    const generation = pickGeneration.current;
    try {
      let uploadFile = file;
      // Bake the attached animations into the footage first: record the video
      // + slot overlays in the browser, then make the result publishable MP4.
      if (attachments.length && fileUrl) {
        const baked = await bakeReelAnimation({
          videoUrl: fileUrl,
          attachments,
          values: presetValues,
          onProgress: setRenderPct,
        }).catch((error: unknown) => {
          toast.warning('Posting without the animation', {
            description:
              error instanceof Error
                ? error.message
                : 'The animation could not be rendered in this browser.',
          });
          return null;
        });
        // A replacement during the recording makes this bake stale: do not
        // spend the finalization on a clip nobody will stage. The check after
        // finalization still covers replacements that land while it runs.
        if (generation !== pickGeneration.current) {
          setRenderPct(null);
          return;
        }
        if (baked) {
          // MediaRecorder emits fragmented MP4 (Chrome et al.) or WebM
          // (fallback). Facebook needs a progressive H.264 MP4, and the old
          // path through /api/reels/prepare 503s on Vercel — which silently
          // dropped the bake and posted the reel without its animation.
          // Finalize fully in the browser instead: MP4 remuxes losslessly
          // (seconds), WebM transcodes (slower).
          try {
            uploadFile = await finalizeBakedVideo(baked, setRenderPct);
          } catch (error) {
            toast.warning('Posting without the animation', {
              description:
                error instanceof Error
                  ? error.message
                  : 'The baked reel could not be finalized.',
            });
          }
        }
      }
      setRenderPct(null);
      if (generation !== pickGeneration.current) return;
      // The bake records the clip in real time, so the slot can lapse before
      // the GB-scale staging upload even starts. Check here so a stale slot
      // costs nothing; the check after staging still guards the upload window.
      if (scheduleOn) {
        const submit = await scheduleRetry.resolveSubmit(
          scheduledForRef.current,
          'reel'
        );
        if (submit.kind === 'cancelled') return;
        // A Downloads import can replace the reel while the prompt is open;
        // its picked time must not land in the new reel's composer.
        if (generation !== pickGeneration.current) return;
        scheduledForIso = submit.iso;
        if (submit.picked) {
          // Mirror into the ref too: the post-staging check below runs before
          // the state effect can sync it and must not re-prompt for the slot
          // the user just confirmed.
          scheduledForRef.current = submit.picked;
          setScheduledFor(submit.picked);
          setScheduleError('');
        }
      }
      // Stage the video straight to Blob from the browser — sidesteps the
      // serverless request-body limit so full-size reels post from production.
      // The server downloads it back and feeds the Facebook upload.
      const staged = await stageUpload(
        `reels/${Date.now()}-${uploadFile.name.replace(/[^\w.-]+/g, '_')}`,
        uploadFile,
        {
          contentType: uploadFile.type || 'video/mp4',
          onUploadProgress: (progress) => setUploadPct(progress.percentage),
        }
      );
      setUploadPct(null);
      // A replacement during the upload keeps its own draft: drop this
      // attempt's staged blob instead of prompting for a time and posting it.
      if (generation !== pickGeneration.current) {
        deleteStagedBlob(staged.url);
        return;
      }
      // The upload can take minutes, so the slot checked above can still fall
      // inside Facebook's 10-minute window by the time the reel is staged.
      // Re-check against the submit-time clock; on a miss, ask for a new time
      // right here so the staged reel is reused instead of baked and uploaded
      // again. Cancelling means no request will consume the staged blob, so
      // remove it rather than orphaning it in the store.
      if (scheduleOn) {
        const submit = await scheduleRetry.resolveSubmit(
          scheduledForRef.current,
          'reel'
        );
        if (submit.kind === 'cancelled') {
          deleteStagedBlob(staged.url);
          return;
        }
        // The prompt can outlive a replacement: the staged reel is abandoned,
        // so release it and never post it under the new caption or slot.
        if (generation !== pickGeneration.current) {
          deleteStagedBlob(staged.url);
          return;
        }
        scheduledForIso = submit.iso;
        if (submit.picked) {
          setScheduledFor(submit.picked);
          setScheduleError('');
        }
      }
      const res = await fetch('/api/reels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoUrl: staged.url,
          filename: uploadFile.name,
          videoType: uploadFile.type || 'video/mp4',
          caption,
          pageIds: pages.selected,
          ...(scheduledForIso
            ? { scheduledFor: scheduledForIso }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A pre-body rejection never consumed the staged copy. That includes
        // 400s (the route's own validation), 401 (no session), and the
        // connection guard's not_connected/scope_missing/connection_failed
        // responses, which all return before the body is read. Any other
        // status may have started publishing — or is an ambiguous network
        // failure — so that blob is left to the scheduler.
        if (
          res.status === 400 ||
          res.status === 401 ||
          PRE_BODY_REJECTION_CODES.has(data?.code)
        ) {
          deleteStagedBlob(staged.url);
        }
        throw new Error(data?.error ?? 'The reel could not be posted.');
      }
      setResults(data.results ?? []);
      toast.success(
        scheduleOn ? 'Reel scheduled' : 'Reel published',
        { description: data.warning }
      );
      // Only clear the composer if it still holds the reel that was posted.
      if (generation === pickGeneration.current) {
        setFile(null);
        setCaption('');
        setScheduleOn(false);
        setComposerRevision((revision) => revision + 1);
      }
    } catch (error) {
      toast.error('Reel upload failed', {
        description:
          error instanceof Error ? error.message : 'The reel could not be posted.',
      });
    } finally {
      setBusy(false);
      setRenderPct(null);
      setUploadPct(null);
      window.setTimeout(
        () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        50
      );
    }
  }

  return (
    <PublishPage eyebrow="Publishing" title="Reels">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
      <ComposerCard
        icon={<Video className="size-4" />}
        title="New reel"
        badge="3s–45min · 1 GB max"
      >
        <FilePicker
          id="reel-video"
          accept="video/mp4,video/quicktime"
          label="Choose an MP4 or MOV"
          hint="3s–45min"
          file={file}
          onPick={handlePick}
          onClear={clearFile}
          icon={<Video className="size-3.5" />}
        />
        {normalizing && (
          <p className="text-[10.5px] text-muted-foreground">
            {normalizePct != null
              ? `Converting to H.264 in your browser… ${Math.round(normalizePct * 100)}%`
              : 'Normalizing the video to H.264 1080×1920… (a few seconds)'}
          </p>
        )}

        <AnimationPicker
          slots={slots}
          loops={loops}
          values={presetValues}
          onSelect={(slot, id) =>
            setSlots((current) => ({ ...current, [slot]: id }))
          }
          onLoopChange={(slot, loop) =>
            setLoops((current) => ({ ...current, [slot]: loop }))
          }
          onFieldChange={(id, key, text) =>
            setPresetValues((current) => ({
              ...current,
              [id]: { ...current[id], [key]: text },
            }))
          }
        />

        <div>
          <FieldLabel htmlFor="reel-caption" hint={`${caption.length}/2200`}>
            Caption
          </FieldLabel>
          <textarea
            id="reel-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            disabled={busy}
            rows={4}
            maxLength={2200}
            placeholder="Write a caption for the reel…"
            className={textareaClass}
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
            onClick={post}
            disabled={
              !file || normalizing || busy || !pages.selected.length
            }
          >
            <Video className="size-3.5" aria-hidden />
            {uploadPct != null
              ? `Staging ${Math.round(uploadPct)}%…`
              : renderPct != null
                ? `Rendering ${Math.round(renderPct * 100)}%…`
                : normalizing
                  ? 'Normalizing…'
                  : busy
                    ? 'Publishing…'
                    : scheduleOn
                      ? 'Schedule reel'
                      : 'Publish reel'}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {uploadPct != null
              ? 'Uploading the video to storage — do not close this tab.'
              : renderPct != null
              ? `Baking ${attachmentLabel} into the footage — keep this tab open.`
              : attachments.length
                ? `${attachmentLabel} ${attachments.length > 1 ? 'are' : 'is'} rendered into the reel when you post.`
                : scheduleOn
                  ? 'Facebook queues the reel and publishes it at the chosen time.'
                  : 'Publishes straight to the selected Page(s).'}
          </span>
        </div>

        <div ref={resultsRef}>
          <ResultList results={results ?? []} />
        </div>
      </ComposerCard>
        </div>

        <div className="self-start xl:sticky xl:top-[70px]">
          <FinalReelPreview
            videoUrl={fileUrl}
            caption={caption}
            pageName={
              pages.pages.find((page) => page.id === pages.selected[0])?.name
            }
            pagePicture={
              pages.pages.find((page) => page.id === pages.selected[0])?.picture
            }
            slots={slots}
            loops={loops}
            values={presetValues}
          />
        </div>
      </div>
      {scheduleRetry.dialog}
      <AssistantChat
        draft={caption}
        disabled={busy}
        revision={composerRevision}
        // A reply that lands mid-attempt must not replace the caption the
        // request already captured (the textarea is locked for the same
        // reason); a ref avoids the stale closure from the rendering send.
        onDraftChange={(text) => {
          if (busyRef.current) return false;
          setCaption(text);
          return true;
        }}
        contextLabel="reel caption (2,200 character limit)"
      />
    </PublishPage>
  );
}
