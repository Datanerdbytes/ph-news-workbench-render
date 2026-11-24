'use client';

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle,
  ChevronDown,
  Clock,
  Compass,
  Edit2,
  Layers,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { AppFrame } from '@/components/app-frame';
import { statusMeta } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { formatDomain, timeAgo } from '@/lib/format';
import {
  manilaSourceDay,
  parseSourceItemFilters,
  SOURCE_ITEM_TIME_ZONE,
  SourceItemFilterError,
  type SourceItemFilters,
  type SourceItemRange,
} from '@/lib/source-item-filters';
import { fetchQueueItem } from '@/lib/story-queue';
import { ArchiveFilters } from './archive-filters';

type Feed = {
  id: number;
  workspace_id: string;
  url: string;
  title: string | null;
  category: string | null;
  last_fetched_at: string | null;
  error_message: string | null;
  enabled: boolean;
  created_at: string;
  item_count: number;
};

type SourceItem = {
  id: number;
  title: string;
  summary: string | null;
  link: string;
  image_url: string | null;
  published_at: string | null;
  created_at: string | null;
  feed_id: number | null;
  feed_title: string | null;
  status: string;
};

const UNGROUPED = 'Ungrouped';

function buildSourceItemsQuery(
  feedKey: string,
  filters: SourceItemFilters,
  before?: number,
): string {
  const params = new URLSearchParams();
  if (feedKey !== 'all') params.set('feed', feedKey);
  params.set('range', filters.range === 'today' ? 'day' : filters.range);
  if ((filters.range === 'today' || filters.range === 'day') && filters.date) {
    params.set('date', filters.date);
  }
  if (filters.range === 'month' && filters.month) params.set('month', filters.month);
  if (filters.query) params.set('q', filters.query);
  if (before) params.set('before', String(before));
  return params.toString();
}

function sourceItemsUrl(feedKey: string, filters: SourceItemFilters, before?: number): string {
  const query = buildSourceItemsQuery(feedKey, filters, before);
  return `/api/source-items${query ? `?${query}` : ''}`;
}

function sourceRangeLabel(filters: SourceItemFilters): string {
  if (filters.range === 'all') return 'All time';
  if (filters.range === 'today') return 'Today';
  if (filters.range === 'month' && filters.month) {
    return new Date(`${filters.month}-01T12:00:00+08:00`).toLocaleDateString('en-PH', {
      timeZone: SOURCE_ITEM_TIME_ZONE,
      month: 'long',
      year: 'numeric',
    });
  }
  if (filters.range === 'day' && filters.date) {
    return new Date(`${filters.date}T12:00:00+08:00`).toLocaleDateString('en-PH', {
      timeZone: SOURCE_ITEM_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return 'Selected dates';
}

function feedName(feed: Pick<Feed, 'title' | 'url'>): string {
  return feed.title?.trim() || formatDomain(feed.url);
}

/** Monogram tile standing in for a source avatar (feeds have no icon data). */
function SourceMark({
  feed,
  className,
}: {
  feed: Pick<Feed, 'title' | 'url'>;
  className?: string;
}) {
  const letter = (feedName(feed).match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md bg-brand text-[10px] font-semibold text-brand-foreground',
        className
      )}
    >
      {letter}
    </span>
  );
}

/** Display-only status for a feed (Active / Error / Disabled / Never fetched). */
function feedStatus(feed: Feed) {
  if (!feed.enabled) {
    return {
      label: 'Disabled',
      pill: 'border-border bg-secondary text-muted-foreground',
      icon: XCircle,
    };
  }
  if (feed.error_message) {
    return {
      label: 'Error',
      pill: 'border-destructive/20 bg-destructive/10 text-destructive',
      icon: AlertTriangle,
    };
  }
  if (!feed.last_fetched_at) {
    return {
      label: 'Never fetched',
      pill: 'border-border bg-card text-muted-foreground',
      icon: Clock,
    };
  }
  return {
    label: 'Active',
    pill: 'border-success/20 bg-success/10 text-success',
    icon: CheckCircle,
  };
}

function FeedStatusPill({ feed }: { feed: Feed }) {
  const status = feedStatus(feed);
  const Icon = status.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        status.pill
      )}
    >
      <Icon className="size-3" aria-hidden />
      {status.label}
    </span>
  );
}

