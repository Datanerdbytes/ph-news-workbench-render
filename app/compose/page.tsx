'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Copy,
  ImagePlus,
  Loader2,
  Newspaper,
  PenLine,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { AppFrame } from '@/components/app-frame';
import { AssistantChat } from '@/components/assistant-chat';
import {
  VoiceOverPanel,
  type VoiceOverAudio,
} from '@/components/compose/voice-over-panel';
import {
  NarrationModeSelector,
  type NarrationMode,
} from '@/components/compose/narration-mode-selector';
import { TalkingAvatarPanel } from '@/components/compose/talking-avatar-panel';
import { AvatarOverlayEditor } from '@/components/compose/avatar-overlay-editor';
import { FacebookMark } from '@/components/facebook-mark';
import { useFacebookConnection } from '@/components/facebook-connection';
import { FacebookPreview } from '@/components/facebook-preview';
import {
  FilePicker,
  PageSelector,
  defaultScheduleValue,
  mediaFileError,
  scheduleBounds,
  useManagedPages,
  useScheduleClock,
} from '@/components/publishing/publish-page';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import { useScheduleRetry } from '@/components/publishing/schedule-retry-dialog';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import {
  formatCost,
  formatDomain,
  imageSrc,
  stripMarkdown,
  timeAgo,
  wordCount,
} from '@/lib/format';
import { stageUpload } from '@/lib/stage-client';
import { deleteStagedBlob } from '@/lib/blob-cleanup';
import {
  DEFAULT_AVATAR_ID,
  getAvatar,
  supportsAvatarTransparency,
  type AvatarId,
} from '@/lib/avatar/avatars';
import {
  ACTIVE_AVATAR_STATUSES,
  avatarMediaUrl,
  preferredAvatarJob,
  readAvatarJobResponse,
  type PublicAvatarJob,
} from '@/lib/avatar/jobs';
import { useAvatarJobPolling } from '@/lib/avatar/use-avatar-job-polling';
import { shouldDeleteAvatarCompositeAfterPublishFailure } from '@/lib/avatar/publish-cleanup';
import { supportsTransparentAvatarPreview } from '@/lib/avatar/output';
import { normalizeSpeechText } from '@/lib/tts/text';
import {
  defaultVoiceForLanguage,
  type TtsVoiceId,
} from '@/lib/tts/voices';
import { fetchQueueItem, fetchQueuePage, type QueueItem } from '@/lib/story-queue';
import {
  MediaPreviewCard,
  MediaPreviewMedia,
} from '@/components/publishing/media-preview-card';
import { VideoAnimationPicker } from '@/components/videos/video-animation-picker';
import { VideoAnimationOverlay } from '@/components/videos/video-animation-overlay';
import { bakeAndFinalizeVideo } from '@/lib/videos/bake';
import { flattenTransparentAvatar } from '@/lib/videos/avatar-video';
import { bakeAndFinalizeNarratedSlideshow } from '@/lib/videos/slideshow';
import {
  DEFAULT_AVATAR_PLACEMENT,
  type AvatarPlacement,
} from '@/lib/videos/composition';
import {
  attachmentsFromSlots,
  presetDefaultValues,
  type PresetSlot,
  type PresetValues,
} from '@/lib/videos/presets';
import type {
  VideoSlotLoops,
  VideoSlotSelection,
} from '@/components/videos/video-animation-picker';

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
// A bake records the clip in real time and the API cannot cancel one, so a
// cancelled schedule leaves its render draining in the background. Two cover
// that render plus the composer's active one; a third attempt falls back to
// the original clip until one drains instead of stacking recorders.
const MAX_CONCURRENT_BAKES = 2;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function isAvatarJobActive(job: PublicAvatarJob | null): boolean {
  return Boolean(job && ACTIVE_AVATAR_STATUSES.includes(job.status));
}

function publishButtonLabel(
  baking: boolean,
  bakePct: number | null,
  publishing: boolean
): string {
  if (baking) return `Rendering ${Math.round((bakePct ?? 0) * 100)}%…`;
  if (publishing) return 'Publishing…';
  return 'Publish';
}

type DraftStats = {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

function WorkspaceSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the Compose workspace"
      className="animate-pulse space-y-5"
    >
      <div className="h-44 rounded-[18px] bg-ink/90" />
      <div className="rounded-[18px] border border-border bg-card p-5">
        <div className="h-3 w-16 rounded bg-muted" />
        <div className="mt-4 h-[220px] w-full rounded bg-muted/60" />
      </div>
    </div>
  );
}

function EmptyWorkspace({ onOpenSources }: { onOpenSources: () => void }) {
  return (
    <div className="compose-empty p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-[var(--compose-accent-soft)] text-[var(--compose-accent)]">
          <Newspaper className="size-5" aria-hidden />
        </span>
        <h2 className="mt-5 font-display text-3xl font-semibold tracking-[-0.04em]">
          The desk is quiet
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--compose-muted)]">
          Pick a story from Sources to start drafting.
        </p>
        <Button
          variant="brand"
          size="sm"
          className="mt-5"
          onClick={onOpenSources}
        >
          <Newspaper className="size-3.5" aria-hidden />
          Open Sources
        </Button>
      </div>
    </div>
  );
}

