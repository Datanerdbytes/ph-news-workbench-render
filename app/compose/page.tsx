'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Copy,
  ImagePlus,
  Newspaper,
  PenLine,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { AppFrame } from '@/components/app-frame';
import { AssistantChat } from '@/components/assistant-chat';
import { FacebookMark } from '@/components/facebook-mark';
import { useFacebookConnection } from '@/components/facebook-connection';
import { FacebookPreview } from '@/components/facebook-preview';
import {
  ComposerCard,
  PageSelector,
  defaultScheduleValue,
  scheduleBounds,
  useManagedPages,
  useScheduleClock,
} from '@/components/publishing/publish-page';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import { StatusPill, statusMeta } from '@/components/status-pill';
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
import { fetchQueueItem, fetchQueuePage, type QueueItem } from '@/lib/story-queue';

type DraftStats = {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function WorkspaceSkeleton() {
  return (
    <div className="animate-pulse space-y-5">
      <div className="rounded-xl border border-border/80 bg-card p-5">
        <div className="h-2 w-24 rounded bg-muted" />
        <div className="mt-4 h-6 w-3/4 rounded bg-muted" />
        <div className="mt-2 h-6 w-1/2 rounded bg-muted" />
        <div className="mt-4 h-3 w-full rounded bg-muted" />
        <div className="mt-2 h-3 w-4/5 rounded bg-muted" />
      </div>
      <div className="rounded-xl border border-border/80 bg-card p-5">
        <div className="h-3 w-16 rounded bg-muted" />
        <div className="mt-4 h-[220px] w-full rounded bg-muted/60" />
      </div>
    </div>
  );
}

function EmptyWorkspace({ onOpenQueue }: { onOpenQueue: () => void }) {
  return (
    <div className="grid min-h-[55vh] place-items-center rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-11 place-items-center rounded-full bg-secondary">
          <Newspaper className="size-5 text-faint" aria-hidden />
        </span>
        <h2 className="mt-4 font-heading text-2xl">The desk is quiet</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Pick a story from the Story Queue to start drafting.
        </p>
        <Button
          variant="brand"
          size="sm"
          className="mt-4"
          onClick={onOpenQueue}
        >
          <Newspaper className="size-3.5" aria-hidden />
          Open Story Queue
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
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [draft, setDraft] = useState('');
  const [stats, setStats] = useState<DraftStats | null>(null);
  const [language, setLanguage] = useState<'en' | 'tl'>('en');
  const [images, setImages] = useState<string[]>([]);
  const [imagesBusy, setImagesBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<number | null>(null);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduling, setScheduling] = useState(false);
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
          const next = rows.find((item) => item.id === prev.id);
          if (next) return next;
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

  useEffect(() => {
    if (selectedId === lastLoadedIdRef.current) return;
    lastLoadedIdRef.current = selectedId ?? null;
    selectionRef.current = selectedId ?? null;
    setDraft('');
    setStats(null);
    setImages([]);
    setConfirmDelete(false);
    setScheduleOpen(false);
    setDraftLoadFailed(false);
    if (selected?.draft_id) void loadSavedDraft(selected);
  }, [selectedId, selected, loadSavedDraft]);

  async function generateDraft() {
    if (!selected) return;
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
    const schedule = resolveScheduledFor(scheduledFor);
    if (schedule.iso === null) {
      setScheduleError(schedule.error);
      return;
    }
    setScheduleError('');
    setScheduling(true);
    try {
      const when = new Date(schedule.iso);
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newsItemId: selected.id,
          draftId: selected.draft_id ?? undefined,
          text: draft,
          imageUrls: images,
          scheduledFor: schedule.iso,
          pageId: pages.selected[0],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not schedule the post.');
      toast.success('Post scheduled', {
        description: when.toLocaleString('en-PH', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
      });
      setScheduleOpen(false);
      // Refresh the queue so the row's status stops showing its pre-schedule state.
      await load();
    } catch (error) {
      toast.error('Scheduling failed', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setScheduling(false);
    }
  }

  async function deleteDraftFor(item: QueueItem) {
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
        setStats(null);
        setImages([]);
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

    if (!facebook.scopes.includes('pages_manage_posts')) {
      toast.error('Publishing permission missing', {
        description: 'Reconnect the Page so it can publish on your behalf.',
        action: { label: 'Reconnect', onClick: () => facebook.connect() },
      });
      return;
    }

    setPublishing(true);
    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newsItemId: selected.id,
          message: draft,
          imageUrls: images,
          pageId: pages.selected[0],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'The post could not be published.');
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

  const selectedMeta = selected ? statusMeta(selected.status) : null;
  const words = wordCount(draft);

  const canPublish = facebook.scopes.includes('pages_manage_posts');
  const publishHint = facebook.loading
    ? 'Checking Facebook connection…'
    : !facebook.configured
      ? 'Add Facebook app credentials to enable publishing'
      : !facebook.connected
        ? 'Connect your Facebook Page to publish'
        : selected?.status === 'published'
          ? 'This story is already published'
          : !canPublish
            ? 'Reconnect the Page to grant publishing permission'
            : !draft
              ? 'Write or generate a draft to publish'
              : 'Posts to your Page immediately';

  return (
    <AppFrame fill>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-3 sm:px-6">
          <Link
            href="/queue"
            aria-label="Back to Story Queue"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            <span className="hidden text-[11.5px] font-medium sm:inline">
              Story Queue
            </span>
          </Link>
          <div className="min-w-0">
            <p className="eyebrow text-brand">Compose</p>
            <h1 className="truncate text-sm font-semibold">
              {selected ? selected.title : 'Select a story to begin'}
            </h1>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[1180px] p-4 sm:p-6">
            {itemsLoading ? (
              <WorkspaceSkeleton />
            ) : loadError ? (
              <ErrorState
                title="Couldn't load the news feed"
                description="Your stories are safe — the feed just couldn't be fetched right now."
                onRetry={load}
              />
            ) : !selected ? (
              <EmptyWorkspace onOpenQueue={() => router.push('/queue')} />
            ) : (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
                <ComposerCard
                  className="xl:col-start-1 xl:row-start-1"
                  icon={<Newspaper className="size-4" />}
                  title="Source story"
                  headerRight={
                    <>
                      <StatusPill status={selected.status} />
                      <a
                        href={selected.link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Read original
                        <ArrowUpRight className="size-3.5" aria-hidden />
                      </a>
                    </>
                  }
                >
                  <h2 className="text-balance font-heading text-[24px] leading-[1.2] tracking-[-0.015em]">
                    {selected.title}
                  </h2>
                  {selected.summary && (
                    <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                      {selected.summary}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/70">
                      {selected.feed_title?.trim() || formatDomain(selected.link)}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {selected.created_at
                        ? `Ingested ${timeAgo(selected.created_at)}`
                        : 'Latest ingest'}
                    </span>
                    {selectedMeta && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{selectedMeta.label}</span>
                      </>
                    )}
                  </div>
                </ComposerCard>

                <section className="overflow-hidden rounded-xl border border-border/80 bg-card paper-shadow-sm xl:col-start-1 xl:row-start-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3">
                    <div className="flex items-center gap-2">
                      <PenLine className="size-4 text-brand" aria-hidden />
                      <span className="text-sm font-semibold">Draft</span>
                      <div
                        className="inline-flex items-center rounded-lg border border-border/80 bg-card p-0.5 shadow-paper-sm"
                        role="group"
                        aria-label="Draft language"
                      >
                        {(['en', 'tl'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setLanguage(value)}
                            aria-pressed={language === value}
                            title={value === 'en' ? 'English' : 'Tagalog'}
                            className={cn(
                              'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                              language === value
                                ? 'bg-ink text-paper'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            {value.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
                      <span>{words} words</span>
                      <span>{draft.length} chars</span>
                    </div>
                  </div>

                  {drafting && (
                    <div className="h-0.5 w-full overflow-hidden bg-brand/15">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
                    </div>
                  )}

                  <div className="p-5">
                    {draftLoadFailed && !draft && (
                      <p
                        role="status"
                        className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
                      >
                        Couldn&apos;t load your saved draft — the editor
                        started empty. Select the story again to retry.
                      </p>
                    )}
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Generate a draft from the source story, or start writing here…"
                      aria-label="Facebook post draft"
                      className="min-h-[260px] w-full resize-y bg-transparent text-[15px] leading-7 text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="border-t border-border/60 px-5 py-3">
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
                            aria-label={`Remove attachment ${index + 1}`}
                            className="tap-target absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-faint shadow-sm transition-colors hover:border-destructive/40 hover:text-destructive"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        disabled={imagesBusy || images.length >= MAX_IMAGES}
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
                  </div>

                  <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border/60 bg-muted/30 px-5 py-3">
                    <div className="w-full -mb-1">
                      <PageSelector
                        pages={pages.pages}
                        selected={pages.selected}
                        onSelect={pages.selectOne}
                        loading={pages.loading}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                      {stats ? (
                        <>
                          <span>Input {stats.inputTokens} tokens</span>
                          <span>Output {stats.outputTokens} tokens</span>
                          <span className="font-medium text-foreground/70">
                            ~{formatCost(stats.estimatedCost)}
                          </span>
                        </>
                      ) : (
                        <span>No generation yet</span>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {draft ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={generateDraft}
                            disabled={drafting || !selected}
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
                            disabled={drafting || !selected}
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
                          disabled={
                            !draft ||
                            !facebook.connected ||
                            !pages.selected.length ||
                            publishing ||
                            selected?.status === 'published'
                          }
                          title={publishHint}
                          aria-describedby="publish-hint"
                        >
                          <FacebookMark className="size-4" />
                          {publishing ? 'Publishing…' : 'Publish'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setScheduleOpen((open) => !open)}
                          disabled={
                            !draft ||
                            !facebook.connected ||
                            !pages.selected.length ||
                            selected?.status === 'published'
                          }
                          aria-expanded={scheduleOpen}
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
                                disabled={deleting}
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                                {deleting ? 'Deleting…' : 'Confirm delete'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmDelete(false)}
                                disabled={deleting}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDelete(true)}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                              Delete draft
                            </Button>
                          )
                        ) : null}
                      </div>
                      {scheduleOpen && (
                        <div className="mt-1 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-card p-2 shadow-sm">
                          <label
                            htmlFor="scheduled-for"
                            className="text-[10.5px] font-medium text-muted-foreground"
                          >
                            Publish at
                          </label>
                          <input
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
                            className="h-8 rounded-md border border-input bg-background px-2 text-[11.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          />
                          {(scheduleError || scheduleProblem) && (
                            <p
                              id="schedule-error"
                              role="alert"
                              className="w-full text-right text-[11px] text-destructive"
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
                            disabled={scheduling}
                          >
                            {scheduling ? 'Scheduling…' : 'Confirm schedule'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setScheduleOpen(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                      <p
                        id="publish-hint"
                        className="text-[10px] text-muted-foreground"
                      >
                        {publishHint}
                      </p>
                    </div>
                  </div>
                </section>

                <div className="xl:col-start-2 xl:row-span-2 xl:sticky xl:top-5">
                  <FacebookPreview
                    text={stripMarkdown(draft)}
                    imageUrls={images}
                    connected={facebook.connected}
                    pageName={
                      selectedPage?.name ?? facebook.page?.name
                    }
                    pagePicture={selectedPage?.picture}
                  />
                </div>

              </div>
            )}
          </div>
        </div>
      </div>

      <AssistantChat
        draft={draft}
        storyId={selected?.id}
        onDraftChange={setDraft}
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