function ArticleThumb({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    const letter = (title.match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase();
    return (
      <div className="grid h-full w-full place-items-center bg-secondary">
        <span className="font-heading text-lg text-faint" aria-hidden>
          {letter}
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote feed imagery with arbitrary hosts; the app renders remote media with plain img (see page-selection.tsx)
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
}

function ArticleRow({
  item,
  showSource,
  onDraft,
  drafting,
}: {
  item: SourceItem;
  showSource: boolean;
  onDraft: (item: SourceItem) => void;
  drafting: boolean;
}) {
  // Pending is the default state — only flag stories already handled.
  const meta = item.status !== 'pending' ? statusMeta(item.status) : null;
  const when = item.published_at ?? item.created_at;

  return (
    <article className="group flex gap-3.5 px-4 py-3.5 transition-colors hover:bg-surface-2/60 sm:px-5">
      <div className="h-[72px] w-[108px] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-secondary">
        <ArticleThumb src={item.image_url} title={item.title} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {meta && (
            <>
              <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden />
              {meta.label}
              <span aria-hidden>·</span>
            </>
          )}
          {showSource && (
            <>
              <span className="normal-case tracking-normal">
                {item.feed_title?.trim() || formatDomain(item.link)}
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          {when && <span className="normal-case tracking-normal">{timeAgo(when)}</span>}
        </div>
        <h3 className="mt-1 font-heading text-[15.5px] leading-snug tracking-[-0.01em] text-foreground/90">
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {item.title}
          </a>
        </h3>
        {item.summary && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {item.summary}
          </p>
        )}
        <div className="mt-2 flex items-center justify-end gap-2">
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Read original
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
          {item.status === 'pending' && (
            <Button
              variant="brand"
              size="sm"
              onClick={() => onDraft(item)}
              disabled={drafting}
              aria-busy={drafting}
              aria-label={`Draft "${item.title}" in Compose`}
              className="min-w-[64px]"
            >
              {drafting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Edit2 className="size-3.5" aria-hidden />
              )}
              {drafting ? 'Opening…' : 'Draft'}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function AddFeedDialog({
  open,
  onClose,
  onSubmit,
  submitting,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (url: string, category: string) => Promise<void>;
  submitting: boolean;
  categories: string[];
}) {
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await onSubmit(url.trim(), category.trim());
      setUrl('');
      setCategory('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add feed');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add RSS Feed" initialFocusRef={inputRef}>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="feed-url" className="text-[12px]">Feed URL</Label>
          <Input
            id="feed-url"
            ref={inputRef}
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className="h-9 text-[12px]"
            disabled={submitting}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="feed-group" className="text-[12px]">
            Group <span className="font-normal text-faint">(optional)</span>
          </Label>
          <Input
            id="feed-group"
            list="add-feed-group-options"
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="e.g. Tech, News"
            className="h-9 text-[12px]"
            disabled={submitting}
          />
          <datalist id="add-feed-group-options">
            {categories.map(categoryName => (
              <option key={categoryName} value={categoryName} />
            ))}
          </datalist>
        </div>
        {error && (
          <p className="text-[10.5px] text-destructive flex items-center gap-1">
            <AlertTriangle className="size-3" aria-hidden />
            {error}
          </p>
        )}
        <p className="text-[10.5px] text-muted-foreground">
          Paste an RSS or Atom feed URL — or just the site&apos;s address, and we&apos;ll try to find its feed.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !url.trim()}>
            {submitting ? 'Adding…' : 'Add feed'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditFeedDialog({
  open,
  onClose,
  feed,
  onSubmit,
  submitting,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  feed: Feed | null;
  onSubmit: (id: number, title: string, category: string) => Promise<void>;
  submitting: boolean;
  categories: string[];
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (feed) {
      setTitle(feed.title ?? '');
      setCategory(feed.category ?? '');
    }
  }, [feed]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feed) return;
    try {
      await onSubmit(feed.id, title.trim(), category.trim());
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update feed');
    }
  };

  return (
    <Modal
      open={open && Boolean(feed)}
      onClose={onClose}
      title="Edit Feed"
      initialFocusRef={inputRef}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="feed-title" className="text-[12px]">Feed Title</Label>
          <Input
            id="feed-title"
            ref={inputRef}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Feed title"
            className="h-9 text-[12px]"
            disabled={submitting}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-feed-group" className="text-[12px]">
            Group <span className="font-normal text-faint">(optional)</span>
          </Label>
          <Input
            id="edit-feed-group"
            list="edit-feed-group-options"
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="e.g. Tech, News"
            className="h-9 text-[12px]"
            disabled={submitting}
          />
          <datalist id="edit-feed-group-options">
            {categories.map(categoryName => (
              <option key={categoryName} value={categoryName} />
            ))}
          </datalist>
        </div>
        <p className="text-[10.5px] text-muted-foreground truncate">{feed?.url}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !title.trim()}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  confirming,
  feedTitle,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  confirming: boolean;
  feedTitle: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Delete Feed">
      <p className="mt-3 text-[12px] text-muted-foreground">
        Are you sure you want to delete <strong className="text-foreground">{feedTitle}</strong>?
        This will remove the feed from your sources. Previously fetched stories will remain in your queue.
      </p>
      <div className="flex justify-end gap-2 mt-5">
        <Button type="button" variant="ghost" onClick={onClose} disabled={confirming}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm} disabled={confirming}>
          {confirming ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </Modal>
  );
}

/** Day bucket for date-group headers, keyed by Manila calendar day. */
function dayKey(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return manilaSourceDay(date);
}

function dayLabel(key: string): string {
  const date = new Date(`${key}T12:00:00+08:00`);
  const today = manilaSourceDay(new Date());
  const diffDays = Math.round(
    (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${key}T00:00:00.000Z`)) / 86_400_000,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (key.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric';
  return date.toLocaleDateString('en-PH', { ...options, timeZone: SOURCE_ITEM_TIME_ZONE });
}

function SourcesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const feedParam = searchParams.get('feed');
  const today = manilaSourceDay(new Date());
  const filters = useMemo(() => {
    const now = new Date();
    try {
      return parseSourceItemFilters(searchParams, now);
    } catch (error) {
      if (error instanceof SourceItemFilterError) {
        return parseSourceItemFilters(new URLSearchParams(), now);
      }
      throw error;
    }
  }, [searchParams]);

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [feedsError, setFeedsError] = useState(false);

  // Selection mirrors ?feed=<id> so sources can be deep-linked; 'all' is the
  // default view. The effect keeps the back/forward buttons working.
  const [selectedKey, setSelectedKey] = useState(() =>
    feedParam && feedParam !== 'all' ? feedParam : 'all'
  );
  useEffect(() => {
    setSelectedKey(feedParam && feedParam !== 'all' ? feedParam : 'all');
  }, [feedParam]);

  const [items, setItems] = useState<SourceItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState(false);
  const [filteredTotal, setFilteredTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [draftingId, setDraftingId] = useState<number | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [deletingFeedId, setDeletingFeedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingIds, setFetchingIds] = useState<Set<number>>(new Set());
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());

  const loadFeeds = useCallback(async () => {
    try {
      const res = await fetch('/api/sources', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load feeds');
      const data = await res.json();
      setFeeds(data.feeds ?? []);
      setFeedsError(false);
    } catch (error) {
      setFeedsError(true);
      toast.error('Could not load sources', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setFeedsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  // Fall back to the "All sources" view when a deep-linked feed no longer
  // exists (deleted, or another workspace's id).
  const selectedFeed =
    selectedKey !== 'all' ? (feeds.find(feed => String(feed.id) === selectedKey) ?? null) : null;
  const effectiveKey =
    !feedsLoading && selectedKey !== 'all' && !selectedFeed ? 'all' : selectedKey;
  const selectedKeyRef = useRef(effectiveKey);
  const filtersRef = useRef(filters);
  const filterSignature = buildSourceItemsQuery(effectiveKey, filters);
  const itemsGeneration = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    selectedKeyRef.current = effectiveKey;
    filtersRef.current = filters;
  }, [effectiveKey, filters]);

  const loadItems = useCallback(async () => {
    const keyAtRequest = `${selectedKeyRef.current}|${buildSourceItemsQuery(selectedKeyRef.current, filtersRef.current)}`;
    const generation = Symbol();
    itemsGeneration.current = generation;
    const isCurrent = () =>
      keyAtRequest === `${selectedKeyRef.current}|${buildSourceItemsQuery(selectedKeyRef.current, filtersRef.current)}`
      && generation === itemsGeneration.current;
    setItemsLoading(true);
    setItemsError(false);
    setFilteredTotal(null);
    setLoadingMore(false);
    setNextCursor(null);
    setHasMore(false);
    try {
      const res = await fetch(sourceItemsUrl(selectedKeyRef.current, filtersRef.current), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load stories');
      const data = await res.json();
      if (!isCurrent()) return;
      setItems(data.rows ?? []);
      setFilteredTotal(data.total);
      setNextCursor(typeof data.nextCursor === 'number' ? data.nextCursor : null);
      setHasMore(Boolean(data.hasMore));
    } catch {
      if (!isCurrent()) return;
      setItemsError(true);
    } finally {
      if (isCurrent()) setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems, effectiveKey, filterSignature]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || itemsLoading) return;
    const keyAtRequest = `${selectedKeyRef.current}|${buildSourceItemsQuery(selectedKeyRef.current, filtersRef.current)}`;
    const generation = itemsGeneration.current;
    if (!generation) return;
    const isCurrent = () =>
      keyAtRequest === `${selectedKeyRef.current}|${buildSourceItemsQuery(selectedKeyRef.current, filtersRef.current)}`
      && generation === itemsGeneration.current;
    setLoadingMore(true);
    try {
      const res = await fetch(sourceItemsUrl(selectedKeyRef.current, filtersRef.current, nextCursor), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load stories');
      const data = await res.json();
      if (!isCurrent()) return;
      setItems(prev => {
        const seen = new Set(prev.map(item => item.id));
        return [...prev, ...(data.rows ?? []).filter((item: SourceItem) => !seen.has(item.id))];
      });
      setFilteredTotal(data.total);
      setNextCursor(typeof data.nextCursor === 'number' ? data.nextCursor : null);
      setHasMore(Boolean(data.hasMore));
    } catch {
      if (isCurrent()) toast.error('Could not load more stories');
    } finally {
      if (isCurrent()) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, itemsLoading]);

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `/sources?${query}` : '/sources', { scroll: false });
  }, [router, searchParams]);

  const select = useCallback((key: string) => {
    setSelectedKey(key);
    updateUrl({ feed: key === 'all' ? null : key });
  }, [updateUrl]);

  const changeRange = useCallback((range: SourceItemRange) => {
    updateUrl({
      range: range === 'today' ? null : range,
      date: range === 'day' ? today : null,
      month: range === 'month' ? today.slice(0, 7) : null,
    });
  }, [today, updateUrl]);

  const changeDate = useCallback((date: string) => {
    if (date) updateUrl({ date });
  }, [updateUrl]);

  const changeMonth = useCallback((month: string) => {
    if (month) updateUrl({ month });
  }, [updateUrl]);

  const changeQuery = useCallback((query: string) => {
    updateUrl({ q: query || null });
  }, [updateUrl]);

  const resetFilters = useCallback(() => {
    updateUrl({ range: null, date: null, month: null, q: null });
  }, [updateUrl]);

  const totalCount = useMemo(
    () => feeds.reduce((sum, feed) => sum + feed.item_count, 0),
    [feeds]
  );

  const groups = useMemo(() => {
    const map = new Map<string, Feed[]>();
    for (const feed of feeds) {
      const label = feed.category?.trim() || UNGROUPED;
      const bucket = map.get(label);
      if (bucket) bucket.push(feed);
      else map.set(label, [feed]);
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [feeds]);

  const categories = useMemo(
    () => groups.map(([label]) => label).filter(label => label !== UNGROUPED),
    [groups]
  );

  // Date-grouped sections, newest first (items arrive id DESC and the
  // grouping preserves that order).
  const sections = useMemo(() => {
    const map = new Map<string, SourceItem[]>();
    for (const item of items) {
      const key = dayKey(item.published_at) ?? 'undated';
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()].map(([key, rows]) => ({
      key,
      label: key === 'undated' ? 'Undated' : dayLabel(key),
      rows,
    }));
  }, [items]);

  async function refresh() {
    setRefreshing(true);
    await loadFeeds();
    setRefreshing(false);
  }

  const handleAddFeed = async (url: string, category: string) => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, category }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add feed');
      toast.success('Feed added', { description: `${data.feed.title ?? 'Feed'} has been added.` });
      await loadFeeds();
      select(String(data.feed.id));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditFeed = async (id: number, title: string, category: string) => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, category }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to update feed');
      toast.success('Feed updated');
      await loadFeeds();
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleFeed = async (id: number, enabled: boolean) => {
    setTogglingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to update feed');
      toast.success(enabled ? 'Feed enabled' : 'Feed disabled');
      await loadFeeds();
    } catch (error) {
      toast.error('Could not update feed', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleFetchNow = async (id: number) => {
    setFetchingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/sources/${id}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to fetch feed');
      toast.success('Feed fetched', {
        description: `${data.ingested ?? 0} new stories · ${data.skipped ?? 0} already seen`,
      });
      await loadFeeds();
      if (String(id) === selectedKeyRef.current) await loadItems();
    } catch (error) {
      toast.error('Could not fetch feed', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setFetchingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const confirmDelete = async () => {
    if (!deletingFeedId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sources/${deletingFeedId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete feed');
      toast.success('Feed deleted');
      if (String(deletingFeedId) === selectedKey) select('all');
      await loadFeeds();
    } catch (error) {
      toast.error('Could not delete feed', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setSubmitting(false);
      setDeletingFeedId(null);
      setDeleteDialogOpen(false);
    }
  };

  const openEditDialog = (feed: Feed) => {
    setEditingFeed(feed);
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (feed: Feed) => {
    setDeletingFeedId(feed.id);
    setDeleteDialogOpen(true);
  };

  // "Draft" opens the story in Compose, same flow as the queue's Add: the
  // single-item fetch validates the story still exists before navigating.
  const draftInCompose = async (item: SourceItem) => {
    if (draftingId !== null) return;
    setDraftingId(item.id);
    try {
      const fresh = await fetchQueueItem(item.id);
      if (!fresh) throw new Error('Story not found');
      router.push(`/compose?item=${item.id}`);
    } catch (error) {
      toast.error('Could not open the story in Compose', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
      setDraftingId(null);
    }
  };

  const isAll = effectiveKey === 'all';
  const headerTotal = filteredTotal;

  const sourceRowBase =
    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  return (
    <AppFrame fill>
      <div className="flex min-h-0 flex-1">
        {/* Sources sidebar (desktop) */}
        <aside className="hidden w-[264px] shrink-0 flex-col border-r border-border/70 bg-surface-2/40 md:flex">
          <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-3.5">
            <p className="eyebrow px-1">Sources</p>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-busy={refreshing}
                aria-label="Refresh sources"
              >
                <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => router.push('/sources/discover')}
                aria-label="Discover sources"
              >
                <Compass className="size-3.5" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setAddDialogOpen(true)}
                aria-label="Add source"
              >
                <Plus className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
          <nav
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
            aria-label="Source list"
          >
            {feedsLoading ? (
              <div className="animate-pulse space-y-1.5">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-2 px-2 py-1.5">
                    <div className="size-6 rounded-md bg-muted" />
                    <div className="h-3 flex-1 rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => select('all')}
                  aria-current={isAll}
                  className={cn(
                    sourceRowBase,
                    isAll
                      ? 'bg-brand-soft font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-card hover:text-foreground'
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-card">
                    <Layers className="size-3.5 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate">All sources</span>
                  <span className="text-[10.5px] tabular-nums text-faint">{totalCount}</span>
                </button>
                {groups.map(([label, groupFeeds]) => (
                  <div key={label} className="mt-3">
                    <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                      {label}
                    </p>
                    <div className="space-y-0.5">
                      {groupFeeds.map(feed => {
                        const active = String(feed.id) === effectiveKey;
                        return (
                          <button
                            key={feed.id}
                            type="button"
                            onClick={() => select(String(feed.id))}
                            aria-current={active}
                            className={cn(
                              sourceRowBase,
                              active
                                ? 'bg-brand-soft font-semibold text-foreground'
                                : 'text-muted-foreground hover:bg-card hover:text-foreground',
                              !feed.enabled && !active && 'opacity-55'
                            )}
                          >
                            <SourceMark feed={feed} />
                            <span className="min-w-0 flex-1 truncate">{feedName(feed)}</span>
                            {feed.error_message && (
                              <AlertTriangle
                                className="size-3 shrink-0 text-destructive"
                                aria-label="Fetch error"
                              />
                            )}
                            <span className="text-[10.5px] tabular-nums text-faint">
                              {feed.item_count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            )}
          </nav>
        </aside>

        {/* Main pane */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Mobile top bar + source chips */}
          <div className="shrink-0 border-b border-border/70 md:hidden">
            <div className="flex items-center justify-between px-4 py-3">
              <h1 className="font-heading text-lg font-semibold tracking-tight">Sources</h1>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => router.push('/sources/discover')}
                  aria-label="Discover sources"
                >
                  <Compass className="size-3.5" aria-hidden />
                </Button>
                <Button size="sm" onClick={() => setAddDialogOpen(true)}>
                  <Plus className="size-3.5" aria-hidden />
                  Add source
                </Button>
              </div>
            </div>
            <div
              className="flex items-center gap-1 overflow-x-auto px-4 pb-2"
              role="group"
              aria-label="Browse by source"
            >
              {feedsLoading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-7 w-24 shrink-0 animate-pulse rounded-full bg-muted" />
                ))
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => select('all')}
                    aria-pressed={isAll}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                      isAll
                        ? 'bg-ink text-paper'
                        : 'text-muted-foreground hover:bg-card hover:text-foreground'
                    )}
                  >
                    All sources
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {totalCount}
                    </span>
                  </button>
                  {feeds.map(feed => {
                    const active = String(feed.id) === effectiveKey;
                    return (
                      <button
                        key={feed.id}
                        type="button"
                        onClick={() => select(String(feed.id))}
                        aria-pressed={active}
                        className={cn(
                          'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                          active
                            ? 'bg-ink text-paper'
                            : 'text-muted-foreground hover:bg-card hover:text-foreground'
                        )}
                      >
                        <span className="max-w-[180px] truncate">{feedName(feed)}</span>
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                            active ? 'bg-paper/20 text-paper' : 'bg-secondary text-muted-foreground'
                          )}
                        >
                          {feed.item_count}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Source header */}
          <header className="shrink-0 border-b border-border/70 bg-card/50">
            <div className="mx-auto w-full max-w-[900px] px-4 py-4 sm:px-6">
              {feedsError ? (
                <ErrorState
                  compact
                  title="Couldn't load your sources"
                  onRetry={loadFeeds}
                />
              ) : isAll ? (
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-brand-foreground">
                    <Layers className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h1 className="font-heading text-xl font-semibold tracking-tight">
                      All sources
                    </h1>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {feeds.length} {feeds.length === 1 ? 'source' : 'sources'} ·{' '}
                      {headerTotal ?? '—'} {headerTotal === 1 ? 'story' : 'stories'}
                    </p>
                  </div>
                </div>
              ) : selectedFeed ? (
                <div>
                  <div className="flex items-start gap-3">
                    <SourceMark feed={selectedFeed} className="size-10 rounded-xl text-sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h1 className="font-heading text-xl font-semibold tracking-tight">
                          {feedName(selectedFeed)}
                        </h1>
                        <FeedStatusPill feed={selectedFeed} />
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {formatDomain(selectedFeed.url)} · {headerTotal ?? '—'} in this view
                        {selectedFeed.last_fetched_at &&
                          ` · last fetched ${timeAgo(selectedFeed.last_fetched_at)}`}
                        {selectedFeed.category?.trim() && ` · ${selectedFeed.category.trim()}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFetchNow(selectedFeed.id)}
                        disabled={fetchingIds.has(selectedFeed.id) || !selectedFeed.enabled}
                        aria-busy={fetchingIds.has(selectedFeed.id)}
                      >
                        <RefreshCw
                          className={cn(
                            'size-3.5',
                            fetchingIds.has(selectedFeed.id) && 'animate-spin'
                          )}
                          aria-hidden
                        />
                        Fetch now
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEditDialog(selectedFeed)}
                        aria-label="Edit feed"
                        disabled={togglingIds.has(selectedFeed.id)}
                      >
                        <Edit2 className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleToggleFeed(selectedFeed.id, !selectedFeed.enabled)}
                        aria-label={selectedFeed.enabled ? 'Disable feed' : 'Enable feed'}
                        disabled={togglingIds.has(selectedFeed.id)}
                      >
                        {selectedFeed.enabled ? (
                          <XCircle className="size-3.5 text-muted-foreground" aria-hidden />
                        ) : (
                          <CheckCircle className="size-3.5 text-success" aria-hidden />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openDeleteDialog(selectedFeed)}
                        aria-label="Delete feed"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={fetchingIds.has(selectedFeed.id) || togglingIds.has(selectedFeed.id)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  {selectedFeed.error_message && (
                    <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span>{selectedFeed.error_message}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </header>

          <ArchiveFilters
            range={filters.range}
            date={filters.date ?? today}
            month={filters.month ?? today.slice(0, 7)}
            query={filters.query}
            today={today}
            busy={itemsLoading}
            onRangeChange={changeRange}
            onDateChange={changeDate}
            onMonthChange={changeMonth}
            onQueryChange={changeQuery}
            onReset={resetFilters}
          />

          {/* Article list */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-[900px] px-4 py-4 sm:px-6 sm:py-5">
              <div
                className="mb-3 flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted-foreground"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <p>
                  {itemsLoading
                    ? 'Loading stories…'
                    : itemsError
                      ? 'Stories unavailable'
                      : `${headerTotal} ${headerTotal === 1 ? 'story' : 'stories'} in this view`}
                </p>
                <p>{sourceRangeLabel(filters)} · PHT</p>
              </div>
              {itemsLoading ? (
                <div className="animate-pulse overflow-hidden rounded-xl border border-border/80 bg-card">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="flex gap-3.5 border-b border-border/60 px-4 py-3.5 last:border-b-0 sm:px-5">
                      <div className="h-[72px] w-[108px] shrink-0 rounded-lg bg-muted" />
                      <div className="min-w-0 flex-1 py-1">
                        <div className="h-2 w-24 rounded bg-muted" />
                        <div className="mt-2 h-3.5 w-full rounded bg-muted" />
                        <div className="mt-1.5 h-3.5 w-4/5 rounded bg-muted" />
                        <div className="mt-2.5 h-2.5 w-full rounded bg-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : itemsError ? (
                <ErrorState
                  title="Couldn't load stories"
                  description="The articles for this source just couldn't be fetched right now."
                  onRetry={loadItems}
                />
              ) : feeds.length === 0 && items.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
                  <div className="mx-auto grid size-11 place-items-center rounded-full bg-secondary">
                    <Rss className="size-5 text-muted-foreground" aria-hidden />
                  </div>
                  <h2 className="mt-4 font-heading text-xl">No sources yet</h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                    Add your first RSS feed to start pulling stories into your feed.
                  </p>
                  <Button variant="brand" size="sm" className="mt-4" onClick={() => setAddDialogOpen(true)}>
                    <Plus className="size-3.5" aria-hidden />
                    Add your first feed
                  </Button>
                </div>
              ) : sections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
                  <Newspaper className="mx-auto size-5 text-faint/60" aria-hidden />
                  <p className="mt-2 text-sm font-medium">
                    {filters.query
                      ? `No stories match “${filters.query}”`
                      : filters.range === 'all'
                        ? (isAll ? 'No stories yet' : 'No stories from this source yet')
                        : `No stories for ${sourceRangeLabel(filters).toLowerCase()}`}
                  </p>
                  <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                    {filters.query
                      ? 'Try another topic or name, search all time, or clear your search.'
                      : 'Try another day or month, browse all time, or fetch the latest articles.'}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {filters.query && (
                      <Button variant="outline" size="sm" onClick={() => changeQuery('')}>
                        Clear search
                      </Button>
                    )}
                    {filters.range !== 'all' && (
                      <Button variant="outline" size="sm" onClick={() => changeRange('all')}>
                        Browse all time
                      </Button>
                    )}
                    {!isAll && selectedFeed?.enabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFetchNow(selectedFeed.id)}
                        disabled={fetchingIds.has(selectedFeed.id)}
                        aria-busy={fetchingIds.has(selectedFeed.id)}
                      >
                        <RefreshCw
                          className={cn('size-3.5', fetchingIds.has(selectedFeed.id) && 'animate-spin')}
                          aria-hidden
                        />
                        Fetch now
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col">
                    {sections.map(section => (
                      <section key={section.key} className="mt-4 first:mt-0">
                        <h2 className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                          {section.label}
                        </h2>
                        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80 bg-card paper-shadow-sm">
                          {section.rows.map(item => (
                            <ArticleRow
                              key={item.id}
                              item={item}
                              showSource={isAll}
                              onDraft={item => void draftInCompose(item)}
                              drafting={draftingId === item.id}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  <footer className="mt-4">
                    {hasMore ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        aria-busy={loadingMore}
                        className="w-full"
                      >
                        {loadingMore ? (
                          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <ChevronDown className="size-3.5" aria-hidden />
                        )}
                        {loadingMore ? 'Loading…' : 'Load more stories'}
                      </Button>
                    ) : (
                      <p className="py-1 text-center text-[10.5px] text-muted-foreground">
                        {filters.range === 'all' && !filters.query
                          ? 'All stories loaded'
                          : 'All matching stories loaded'}
                      </p>
                    )}
                    <p className="mt-1.5 text-center text-[10px] tabular-nums text-muted-foreground">
                      {items.length} loaded · {headerTotal} total
                    </p>
                  </footer>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <AddFeedDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={handleAddFeed}
        submitting={submitting}
        categories={categories}
      />
      <EditFeedDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setEditingFeed(null);
        }}
        feed={editingFeed}
        onSubmit={handleEditFeed}
        submitting={submitting}
        categories={categories}
      />
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onClose={() => {
          setDeleteDialogOpen(false);
          setDeletingFeedId(null);
        }}
        onConfirm={confirmDelete}
        confirming={submitting}
        feedTitle={
          feeds.find(feed => feed.id === deletingFeedId)?.title ?? 'this feed'
        }
      />
    </AppFrame>
  );
}

export default function SourcesPage() {
  // useSearchParams opts the page out of prerendering without a boundary.
  return (
    <Suspense fallback={null}>
      <SourcesPageInner />
    </Suspense>
  );
}