function ComposeWorkspace() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const facebook = useFacebookConnection();
  const pages = useManagedPages();
  const selectedPage = pages.pages.find((page) => page.id === pages.selected[0]);
  const [, setItems] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [draft, setDraft] = useState('');
  const [stats, setStats] = useState<DraftStats | null>(null);
  const [language, setLanguage] = useState<'en' | 'tl'>('en');
  const [images, setImages] = useState<string[]>([]);
  const [imagesBusy, setImagesBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // Optional video attachment — one media type per post: attaching a video
  // clears the images, attaching an image clears the video. The file stages
  // straight from the browser to storage; publish/schedule reference the URL.
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoStaging, setVideoStaging] = useState(false);
  const [videoStagingFailed, setVideoStagingFailed] = useState(false);
  const [videoPct, setVideoPct] = useState<number | null>(null);
  const [videoPreviewFailed, setVideoPreviewFailed] = useState(false);
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
  const [baking, setBaking] = useState(false);
  const [bakePct, setBakePct] = useState<number | null>(null);
  const animations = attachmentsFromSlots(animSlots, animLoops);
  const [narrationMode, setNarrationMode] = useState<NarrationMode>('off');
  const voiceOverEnabled = narrationMode === 'voice';
  const [voiceId, setVoiceId] = useState<TtsVoiceId>('en-PH-RosaNeural');
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [originalVolume, setOriginalVolume] = useState(0.25);
  const [narration, setNarration] = useState<VoiceOverAudio | null>(null);
  const [ttsGenerating, setTtsGenerating] = useState(false);
  const [ttsError, setTtsError] = useState('');
  const ttsSequence = useRef(0);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const narrationUrlRef = useRef<string | null>(null);
  const [avatarId, setAvatarId] = useState<AvatarId>(DEFAULT_AVATAR_ID);
  const [avatarTransparent, setAvatarTransparent] = useState(false);
  const [transparencySupported, setTransparencySupported] = useState(true);
  const [avatarPlacement, setAvatarPlacement] = useState<AvatarPlacement>(
    DEFAULT_AVATAR_PLACEMENT,
  );
  const [avatarJob, setAvatarJob] = useState<PublicAvatarJob | null>(null);
  const [avatarAction, setAvatarAction] = useState<
    'creating' | 'canceling' | 'removing' | null
  >(null);
  const [avatarError, setAvatarError] = useState('');
  const avatarSequence = useRef(0);
  const avatarAbortRef = useRef<AbortController | null>(null);
  const avatarJobRef = useRef<PublicAvatarJob | null>(null);
  useEffect(() => {
    avatarJobRef.current = avatarJob;
  }, [avatarJob]);
  useEffect(() => {
    setTransparencySupported(supportsTransparentAvatarPreview());
  }, []);

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
  const selectionRef = useRef<number | null>(null);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Bumped when the composer switches stories or drops the draft, so an
  // assistant reply for the old draft cannot refill the new one.
  const [composerRevision, setComposerRevision] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);
  const scheduleInputRef = useRef<HTMLInputElement>(null);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduling, setScheduling] = useState(false);
  // The draft editor lock is separate from `scheduling`: cancelling a long
  // bake hands editing back immediately while the abandoned attempt unwinds.
  const [editorLocked, setEditorLocked] = useState(false);
  // The attempt whose schedule request is on the wire: past that point Cancel
  // cannot abort it, so the button becomes a non-cancellable waiting state.
  // Scoping it to the attempt stops an abandoned bake's finally from releasing
  // a newer attempt's dispatch lock.
  const [dispatchingAttempt, setDispatchingAttempt] = useState<number | null>(
    null
  );
  const dispatching = dispatchingAttempt !== null;
  // The picker stays editable while the bake runs, so the submit-time value is
  // read from a ref instead of the closure that started schedulePost().
  const scheduledForRef = useRef(scheduledFor);
  useEffect(() => {
    scheduledForRef.current = scheduledFor;
  }, [scheduledFor]);
  useEffect(() => {
    if (!scheduleOpen) return;
    const frame = requestAnimationFrame(() => scheduleInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [scheduleOpen]);
  // Closing the picker bumps this so a bake in progress stops before it
  // prompts for a new time or posts against an abandoned schedule.
  const scheduleAttempt = useRef(0);
  // Increments for every bake; an abandoned bake must not move the progress
  // of the one that replaced it. Cancelling bumps it too, which detaches the
  // running bake: its progress and finally stop touching the composer, and
  // the controls come back while the render drains.
  const bakeSequence = useRef(0);
  const rendersInFlight = useRef(0);
  // Read by the assistant's reply handler, which can fire long after the
  // render that started the request. Layout effects publish the lock during
  // the commit itself — before the browser can hand another task the reply
  // continuation that reads it — and the dispatch claim also writes its ref
  // directly at the moment the request goes out.
  const editorLockedRef = useRef(false);
  useLayoutEffect(() => {
    editorLockedRef.current = editorLocked;
  }, [editorLocked]);
  const dispatchingRef = useRef(false);
  useLayoutEffect(() => {
    dispatchingRef.current = dispatching;
  }, [dispatching]);
  // The publish flow holds the same editor lock as scheduling, but a reply
  // meeting it must be dropped, not applied — the POST already carries the
  // captured draft and there is no schedule attempt to hand back to.
  const publishingRef = useRef(false);
  useLayoutEffect(() => {
    publishingRef.current = publishing;
  }, [publishing]);
  // Leaving the page abandons a bake in flight: the attempt check makes it
  // stop before staging a blob for a post nobody can submit. The upload that
  // already started is cleaned up by the caller's generation check.
  useEffect(
    () => () => {
      scheduleAttempt.current += 1;
      ttsSequence.current += 1;
      ttsAbortRef.current?.abort();
      avatarSequence.current += 1;
      avatarAbortRef.current?.abort();
      if (narrationUrlRef.current) {
        URL.revokeObjectURL(narrationUrlRef.current);
        narrationUrlRef.current = null;
      }
    },
    []
  );

  function clearVoiceOver() {
    ttsSequence.current += 1;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    setTtsGenerating(false);
    setTtsError('');
    if (narrationUrlRef.current) {
      URL.revokeObjectURL(narrationUrlRef.current);
      narrationUrlRef.current = null;
    }
    setNarration(null);
  }

  function changeNarrationMode(mode: NarrationMode) {
    setNarrationMode(mode);
    if (mode !== 'voice') clearVoiceOver();
    if (mode === 'avatar') void refreshAvatarJobs();
  }

  function changeLanguage(value: 'en' | 'tl') {
    setLanguage(value);
    setVoiceId(defaultVoiceForLanguage(value));
  }

  async function generateVoiceOver() {
    const text = normalizeSpeechText(draft);
    if (
      !text ||
      !voiceOverEnabled ||
      (!videoFile && !images.length) ||
      ttsGenerating ||
      editorLocked ||
      drafting ||
      publishing ||
      scheduling ||
      deleting
    ) {
      return;
    }
    const requestId = ++ttsSequence.current;
    ttsAbortRef.current?.abort();
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setTtsGenerating(true);
    setTtsError('');
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId, speed: speechSpeed }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data?.error ?? 'The voice-over could not be generated. Please try again.'
        );
      }
      const blob = await response.blob();
      if (!blob.size) {
        throw new Error('The speech service returned no audio. Please try again.');
      }
      if (requestId !== ttsSequence.current) return;
      if (narrationUrlRef.current) URL.revokeObjectURL(narrationUrlRef.current);
      const url = URL.createObjectURL(blob);
      narrationUrlRef.current = url;
      setNarration({
        blob,
        url,
        text,
        voiceId,
        speed: speechSpeed,
        duration: 0,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId === ttsSequence.current) {
        setTtsError(
          error instanceof Error
            ? error.message
            : 'The voice-over could not be generated. Please try again.'
        );
      }
    } finally {
      if (requestId === ttsSequence.current) {
        ttsAbortRef.current = null;
        setTtsGenerating(false);
      }
    }
  }

  const updateAvatarJob = useCallback((job: PublicAvatarJob | null) => {
    avatarJobRef.current = job;
    setAvatarJob(job);
  }, []);

  const clearAvatar = useCallback((removeRemote = false) => {
    const previous = avatarJobRef.current;
    avatarSequence.current += 1;
    avatarAbortRef.current?.abort();
    avatarAbortRef.current = null;
    updateAvatarJob(null);
    setAvatarPlacement(DEFAULT_AVATAR_PLACEMENT);
    setAvatarAction(null);
    setAvatarError('');
    if (
      !removeRemote ||
      !previous ||
      (!isAvatarJobActive(previous) && previous.publishState !== 'ready')
    ) {
      return;
    }
    void fetch(`/api/avatar/syntheses/${encodeURIComponent(previous.id)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => undefined);
  }, [updateAvatarJob]);

  async function refreshAvatarJobs() {
    if (avatarAction || avatarAbortRef.current) return;
    const requestId = ++avatarSequence.current;
    const controller = new AbortController();
    avatarAbortRef.current = controller;
    try {
      const response = await fetch('/api/avatar/syntheses', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data)) {
        throw new Error(data?.error ?? 'Avatar jobs could not be loaded.');
      }
      if (requestId !== avatarSequence.current) return;
      const preferred = preferredAvatarJob(data as PublicAvatarJob[]);
      updateAvatarJob(preferred);
      if (preferred) setAvatarTransparent(preferred.hasAlpha);
      setAvatarError('');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId === avatarSequence.current && !avatarJobRef.current) {
        setAvatarError(
          error instanceof Error ? error.message : 'Avatar jobs could not be loaded.',
        );
      }
    } finally {
      if (requestId === avatarSequence.current) avatarAbortRef.current = null;
    }
  }

  function changeAvatar(nextAvatarId: AvatarId) {
    setAvatarId(nextAvatarId);
    if (!supportsAvatarTransparency(getAvatar(nextAvatarId))) {
      setAvatarTransparent(false);
    }
  }

  async function generateAvatar() {
    const text = normalizeSpeechText(draft);
    const previous = avatarJobRef.current;
    if (
      narrationMode !== 'avatar' ||
      !text ||
      isAvatarJobActive(previous) ||
      (previous !== null && previous.publishState !== 'ready') ||
      avatarAction ||
      avatarAbortRef.current ||
      editorLocked ||
      drafting ||
      publishing ||
      scheduling ||
      deleting
    ) {
      return;
    }
    const requestId = ++avatarSequence.current;
    const controller = new AbortController();
    avatarAbortRef.current = controller;
    setAvatarError('');
    try {
      if (previous) {
        setAvatarAction('removing');
        const removal = await fetch(
          `/api/avatar/syntheses/${encodeURIComponent(previous.id)}`,
          { method: 'DELETE', signal: controller.signal },
        );
        if (!removal.ok) {
          const data = await removal.json().catch(() => null);
          throw new Error(data?.error ?? 'The previous avatar could not be removed.');
        }
        if (requestId !== avatarSequence.current) return;
        updateAvatarJob(null);
      }
      setAvatarAction('creating');
      const response = await fetch('/api/avatar/syntheses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          avatarId,
          voiceId,
          speed: speechSpeed,
          transparent: avatarTransparent,
        }),
        signal: controller.signal,
      });
      const job = await readAvatarJobResponse(
        response,
        'The avatar job could not be created.',
      );
      if (requestId !== avatarSequence.current) return;
      updateAvatarJob(job);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId === avatarSequence.current) {
        setAvatarError(
          error instanceof Error ? error.message : 'The avatar could not be generated.',
        );
      }
    } finally {
      if (requestId === avatarSequence.current) {
        avatarAbortRef.current = null;
        setAvatarAction(null);
      }
    }
  }

  async function cancelAvatar() {
    const job = avatarJobRef.current;
    if (!job || !isAvatarJobActive(job) || avatarAction || avatarAbortRef.current) {
      return;
    }
    const requestId = ++avatarSequence.current;
    const controller = new AbortController();
    avatarAbortRef.current = controller;
    setAvatarAction('canceling');
    setAvatarError('');
    try {
      const response = await fetch(
        `/api/avatar/syntheses/${encodeURIComponent(job.id)}`,
        { method: 'DELETE', signal: controller.signal },
      );
      const cancelled = await readAvatarJobResponse(
        response,
        'The avatar job could not be canceled.',
      );
      if (requestId !== avatarSequence.current) return;
      updateAvatarJob(cancelled);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId === avatarSequence.current) {
        setAvatarError(
          error instanceof Error ? error.message : 'The avatar job could not be canceled.',
        );
      }
    } finally {
      if (requestId === avatarSequence.current) {
        avatarAbortRef.current = null;
        setAvatarAction(null);
      }
    }
  }

  async function removeAvatar() {
    const job = avatarJobRef.current;
    if (
      !job ||
      isAvatarJobActive(job) ||
      job.publishState !== 'ready' ||
      avatarAction ||
      avatarAbortRef.current
    ) {
      return;
    }
    const requestId = ++avatarSequence.current;
    const controller = new AbortController();
    avatarAbortRef.current = controller;
    setAvatarAction('removing');
    setAvatarError('');
    try {
      const response = await fetch(
        `/api/avatar/syntheses/${encodeURIComponent(job.id)}`,
        { method: 'DELETE', signal: controller.signal },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? 'The avatar could not be removed.');
      }
      if (requestId !== avatarSequence.current) return;
      updateAvatarJob(null);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId === avatarSequence.current) {
        setAvatarError(
          error instanceof Error ? error.message : 'The avatar could not be removed.',
        );
      }
    } finally {
      if (requestId === avatarSequence.current) {
        avatarAbortRef.current = null;
        setAvatarAction(null);
      }
    }
  }

  const handleAvatarPoll = useCallback(
    (next: PublicAvatarJob) => {
      if (avatarJobRef.current?.id !== next.id) return;
      updateAvatarJob(next);
    },
    [updateAvatarJob]
  );
  const handleAvatarPollError = useCallback((message: string) => {
    setAvatarError(message);
  }, []);
  useAvatarJobPolling({
    job: avatarJob,
    onJob: handleAvatarPoll,
    onError: handleAvatarPollError,
  });

  const scheduleRetry = useScheduleRetry();
  const scheduleNow = useScheduleClock();
  const scheduleProblem = resolveScheduledFor(scheduledFor, scheduleNow).error;

  // Deep link: /compose?item=<id> opens that story. Applied once — later
  // reloads (after publish, schedule, delete) keep whatever is selected.
  const wantedId = Number(searchParams.get('item')) || null;
  const wantedAppliedRef = useRef(false);

  const applyWanted = useCallback((list: QueueItem[]): QueueItem | null => {
    if (!wantedAppliedRef.current && wantedId) {
      const wanted = list.find((item) => item.id === wantedId);
      if (wanted) {
        wantedAppliedRef.current = true;
        return wanted;
      }
    }
    return null;
  }, [wantedId]);

  const load = useCallback(async () => {
    try {
      const page = await fetchQueuePage();
      let rows = page.rows;
      const wanted = applyWanted(rows);
      if (!wanted && !wantedAppliedRef.current && wantedId) {
        // The deep-linked story may sit beyond the first list page — resolve
        // it directly so the editor opens the linked story, not the first.
        const single = await fetchQueueItem(wantedId);
        if (single) {
          rows = [single, ...rows.filter((item) => item.id !== single.id)];
          wantedAppliedRef.current = true;
        }
      }
      setItems(rows);
      setLoadError(false);
      setSelected((prev) => {
        if (wanted) return wanted;
        if (prev) {
          // Keep the user's selection even when it fell off the refreshed
          // first page — deep-linked stories can live beyond it.
          const next = rows.find((item) => item.id === prev.id);
          return next ?? prev;
        }
        return rows[0] ?? null;
      });
    } catch {
      setLoadError(true);
    } finally {
      setItemsLoading(false);
    }
  }, [applyWanted, wantedId]);

  useEffect(() => {
    load();
  }, [load]);

  // Selecting a story resets the editor and picks up its saved draft.
  const selectedId = selected?.id;
  const lastLoadedIdRef = useRef<number | null>(null);
  const loadSavedDraft = useCallback(async (item: QueueItem) => {
    setDraftLoadFailed(false);
    try {
      const res = await fetch(`/api/drafts/${item.draft_id}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setDraftLoadFailed(true);
        return;
      }
      const data = await res.json();
      if (selectionRef.current !== item.id) return;
      if (typeof data.text === 'string') setDraft(data.text);
      if (typeof data.input_tokens === 'number') {
        setStats({
          inputTokens: data.input_tokens,
          outputTokens: data.output_tokens ?? 0,
          estimatedCost: Number(data.estimated_cost) || 0,
        });
      }
    } catch {
      // Selection still works; flag it so the editor isn't mistaken for "no draft yet".
      setDraftLoadFailed(true);
    }
  }, []);

  // One media type per post: a video attachment replaces the images, and
  // picking an image drops the video. The staged blob is NOT deleted on
  // removal — a scheduled post may still reference it; the scheduler cleans
  // it up after publishing.
  function applyVideoFile(next: File | null) {
    // The clip a pending schedule was baking no longer exists: abandon that
    // attempt so its prompt cannot schedule the removed video. Once the
    // request is on the wire Cancel cannot abort it, so leave the lock alone —
    // otherwise a removal would open the composer for a second dispatch while
    // the first POST is still pending.
    if (!dispatching) {
      scheduleAttempt.current += 1;
      scheduleRetry.cancel();
      // An abandoned attempt no longer owns the controls; its own finally will
      // skip the reset because the attempt id moved on.
      setScheduling(false);
      setEditorLocked(false);
    }
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    setVideoFile(next);
    setVideoPreviewUrl(next ? URL.createObjectURL(next) : null);
    setVideoUrl(null);
    setVideoPct(null);
    setVideoStagingFailed(false);
    setVideoPreviewFailed(false);
    // Animations belong to the attached clip — never carry them to the next.
    setAnimSlots({ start: null, middle: null, end: null });
    setAnimLoops({ start: false, middle: false, end: false });
    setAnimValues({});
    if (next) {
      setImages([]);
      void stageVideo(next);
    }
  }

  /**
   * Staged URL of the video that should actually be posted. With animations
   * attached the browser bakes them into the footage first (real-time
   * playback), finalizes the recording to MP4, then re-stages the result;
   * any failure falls back to posting the original clip.
   */
  async function animatedVideoUrl(isCurrent?: () => boolean): Promise<string | null> {
    if (!videoUrl) return videoUrl;
    if (!animations.length || !videoPreviewUrl) return videoUrl;
    // A detached render from a cancelled attempt may still be recording.
    // Refuse a third rather than stacking recorders the compositor cannot
    // serve: the throw surfaces in the caller's catch and fails the attempt
    // with a clear message instead of queueing behind an unbounded pile.
    if (rendersInFlight.current >= MAX_CONCURRENT_BAKES) {
      throw new Error(
        'The previous animation render is still finishing — try again in a moment.'
      );
    }
    // A cancelled attempt can leave its bake running while a newer one starts;
    // only the newest bake may move progress, warn, or clear the flags.
    const bakeId = ++bakeSequence.current;
    const ownsBake = () => bakeId === bakeSequence.current;
    setBaking(true);
    setBakePct(0);
    try {
      let finalized: File;
      rendersInFlight.current += 1;
      try {
        finalized = await bakeAndFinalizeVideo({
          videoUrl: videoPreviewUrl,
          attachments: animations,
          values: animValues,
          aspectRatio: '16:9',
          onProgress: (pct) => {
            if (ownsBake()) setBakePct(pct);
          },
        });
      } finally {
        rendersInFlight.current -= 1;
      }
      // A cancelled schedule must not pay for staging a blob nobody will post.
      if (isCurrent && !isCurrent()) return null;
      const staged = await stageUpload(
        `compose/${Date.now()}-${finalized.name.replace(/[^\w.-]+/g, '_')}`,
        finalized,
        { contentType: 'video/mp4' }
      );
      return staged.url;
    } catch (error) {
      if (ownsBake()) {
        toast.warning('Posting without the animation', {
          description:
            error instanceof Error
              ? error.message
              : 'The animation could not be rendered in this browser.',
        });
      }
      return videoUrl;
    } finally {
      // An abandoned bake still clears its own flags when no newer bake owns
      // them; when one does, its state belongs to the newer bake.
      if (ownsBake()) {
        setBaking(false);
        setBakePct(null);
      }
    }
  }

  async function narratedMediaUrl(isCurrent?: () => boolean): Promise<string | null> {
    if (!voiceOverReady || !narration) {
      throw new Error('Generate the voice-over before publishing.');
    }
    if (rendersInFlight.current >= MAX_CONCURRENT_BAKES) {
      throw new Error(
        'The previous media render is still finishing — try again in a moment.'
      );
    }
    const bakeId = ++bakeSequence.current;
    const ownsBake = () => bakeId === bakeSequence.current;
    setBaking(true);
    setBakePct(0);
    try {
      let finalized: File;
      rendersInFlight.current += 1;
      try {
        if (videoUrl && videoPreviewUrl) {
          finalized = await bakeAndFinalizeVideo({
            videoUrl: videoPreviewUrl,
            attachments: animations,
            values: animValues,
            aspectRatio: '16:9',
            narration: narration.blob,
            originalAudioVolume: originalVolume,
            onProgress: (pct) => {
              if (ownsBake()) setBakePct(pct);
            },
          });
        } else if (images.length) {
          finalized = await bakeAndFinalizeNarratedSlideshow({
            images,
            narration: narration.blob,
            onProgress: (pct) => {
              if (ownsBake()) setBakePct(pct);
            },
          });
        } else {
          throw new Error('Attach a photo or video for the voice-over.');
        }
      } finally {
        rendersInFlight.current -= 1;
      }
      if (isCurrent && !isCurrent()) return null;
      const staged = await stageUpload(
        `compose/${Date.now()}-${finalized.name.replace(/[^\w.-]+/g, '_')}`,
        finalized,
        { contentType: 'video/mp4' }
      );
      return staged.url;
    } catch (error) {
      if (ownsBake()) {
        toast.error('Voice-over could not be attached', {
          description:
            error instanceof Error
              ? error.message
              : 'The narrated media could not be rendered in this browser.',
        });
      }
      throw error;
    } finally {
      if (ownsBake()) {
        setBaking(false);
        setBakePct(null);
      }
    }
  }

  async function avatarCompositeMediaUrl(isCurrent?: () => boolean): Promise<string | null> {
    if (!avatarReady || !avatarJob?.videoUrl) {
      throw new Error('Generate the avatar video before publishing.');
    }
    if (!videoFile && !images.length && !avatarJob.hasAlpha) {
      return avatarJob.videoUrl;
    }
    if (rendersInFlight.current >= MAX_CONCURRENT_BAKES) {
      throw new Error(
        'The previous media render is still finishing — try again in a moment.'
      );
    }
    const bakeId = ++bakeSequence.current;
    const ownsBake = () => bakeId === bakeSequence.current;
    setBaking(true);
    setBakePct(0);
    try {
      let finalized: File;
      rendersInFlight.current += 1;
      try {
        if (!videoFile && !images.length && avatarJob.hasAlpha) {
          finalized = await flattenTransparentAvatar(
            avatarMediaUrl(avatarJob.id),
            (pct) => {
              if (ownsBake()) setBakePct(pct);
            },
          );
        } else if (videoUrl && videoPreviewUrl) {
          finalized = await bakeAndFinalizeVideo({
            videoUrl: videoPreviewUrl,
            attachments: animations,
            values: animValues,
            aspectRatio: '16:9',
            avatarUrl: avatarMediaUrl(avatarJob.id),
            avatarPlacement,
            originalAudioVolume: originalVolume,
            onProgress: (pct) => {
              if (ownsBake()) setBakePct(pct);
            },
          });
        } else if (images.length) {
          finalized = await bakeAndFinalizeNarratedSlideshow({
            images,
            avatarUrl: avatarMediaUrl(avatarJob.id),
            avatarPlacement,
            onProgress: (pct) => {
              if (ownsBake()) setBakePct(pct);
            },
          });
        } else {
          throw new Error('Attach a photo or video for the avatar overlay.');
        }
      } finally {
        rendersInFlight.current -= 1;
      }
      if (isCurrent && !isCurrent()) return null;
      const staged = await stageUpload(
        `compose/avatars/${avatarJob.id}/${Date.now()}-${finalized.name.replace(/[^\w.-]+/g, '_')}`,
        finalized,
        { contentType: 'video/mp4' }
      );
      return staged.url;
    } catch (error) {
      if (ownsBake()) {
        toast.error('Avatar overlay could not be attached', {
          description:
            error instanceof Error
              ? error.message
              : 'The avatar composite could not be rendered in this browser.',
        });
      }
      throw error;
    } finally {
      if (ownsBake()) {
        setBaking(false);
        setBakePct(null);
      }
    }
  }

  async function postMediaUrl(isCurrent?: () => boolean): Promise<string | null> {
    if (avatarReady && avatarJob?.videoUrl) {
      return avatarCompositeMediaUrl(isCurrent);
    }
    if (voiceOverReady) return narratedMediaUrl(isCurrent);
    return videoUrl ? animatedVideoUrl(isCurrent) : null;
  }

  async function stageVideo(file: File) {
    setVideoStaging(true);
    try {
      const staged = await stageUpload(
        `compose/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`,
        file,
        {
          contentType: file.type,
          onUploadProgress: ({ percentage }) => setVideoPct(Math.round(percentage)),
        },
      );
      setVideoUrl(staged.url);
    } catch (error) {
      setVideoStagingFailed(true);
      toast.error('Video staging failed', {
        description:
          error instanceof Error ? error.message : 'The video could not be staged.',
      });
    } finally {
      setVideoStaging(false);
      setVideoPct(null);
    }
  }

  useEffect(() => {
    if (selectedId === lastLoadedIdRef.current) return;
    lastLoadedIdRef.current = selectedId ?? null;
    selectionRef.current = selectedId ?? null;
    setDraft('');
    setStats(null);
    setImages([]);
    setComposerRevision((revision) => revision + 1);
    applyVideoFile(null);
    clearVoiceOver();
    clearAvatar(true);
    setConfirmDelete(false);
    setScheduleOpen(false);
    setEditorLocked(false);
    setDraftLoadFailed(false);
    if (selected?.draft_id) void loadSavedDraft(selected);
  }, [selectedId, selected, loadSavedDraft, clearAvatar]);

  async function generateDraft() {
    if (!selected || drafting || publishing || scheduling || deleting) return;
    setDrafting(true);
    setConfirmDelete(false);
    try {
      const res = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newsItemId: selected.id, language }),
      });
      const data = await res.json();
      if (!res.ok || !data.text) {
        throw new Error(data.error ?? 'The draft could not be generated.');
      }
      setDraft(data.text);
      setStats({
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        estimatedCost: data.estimatedCost,
      });
      toast.success('Draft ready', {
        description: 'Review and refine it before publishing.',
      });
      await load();
    } catch (error) {
      toast.error('Draft failed', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setDrafting(false);
    }
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function compressImage(file: File): Promise<string> {
    const dataUrl = await readAsDataUrl(file);

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      element.src = dataUrl;
    });

    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = longest > 1600 ? 1600 / longest : 1;
    if (scale === 1 && file.size < 900 * 1024) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return dataUrl;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function addImages(files: FileList | File[]) {
    const picked = Array.from(files);
    if (!picked.length) return;
    // One media type per post — picking images drops an attached video.
    if (videoFile || videoUrl) applyVideoFile(null);

    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast.error(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }

    setImagesBusy(true);
    const accepted: string[] = [];
    let skipped = 0;
    for (const file of picked) {
      if (
        accepted.length >= room ||
        !ALLOWED_IMAGE_TYPES.has(file.type) ||
        file.size > MAX_IMAGE_BYTES
      ) {
        skipped += 1;
        continue;
      }
      try {
        accepted.push(await compressImage(file));
      } catch {
        skipped += 1;
      }
    }

    if (accepted.length) {
      setImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES));
      toast.success(
        accepted.length === 1
          ? 'Image attached'
          : `${accepted.length} images attached`
      );
    }
    if (skipped) {
      toast.error('Some files were skipped', {
        description: `Use JPEG, PNG, or WebP under 20 MB — up to ${MAX_IMAGES} images.`,
      });
    }
    setImagesBusy(false);
    if (imageInputRef.current) imageInputRef.current.value = '';
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, position) => position !== index));
  }

  async function schedulePost() {
    if (!selected || !draft.trim()) return;
    if (narrationUnavailableReason) {
      setScheduleError(narrationUnavailableReason);
      return;
    }
    // Regeneration will replace the draft this request would capture, so wait
    // for it to land instead of scheduling text the editor is about to drop.
    // A delete or a publish already in flight will clear or post this draft;
    // an image still processing would miss the attachments array entirely.
    if (drafting || deleting || publishing || imagesBusy) return;
    // A video must finish staging before the post can be scheduled.
    if (videoFile && !videoUrl) return;
    const schedule = resolveScheduledFor(scheduledFor);
    if (schedule.iso === null) {
      setScheduleError(schedule.error);
      return;
    }
    setScheduleError('');
    setScheduling(true);
    setEditorLocked(true);
    const attempt = ++scheduleAttempt.current;
    try {
      const finalVideoUrl = await postMediaUrl(
        () => attempt === scheduleAttempt.current
      );
      // The animated bake re-stages a fresh blob; with the schedule abandoned,
      // no request will consume it — remove it instead of leaving it orphaned
      // in the store.
      const discardBake = () => {
        if (
          finalVideoUrl &&
          finalVideoUrl !== videoUrl &&
          finalVideoUrl !== avatarJob?.videoUrl
        ) {
          deleteStagedBlob(finalVideoUrl);
        }
      };
      // Cancelled while the bake ran: no prompt, no post, and the abandoned
      // bake blob is cleaned up.
      if (attempt !== scheduleAttempt.current) {
        discardBake();
        return;
      }
      // The bake can run for the clip's full length; re-check against the
      // submit-time clock so the slot is still valid when the request lands.
      // On a miss, ask for a new time here — the staged/baked video is reused,
      // so nothing is rendered or uploaded twice.
      const submit = await scheduleRetry.resolveSubmit(
        scheduledForRef.current,
        'post'
      );
      if (submit.kind === 'cancelled') {
        discardBake();
        return;
      }
      if (attempt !== scheduleAttempt.current) {
        discardBake();
        return;
      }
      if (submit.picked) setScheduledFor(submit.picked);
      const when = new Date(submit.iso);
      // The request is on the wire now; Cancel can no longer abort it. The
      // ref moves synchronously so a reply landing before the re-render that
      // publishes the state already sees the dispatch lock held.
      setDispatchingAttempt(attempt);
      dispatchingRef.current = true;
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newsItemId: selected.id,
          draftId: selected.draft_id ?? undefined,
          text: draft,
          ...(finalVideoUrl ? { videoUrl: finalVideoUrl } : { imageUrls: images }),
          ...(avatarReady && avatarJob ? { avatarJobId: avatarJob.id } : {}),
          scheduledFor: submit.iso,
          pageId: pages.selected[0],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 400/401/404 are pre-insert rejections: the schedule row does not
        // exist, so nothing will consume the freshly baked blob. An error or
        // an ambiguous network failure may still be inserting — keep it.
        if (
          res.status === 400 ||
          res.status === 401 ||
          res.status === 404 ||
          (res.status === 409 && data?.code === 'avatar_unavailable')
        ) {
          discardBake();
        }
        throw new Error(data.error ?? 'Could not schedule the post.');
      }
      if (avatarReady && avatarJob) {
        updateAvatarJob({ ...avatarJob, publishState: 'scheduled' });
      }
      toast.success('Post scheduled', {
        description: when.toLocaleString('en-PH', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
      });
      // A picker reopened while this request was pending belongs to a newer
      // attempt — its close must not shut that one.
      if (attempt === scheduleAttempt.current) setScheduleOpen(false);
      // Refresh the queue so the row's status stops showing its pre-schedule state.
      await load();
    } catch (error) {
      toast.error('Scheduling failed', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      // This request is done either way; only its own attempt may release the
      // composer, so a cancelled attempt cannot unlock a newer one. The ref
      // tracks the same updater so the release is synchronous too.
      setDispatchingAttempt((current) => {
        const next = current === attempt ? null : current;
        dispatchingRef.current = next !== null;
        return next;
      });
      if (attempt === scheduleAttempt.current) {
        setEditorLocked(false);
        setScheduling(false);
      }
    }
  }

  async function deleteDraftFor(item: QueueItem) {
    // A dispatch, a delete, or a pending draft generation owns the composer
    // until it settles; overlapping them would let the other clear the
    // first's locks — or delete the story the generation is writing for.
    if (scheduling || deleting || publishing || drafting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/drafts?newsItemId=${item.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'The draft could not be deleted.');
      }
      if (selected?.id === item.id) {
        setDraft('');
        setComposerRevision((revision) => revision + 1);
        setStats(null);
        setImages([]);
        applyVideoFile(null);
        clearVoiceOver();
        clearAvatar(true);
        setConfirmDelete(false);
      }
      await load();
      toast.success('Draft deleted', {
        description: 'The story is back in Pending.',
      });
    } catch (error) {
      toast.error('Could not delete the draft', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setDeleting(false);
    }
  }

  async function publish() {
    if (!selected || !draft.trim()) return;
    if (narrationUnavailableReason) {
      toast.error('Narration is not ready', {
        description: narrationUnavailableReason,
      });
      return;
    }
    // The draft captured below would be replaced under the request.
    if (drafting || deleting) return;
    // A video must finish staging before the post can go out.
    if (videoFile && !videoUrl) return;

    if (!facebook.scopes.includes('pages_manage_posts')) {
      toast.error('Publishing permission missing', {
        description: 'Reconnect the Page so it can publish on your behalf.',
        action: { label: 'Reconnect', onClick: () => facebook.connect() },
      });
      return;
    }

    // The schedule flow locks the editor for the same reason: the request
    // below carries the draft captured now, so a pending assistant rewrite
    // must not change the editor while the POST is out.
    setPublishing(true);
    publishingRef.current = true;
    setEditorLocked(true);
    try {
      const finalVideoUrl = await postMediaUrl();
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newsItemId: selected.id,
          message: draft,
          ...(finalVideoUrl ? { videoUrl: finalVideoUrl } : { imageUrls: images }),
          ...(avatarReady && avatarJob ? { avatarJobId: avatarJob.id } : {}),
          pageId: pages.selected[0],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (
          finalVideoUrl &&
          shouldDeleteAvatarCompositeAfterPublishFailure({
            status: res.status,
            code: data?.code,
            avatarJobId: avatarReady && avatarJob ? avatarJob.id : null,
            mediaUrl: finalVideoUrl,
            sourceAvatarUrl: avatarJob?.videoUrl ?? null,
          })
        ) {
          deleteStagedBlob(finalVideoUrl);
        }
        throw new Error(data?.error ?? 'The post could not be published.');
      }

      if (avatarReady && avatarJob) {
        updateAvatarJob({ ...avatarJob, publishState: 'published' });
      }
      toast.success(
        `Published to ${data.page?.name ?? facebook.page?.name ?? 'your Page'}`,
        {
          description: 'Your post is live on Facebook.',
          action: data.permalink
            ? {
                label: 'View post',
                onClick: () =>
                  window.open(data.permalink, '_blank', 'noopener,noreferrer'),
              }
            : undefined,
        }
      );
      await load();
    } catch (error) {
      toast.error('Publish failed', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setPublishing(false);
      publishingRef.current = false;
      // Publish holds the lock itself, so releasing it unconditionally here
      // cannot drop a schedule attempt's lock.
      setEditorLocked(false);
    }
  }

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(stripMarkdown(draft));
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy the draft');
    }
  }

  const words = wordCount(draft);
  const speechText = normalizeSpeechText(draft);
  const narrationStale = Boolean(
    narration &&
      (narration.text !== speechText ||
        narration.voiceId !== voiceId ||
        narration.speed !== speechSpeed)
  );
  const voiceOverReady = Boolean(
    voiceOverEnabled && narration && !narrationStale && !ttsGenerating
  );
  const hasMedia = Boolean(videoFile || images.length);
  const avatarActive = isAvatarJobActive(avatarJob);
  const avatarStale = Boolean(
    avatarJob &&
      (avatarJob.text !== speechText ||
        avatarJob.avatarId !== avatarId ||
        avatarJob.voiceId !== voiceId ||
        avatarJob.speed !== speechSpeed ||
        avatarJob.hasAlpha !== avatarTransparent),
  );
  const avatarReady = Boolean(
    narrationMode === 'avatar' &&
      avatarJob?.status === 'completed' &&
      avatarJob.publishState === 'ready' &&
      avatarJob.videoUrl &&
      !avatarStale &&
      !avatarAction,
  );
  let narrationUnavailableReason: string | undefined;
  if (narrationMode === 'avatar') {
    if (!speechText) narrationUnavailableReason = 'Write a draft for the avatar';
    else if (avatarAction)
      narrationUnavailableReason = 'Wait for the avatar action to finish';
    else if (avatarActive)
      narrationUnavailableReason = 'Wait for the avatar video to finish generating';
    else if (avatarStale)
      narrationUnavailableReason =
        'Regenerate the avatar for the updated draft or settings';
    else if (!avatarJob)
      narrationUnavailableReason = 'Generate the avatar video before publishing';
    else if (avatarJob.publishState !== 'ready')
      narrationUnavailableReason =
        avatarJob.publishState === 'scheduled'
          ? 'This avatar is already attached to a scheduled post'
          : 'This avatar video is already being published or has been published';
    else if (avatarJob.status !== 'completed' || !avatarJob.videoUrl)
      narrationUnavailableReason = 'Generate a ready avatar video before publishing';
  } else if (voiceOverEnabled && !hasMedia) {
    narrationUnavailableReason = 'Attach a photo or video for the voice-over';
  } else if (voiceOverEnabled && ttsGenerating) {
    narrationUnavailableReason = 'Wait for the voice-over to finish generating';
  } else if (voiceOverEnabled && !narration) {
    narrationUnavailableReason = 'Generate the voice-over before publishing';
  } else if (voiceOverEnabled && narrationStale) {
    narrationUnavailableReason =
      'Regenerate the voice-over for the updated draft or settings';
  }

  const canPublish = facebook.scopes.includes('pages_manage_posts');
  const publishHint = facebook.loading
    ? 'Checking Facebook connection…'
    : !facebook.configured
      ? 'Add Facebook app credentials to enable publishing'
      : 'Connect your Facebook Page to publish';

  let publishUnavailableReason: string | undefined;
  if (!facebook.connected) publishUnavailableReason = publishHint;
  else if (selected?.status === 'published')
    publishUnavailableReason = 'This story is already published';
  else if (publishing) publishUnavailableReason = 'Publishing is in progress';
  else if (scheduling) publishUnavailableReason = 'Scheduling is in progress';
  else if (drafting)
    publishUnavailableReason = 'Wait for the draft to finish generating';
  else if (deleting)
    publishUnavailableReason = 'Wait for the draft to finish deleting';
  else if (!draft)
    publishUnavailableReason = 'Write or generate a draft to publish';
  else if (!pages.selected.length)
    publishUnavailableReason = 'Select a Facebook Page to publish';
  else if (narrationUnavailableReason)
    publishUnavailableReason = narrationUnavailableReason;
  else if (baking)
    publishUnavailableReason = 'Wait for the media render to finish';
  else if (imagesBusy)
    publishUnavailableReason = 'Wait for the images to finish uploading';
  else if (videoStaging || (videoFile && !videoUrl)) {
    publishUnavailableReason = videoStagingFailed
      ? 'Remove or replace the video that failed to upload'
      : 'Wait for the video to finish uploading';
  }

  function closeSchedulePanel() {
    if (dispatchingRef.current || publishingRef.current) return;
    scheduleAttempt.current += 1;
    scheduleRetry.cancel();
    // The render API cannot be cancelled, so detach its progress and release
    // the composer while the abandoned bake drains in the background.
    bakeSequence.current += 1;
    setBaking(false);
    setBakePct(null);
    setScheduleOpen(false);
    setEditorLocked(false);
    setScheduling(false);
    scheduleButtonRef.current?.focus();
  }

  return (
    <AppFrame fill>
      <div className="compose-page flex min-h-0 flex-1 flex-col">
        <header className="compose-header flex shrink-0 items-center gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/sources"
            aria-label="Back to Sources"
            className="compose-back shrink-0"
          >
            <ArrowLeft className="size-4" aria-hidden />
            <span className="hidden sm:inline">Sources</span>
          </Link>
          <div className="min-w-0">
            <h1 className="compose-title">Compose</h1>
            <p className="compose-subtitle">
              {selected ? selected.title : 'Select a story to begin'}
            </p>
          </div>
          {selected ? (
            <StatusPill status={selected.status} className="ml-auto shrink-0" />
          ) : null}
        </header>

        <div className="compose-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[1280px] p-4 sm:p-6 xl:p-8">
            {itemsLoading ? (
              <WorkspaceSkeleton />
            ) : loadError ? (
              <ErrorState
                title="Couldn't load the news feed"
                description="Your stories are safe — the feed just couldn't be fetched right now."
                onRetry={load}
              />
            ) : !selected ? (
              <EmptyWorkspace onOpenSources={() => router.push('/sources')} />
            ) : (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
                <section
                  className="compose-source xl:col-start-1 xl:row-start-1"
                  aria-labelledby="source-story-title"
                >
                  <div className="compose-source__top">
                    <span className="compose-source__label">
                      <Newspaper className="size-4" aria-hidden />
                      Source story
                    </span>
                    <a
                      href={selected.link}
                      target="_blank"
                      rel="noreferrer"
                      className="compose-source__link"
                    >
                      Read original
                      <ArrowUpRight className="size-4" aria-hidden />
                    </a>
                  </div>
                  <div className="compose-source__body">
                    <h2 id="source-story-title" className="compose-source__title">
                      {selected.title}
                    </h2>
                    {selected.summary && (
                      <p className="compose-source__summary">{selected.summary}</p>
                    )}
                    <div className="compose-source__meta">
                      <span className="compose-source__source">
                        {selected.feed_title?.trim() || formatDomain(selected.link)}
                      </span>
                      <span>
                        {selected.created_at
                          ? `Ingested ${timeAgo(selected.created_at)}`
                          : 'Latest ingest'}
                      </span>
                    </div>
                  </div>
                </section>

                <section
                  className="compose-proof xl:col-start-1 xl:row-start-2"
                  aria-labelledby="draft-heading"
                >
                  <div className="compose-proof__header">
                    <h2 id="draft-heading" className="compose-proof__heading">
                      <span className="compose-proof__mark">
                        <PenLine className="size-4" aria-hidden />
                      </span>
                      Draft
                    </h2>
                    <div
                      className="compose-language"
                      role="group"
                      aria-label="Draft language"
                    >
                      {(['en', 'tl'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => changeLanguage(value)}
                          aria-pressed={language === value}
                          disabled={
                            editorLocked ||
                            drafting ||
                            publishing ||
                            scheduling ||
                            deleting
                          }
                        >
                          {value === 'en' ? 'English' : 'Tagalog'}
                        </button>
                      ))}
                    </div>
                    <div
                      id="draft-count"
                      className="compose-counts flex items-center gap-3"
                    >
                      <span>{words} words</span>
                      <span>{draft.length} chars</span>
                    </div>
                  </div>

                  {drafting && (
                    <div className="compose-proof__progress" aria-hidden>
                      <span />
                    </div>
                  )}

                  <div className="compose-proof__body">
                    {draftLoadFailed && !draft && (
                      <p
                        role="status"
                        className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                      >
                        Couldn&apos;t load your saved draft — the editor
                        started empty. Select the story again to retry.
                      </p>
                    )}
                    <div className="compose-proof__writing">
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        readOnly={editorLocked}
                        aria-busy={editorLocked}
                        aria-labelledby="draft-heading"
                        aria-describedby="draft-count"
                        placeholder="Generate a draft from the source story, or start writing here…"
                        className="min-h-[300px] w-full resize-y bg-transparent text-base leading-7 text-foreground outline-none placeholder:text-muted-foreground sm:min-h-[340px]"
                      />
                    </div>
                    <div className="compose-production">
                      <h3 className="compose-production__label">Narration & voice</h3>
                      <div className="space-y-3">
                      <NarrationModeSelector
                        mode={narrationMode}
                        onModeChange={changeNarrationMode}
                        disabled={
                          editorLocked ||
                          drafting ||
                          publishing ||
                          scheduling ||
                          deleting
                        }
                      />
                      {voiceOverEnabled ? (
                        <VoiceOverPanel
                          enabled
                          showToggle={false}
                          onEnabledChange={(enabled) =>
                            changeNarrationMode(enabled ? 'voice' : 'off')
                          }
                          voiceId={voiceId}
                          onVoiceChange={setVoiceId}
                          speed={speechSpeed}
                          onSpeedChange={setSpeechSpeed}
                          originalVolume={originalVolume}
                          onOriginalVolumeChange={setOriginalVolume}
                          showOriginalVolume={Boolean(videoFile)}
                          audio={narration}
                          generating={ttsGenerating}
                          error={ttsError}
                          stale={narrationStale}
                          hasMedia={hasMedia}
                          hasText={Boolean(speechText)}
                          disabled={
                            editorLocked ||
                            drafting ||
                            publishing ||
                            scheduling ||
                            deleting
                          }
                          onGenerate={() => void generateVoiceOver()}
                          onRemove={clearVoiceOver}
                          onDurationChange={(duration) =>
                            setNarration((current) =>
                              current ? { ...current, duration } : current
                            )
                          }
                        />
                      ) : null}
                      {narrationMode === 'avatar' ? (
                        <TalkingAvatarPanel
                          avatarId={avatarId}
                          onAvatarChange={changeAvatar}
                          voiceId={voiceId}
                          onVoiceChange={setVoiceId}
                          speed={speechSpeed}
                          onSpeedChange={setSpeechSpeed}
                          transparent={avatarTransparent}
                          onTransparentChange={setAvatarTransparent}
                          transparencySupported={transparencySupported}
                          job={avatarJob}
                          busy={Boolean(avatarAction)}
                          error={
                            avatarError ||
                            (avatarJob?.status === 'failed'
                              ? avatarJob.error ?? ''
                              : '')
                          }
                          stale={avatarStale}
                          hasText={Boolean(speechText)}
                          hasMedia={hasMedia}
                          disabled={
                            editorLocked ||
                            drafting ||
                            publishing ||
                            scheduling ||
                            deleting
                          }
                          onGenerate={() => void generateAvatar()}
                          onCancel={() => void cancelAvatar()}
                          onRemove={() => void removeAvatar()}
                        />
                      ) : null}
                      {avatarReady && hasMedia && avatarJob?.videoUrl ? (
                        <AvatarOverlayEditor
                          avatarUrl={avatarMediaUrl(avatarJob.id)}
                          baseVideoUrl={videoPreviewUrl}
                          images={images}
                          placement={avatarPlacement}
                          onPlacementChange={setAvatarPlacement}
                          originalAudioVolume={originalVolume}
                          onOriginalAudioVolumeChange={setOriginalVolume}
                          transparent={avatarJob.hasAlpha}
                          disabled={
                            editorLocked ||
                            drafting ||
                            publishing ||
                            scheduling ||
                            deleting
                          }
                        />
                      ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="compose-media">
                    <div className="compose-media__header">
                      <h3>Attachments</h3>
                      <span>
                        {videoFile ? '1 video' : `${images.length}/${MAX_IMAGES} images`}
                      </span>
                    </div>
                    {videoFile ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] font-medium">
                          <Play className="size-3 text-brand" aria-hidden />
                          <span className="max-w-[260px] truncate">
                            {videoFile.name}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => applyVideoFile(null)}
                          disabled={editorLocked}
                          aria-label="Remove video"
                          className="compose-remove tap-target grid size-6 place-items-center rounded-full border border-border bg-card text-faint shadow-sm transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                        <span
                          role="status"
                          aria-live="polite"
                          className="compose-hint ml-auto inline-flex items-center gap-1.5 tabular-nums"
                        >
                          {videoStaging ? (
                            <>
                              <Loader2
                                className="size-3 animate-spin"
                                aria-hidden
                              />
                              {videoPct != null
                                ? `Staging ${videoPct}%…`
                                : 'Staging video…'}
                            </>
                          ) : videoStagingFailed ? (
                            <span className="text-destructive">
                              Staging failed
                            </span>
                          ) : baking ? (
                            <>
                              <Loader2
                                className="size-3 animate-spin"
                                aria-hidden
                              />
                              {bakePct != null
                                ? `Rendering ${Math.round(bakePct * 100)}%…`
                                : voiceOverEnabled
                                  ? 'Baking voice-over…'
                                  : 'Baking animation…'}
                            </>
                          ) : videoUrl ? (
                            'Video ready'
                          ) : (
                            'Staging…'
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        {images.map((source, index) => (
                          <div
                            key={`${index}-${source.slice(-24)}`}
                            className="group relative"
                          >
                            <img
                              src={imageSrc(source)}
                              alt={`Attachment ${index + 1}`}
                              className="size-16 rounded-md border border-border object-cover"
                            />
                            <button
                              type="button"
                              onClick={() => removeImage(index)}
                              disabled={editorLocked}
                              aria-label={`Remove attachment ${index + 1}`}
                              className="compose-remove tap-target absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-faint shadow-sm transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <X className="size-3" aria-hidden />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => imageInputRef.current?.click()}
                          disabled={
                            imagesBusy || editorLocked || images.length >= MAX_IMAGES
                          }
                          aria-label="Add images to the post"
                          title={`Attach up to ${MAX_IMAGES} images`}
                          className="grid size-16 place-items-center rounded-md border border-dashed border-border text-faint transition-colors hover:border-brand/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {imagesBusy ? (
                            <RefreshCw
                              className="size-4 animate-spin"
                              aria-hidden
                            />
                          ) : (
                            <ImagePlus className="size-4" aria-hidden />
                          )}
                        </button>
                        <input
                          ref={imageInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          tabIndex={-1}
                          className="sr-only"
                          onChange={(event) =>
                            void addImages(event.target.files ?? [])
                          }
                        />
                        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                          {images.length}/{MAX_IMAGES} images
                        </span>
                      </div>
                    )}
                    {!videoFile && !images.length && (
                      <div className="mt-2">
                        <FilePicker
                          id="compose-video"
                          accept="video/mp4,video/quicktime"
                          label="Attach a video — optional"
                          hint="MP4/MOV · 1 GB max"
                          file={videoFile}
                          disabled={editorLocked}
                          onPick={applyVideoFile}
                          onClear={() => applyVideoFile(null)}
                          icon={<Upload className="size-3.5" />}
                          validate={(picked) =>
                            mediaFileError(picked, {
                              types: ['video/mp4', 'video/quicktime'],
                              extensions: ['.mp4', '.mov'],
                              typeLabel: 'an MP4 or MOV file',
                              maxBytes: MAX_VIDEO_BYTES,
                              maxLabel: '1 GB',
                            })
                          }
                        />
                      </div>
                    )}
                    {videoFile && videoPreviewUrl && !videoPreviewFailed && (
                      <VideoAnimationPicker
                        className="mt-3"
                        slots={animSlots}
                        loops={animLoops}
                        values={animValues}
                        disabled={videoStaging || baking || editorLocked}
                        onSelect={selectAnimation}
                        onLoopChange={(slot, loop) =>
                          setAnimLoops((current) => ({
                            ...current,
                            [slot]: loop,
                          }))
                        }
                        onFieldChange={setAnimationField}
                      />
                    )}
                  </div>

                  <div className="compose-actions">
                    <div className="w-full">
                      <PageSelector
                        pages={pages.pages}
                        selected={pages.selected}
                        onSelect={pages.selectOne}
                        loading={pages.loading}
                        disabled={editorLocked}
                      />
                    </div>
                    <div className="compose-hint mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
                      {stats ? (
                        <>
                          <span>Input {stats.inputTokens} tokens</span>
                          <span>Output {stats.outputTokens} tokens</span>
                          <span className="font-medium text-foreground/70">
                            ~{formatCost(stats.estimatedCost)}
                          </span>
                        </>
                      ) : null}
                    </div>

                    <div className="flex w-full flex-col items-end gap-2">
                      <div className="compose-actions__buttons w-full">
                        {draft ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={generateDraft}
                            disabled={
                              drafting ||
                              scheduling ||
                              publishing ||
                              deleting ||
                              !selected
                            }
                          >
                            <RefreshCw
                              className={cn(
                                'size-3.5',
                                drafting && 'animate-spin'
                              )}
                              aria-hidden
                            />
                            {drafting ? 'Regenerating…' : 'Regenerate'}
                          </Button>
                        ) : (
                          <Button
                            variant="brand"
                            size="sm"
                            onClick={generateDraft}
                            disabled={
                              drafting ||
                              scheduling ||
                              publishing ||
                              deleting ||
                              !selected
                            }
                          >
                            <Sparkles className="size-3.5" aria-hidden />
                            {drafting ? 'Drafting…' : 'Draft post'}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={copy}
                          disabled={!draft}
                        >
                          <Copy className="size-3.5" aria-hidden />
                          Copy
                        </Button>
                        <Button
                          variant="brand"
                          size="sm"
                          onClick={publish}
                          disabled={Boolean(publishUnavailableReason)}
                          title={
                            publishUnavailableReason ??
                            (canPublish
                              ? 'Posts to your Page immediately'
                              : 'Reconnect the Page to grant publishing permission')
                          }
                          aria-describedby={
                            publishUnavailableReason ? 'publish-hint' : undefined
                          }
                        >
                          <FacebookMark className="size-4" />
                          {publishButtonLabel(baking, bakePct, publishing)}
                        </Button>
                        <Button
                          ref={scheduleButtonRef}
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            scheduleOpen ? closeSchedulePanel() : setScheduleOpen(true)
                          }
                          disabled={
                            !draft ||
                            !facebook.connected ||
                            !pages.selected.length ||
                            scheduling ||
                            publishing ||
                            baking ||
                            imagesBusy ||
                            videoStaging ||
                            Boolean(videoFile && !videoUrl) ||
                            Boolean(narrationUnavailableReason) ||
                            selected?.status === 'published'
                          }
                          title={
                            publishUnavailableReason ??
                            'Choose when this post should be published'
                          }
                          aria-describedby={
                            publishUnavailableReason ? 'publish-hint' : undefined
                          }
                          aria-expanded={scheduleOpen}
                          aria-controls={scheduleOpen ? 'schedule-panel' : undefined}
                        >
                          <CalendarClock className="size-3.5" aria-hidden />
                          Schedule
                        </Button>
                        {selected?.draft_id ? (
                          confirmDelete ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => selected && deleteDraftFor(selected)}
                                disabled={
                                  deleting || scheduling || publishing || drafting
                                }
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                                {deleting ? 'Deleting…' : 'Confirm delete'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                              onClick={() => setConfirmDelete(false)}
                              disabled={
                                deleting || scheduling || publishing || drafting
                              }
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDelete(true)}
                              disabled={scheduling || publishing || drafting}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                              Delete draft
                            </Button>
                          )
                        ) : null}
                      </div>
                      {scheduleOpen && (
                        <div
                          id="schedule-panel"
                          role="group"
                          aria-label="Schedule post"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              closeSchedulePanel();
                            }
                          }}
                          className="compose-schedule flex flex-wrap items-center justify-end gap-2"
                        >
                          <label
                            htmlFor="scheduled-for"
                            className="compose-hint font-semibold"
                          >
                            Publish at
                          </label>
                          <input
                            ref={scheduleInputRef}
                            id="scheduled-for"
                            type="datetime-local"
                            aria-label="Publish date and time"
                            aria-invalid={Boolean(scheduleError || scheduleProblem)}
                            aria-describedby={
                              scheduleError || scheduleProblem
                                ? 'schedule-error'
                                : undefined
                            }
                            min={scheduleBounds(scheduleNow).min}
                            max={scheduleBounds(scheduleNow).max}
                            value={scheduledFor}
                            onChange={(event) => {
                              setScheduledFor(event.target.value);
                              setScheduleError('');
                            }}
                            className="h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          />
                          {(scheduleError || scheduleProblem) && (
                            <p
                              id="schedule-error"
                              role="alert"
                              className="w-full text-left text-xs text-destructive"
                            >
                              {scheduleError ?? scheduleProblem}
                            </p>
                          )}
                          {scheduleProblem && (
                            <button
                              type="button"
                              onClick={() => {
                                setScheduledFor(defaultScheduleValue());
                                setScheduleError('');
                              }}
                              className="text-[11px] font-medium text-brand underline underline-offset-2"
                            >
                              Reset to tomorrow 9:00
                            </button>
                          )}
                          <Button
                            size="sm"
                            variant="brand"
                            onClick={schedulePost}
                            disabled={
                              scheduling ||
                              drafting ||
                              deleting ||
                              publishing ||
                              imagesBusy ||
                              Boolean(narrationUnavailableReason)
                            }
                          >
                            {scheduling ? 'Scheduling…' : 'Confirm schedule'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={closeSchedulePanel}
                            disabled={dispatching || publishing}
                          >
                            {dispatching ? 'Sending…' : 'Cancel'}
                          </Button>
                        </div>
                      )}
                      <p
                        id="publish-hint"
                        role="status"
                        className="compose-hint text-right empty:sr-only"
                      >
                        {publishUnavailableReason}
                      </p>
                    </div>
                  </div>
                </section>

                <aside
                  className="compose-preview xl:col-start-2 xl:row-span-2"
                  aria-label="Publication preview"
                >
                  <div className="compose-preview__heading">
                    <h2>Publication proof</h2>
                    <span>Facebook</span>
                  </div>
                  {videoFile && videoPreviewUrl && !videoPreviewFailed ? (
                    <MediaPreviewCard
                      statusLabel={videoUrl ? 'Ready to publish' : 'Staging…'}
                      ready={Boolean(videoUrl)}
                      label="Video"
                      footer={
                        <p className="truncate text-[12px] font-semibold">
                          {videoFile.name}
                        </p>
                      }
                    >
                      <MediaPreviewMedia className="aspect-video">
                        <video
                          key={videoPreviewUrl}
                          ref={previewVideoRef}
                          src={videoPreviewUrl}
                          controls
                          playsInline
                          preload="metadata"
                          onError={() => setVideoPreviewFailed(true)}
                          className="h-full w-full object-contain"
                        />
                        <VideoAnimationOverlay
                          videoRef={previewVideoRef}
                          slots={animSlots}
                          loops={animLoops}
                          values={animValues}
                        />
                      </MediaPreviewMedia>
                    </MediaPreviewCard>
                  ) : (
                    <FacebookPreview
                      text={stripMarkdown(draft)}
                      imageUrls={images}
                      connected={facebook.connected}
                      pageName={
                        selectedPage?.name ?? facebook.page?.name
                      }
                      pagePicture={selectedPage?.picture}
                    />
                  )}
                </aside>

              </div>
            )}
          </div>
        </div>
      </div>

      {scheduleRetry.dialog}
      <AssistantChat
        draft={draft}
        storyId={selected?.id}
        disabled={scheduling || publishing}
        revision={composerRevision}
        // A reply can land after the attempt started; read the live lock from
        // the ref, not the render that sent the request. Before dispatch the
        // attempt is abandoned so the new text is what gets scheduled; after
        // dispatch the request already carries the old text, so the reply is
        // dropped rather than showing a draft that was not published.
        onDraftChange={(text) => {
          if (dispatchingRef.current) return false;
          if (publishingRef.current) return false;
          if (editorLockedRef.current) {
            scheduleAttempt.current += 1;
            scheduleRetry.cancel();
            setEditorLocked(false);
            setScheduling(false);
          }
          setDraft(text);
          return true;
        }}
        contextLabel="story draft"
      />
    </AppFrame>
  );
}

export default function ComposePage() {
  return (
    // useSearchParams opts the page out of prerendering without a boundary.
    <Suspense fallback={null}>
      <ComposeWorkspace />
    </Suspense>
  );
}
