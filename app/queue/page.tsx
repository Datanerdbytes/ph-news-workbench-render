'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  ChevronDown,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { AppFrame } from '@/components/app-frame';
import { Button } from '@/components/ui/button';
import { ConfirmIconButton } from '@/components/ui/confirm-button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { statusMeta } from '@/components/status-pill';
import { formatDomain, formatLongDate, timeAgo } from '@/lib/format';
import {
  fetchQueueItem,
  fetchQueuePage,
  type FeedCounts,
  type QueueCounts,
  type QueueItem,
} from '@/lib/story-queue';

type StatusFilter = 'all' | 'pending' | 'drafted' | 'published';

type SourceFeed = {
  id: number;
  title: string | null;
  url: string;
  enabled: boolean;
};

type SourceTab = {
  key: string;
  label: string;
  feedId: number | null;
};

const ZERO_COUNTS: QueueCounts = {
  total: 0,
  pending: 0,
  drafted: 0,
  published: 0,
};

function EmptyDesk({
  onRefresh,
  onOpenSources,
  hasFeeds,
}: {
  onRefresh: () => void;
  onOpenSources: () => void;
  hasFeeds: boolean;
}) {
  return (
    <div className="grid min-h-[55vh] place-items-center rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-11 place-items-center rounded-full bg-secondary">
          {hasFeeds ? (
            <Newspaper className="size-5 text-faint" aria-hidden />
          ) : (
            <Rss className="size-5 text-faint" aria-hidden />
          )}
        </span>
        <h2 className="mt-4 font-heading text-2xl">
          {hasFeeds ? 'The desk is quiet' : 'No sources yet'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {hasFeeds
            ? 'Pull the latest stories from your sources to start drafting.'
            : 'Add RSS feeds on the Sources page and their stories will land here.'}
        </p>
        {hasFeeds ? (
          <Button variant="brand" size="sm" className="mt-4" onClick={onRefresh}>
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh feeds
          </Button>
        ) : (
          <Button
            variant="brand"
            size="sm"
            className="mt-4"
            onClick={onOpenSources}
          >
            <Rss className="size-3.5" aria-hidden />
            Go to Sources
          </Button>
        )}
      </div>
    </div>
  );
}

export default function QueuePage() {
  const router = useRouter();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [feeds, setFeeds] = useState<SourceFeed[]>([]);
  const [activeTab, setActiveTab] = useState('all');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [itemsLoading, setItemsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState<QueueCounts>(ZERO_COUNTS);
  const [feedCounts, setFeedCounts] = useState<FeedCounts>({});
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rowDeleting, setRowDeleting] = useState<number | null>(null);
  // The story currently being added to Compose — drives the row's spinner
  // and keeps the other Add buttons idle while one is in flight.
  const [addingId, setAddingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await fetchQueuePage();
      setItems(page.rows);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setCounts(page.counts);
      setFeedCounts(page.feedCounts);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const loadFeeds = useCallback(async () => {
    try {
      const res = await fetch('/api/sources', { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load sources');
      const data = await res.json();
      setFeeds(data.feeds ?? []);
    } catch {
      // The tabs degrade to "All sources" only; the list itself still works.
      setFeeds([]);
    }
  }, []);

  useEffect(() => {
    load();
    loadFeeds();
  }, [load, loadFeeds]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchQueuePage(nextCursor);
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.rows.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      toast.error('Could not load more stories');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/ingest', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Refresh failed');
      await load();
      toast.success('Feeds refreshed', {
        description: `${data.ingested ?? 0} new stories · ${data.skipped ?? 0} already seen`,
      });
    } catch (error) {
      toast.error('Could not refresh feeds', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function deleteDraftFor(item: QueueItem) {
    setDeleting(true);
    setRowDeleting(item.id);
    try {
      const res = await fetch(`/api/drafts?newsItemId=${item.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'The draft could not be deleted.');
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
      setRowDeleting(null);
    }
  }

  // "Add" opens the story in Compose. The single-item fetch is the request
  // the spinner covers: it validates the story still exists (and warms the
  // deep link the compose page will resolve) before the navigation starts.
  async function addToCompose(item: QueueItem) {
    if (addingId !== null) return;
    setAddingId(item.id);
    try {
      const fresh = await fetchQueueItem(item.id);
      if (!fresh) throw new Error('Story not found');
      router.push(`/compose?item=${item.id}`);
    } catch (error) {
      toast.error('Could not open the story in Compose', {
        description:
          error instanceof Error ? error.message : 'Please try again.',
      });
      setAddingId(null);
    }
  }

  const tabs: SourceTab[] = useMemo(
    () => [
      { key: 'all', label: 'All sources', feedId: null },
      ...feeds.map((feed) => ({
        key: String(feed.id),
        label: feed.title?.trim() || formatDomain(feed.url),
        feedId: feed.id,
      })),
    ],
    [feeds],
  );

  const activeFeedId = tabs.find((tab) => tab.key === activeTab)?.feedId ?? null;
  const activeCounts =
    activeFeedId === null ? counts : (feedCounts[String(activeFeedId)] ?? ZERO_COUNTS);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFeed =
        activeFeedId === null || item.feed_id === activeFeedId;
      const matchesStatus =
        statusFilter === 'all' || item.status === statusFilter;
      const matchesQuery =
        !needle ||
        `${item.title} ${item.summary}`.toLowerCase().includes(needle);
      return matchesFeed && matchesStatus && matchesQuery;
    });
  }, [items, activeFeedId, statusFilter, query]);

  const filters: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: activeCounts.total },
    { value: 'pending', label: 'Pending', count: activeCounts.pending },
    { value: 'drafted', label: 'Drafted', count: activeCounts.drafted },
    ...(activeCounts.published
      ? [{ value: 'published' as const, label: 'Published', count: activeCounts.published }]
      : []),
  ];

  return (
    <AppFrame fill>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border/70">
          <div className="mx-auto flex w-full max-w-[1680px] flex-col px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-3 py-4">
              <div className="min-w-0">
                <p className="eyebrow text-brand">
                  Editorial queue · last 30 days · {formatLongDate()}
                </p>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h1 className="font-heading text-2xl font-semibold tracking-tight">
                    Story Queue
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    {loadError ? '—' : activeCounts.pending} pending ·{' '}
                    {loadError ? '—' : activeCounts.drafted} drafted ·{' '}
                    {loadError ? '—' : activeCounts.total} total
                  </p>
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={refresh}
                disabled={refreshing}
                aria-busy={refreshing}
                className="h-9 bg-card"
              >
                <RefreshCw
                  className={cn('size-3.5', refreshing && 'animate-spin')}
                  aria-hidden
                />
                {refreshing ? 'Refreshing…' : 'Refresh feeds'}
              </Button>
            </div>

            <div
              className="flex items-center gap-1 overflow-x-auto pb-2"
              role="group"
              aria-label="Filter stories by source"
            >
              {tabs.map((tab) => {
                const badge =
                  tab.feedId === null
                    ? counts.total
                    : (feedCounts[String(tab.feedId)]?.total ?? 0);
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    aria-pressed={active}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                      active
                        ? 'bg-ink text-paper'
                        : 'text-muted-foreground hover:bg-card hover:text-foreground'
                    )}
                  >
                    <span className="max-w-[220px] truncate">{tab.label}</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                        active
                          ? 'bg-paper/20 text-paper'
                          : 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {badge}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[900px] px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative sm:w-64">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search stories"
                  aria-label="Search stories"
                  className="h-8 w-full bg-card pl-8 text-xs"
                />
              </div>
              <div
                className="flex gap-1"
                role="group"
                aria-label="Filter stories"
              >
                {filters.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setStatusFilter(filter.value)}
                    aria-pressed={statusFilter === filter.value}
                    className={cn(
                      'rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                      statusFilter === filter.value
                        ? 'bg-ink text-paper'
                        : 'text-muted-foreground hover:bg-card hover:text-foreground'
                    )}
                  >
                    {filter.label}
                    <span className="ml-1 tabular-nums opacity-60">
                      {filter.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3.5">
              {itemsLoading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <div
                    key={index}
                    className="animate-pulse rounded-xl border border-border/80 bg-card px-5 py-4"
                  >
                    <div className="h-2 w-28 rounded bg-muted" />
                    <div className="mt-2.5 h-3.5 w-full rounded bg-muted" />
                    <div className="mt-1.5 h-3.5 w-4/5 rounded bg-muted" />
                    <div className="mt-2.5 h-2.5 w-full rounded bg-muted" />
                  </div>
                ))
              ) : loadError ? (
                <ErrorState
                  title="Couldn't load the news feed"
                  description="Your stories are safe — the feed just couldn't be fetched right now."
                  onRetry={load}
                />
              ) : filtered.length ? (
                <div className="flex flex-col gap-2.5">
                  {filtered.map((item) => {
                    const meta = statusMeta(item.status);
                    const adding = addingId === item.id;
                    return (
                      <div
                        key={item.id}
                        className="group rounded-xl border border-border/80 bg-card paper-shadow-sm transition-colors hover:border-border"
                      >
                        <div className="px-5 py-4">
                          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            <span
                              className={cn('size-1.5 rounded-full', meta.dot)}
                              aria-hidden
                            />
                            {meta.label}
                            <span aria-hidden>·</span>
                            <span className="normal-case tracking-normal">
                              {item.feed_title?.trim() || formatDomain(item.link)}
                            </span>
                            {item.created_at && (
                              <span className="ml-auto normal-case tracking-normal">
                                {timeAgo(item.created_at)}
                              </span>
                            )}
                          </div>
                          <h2 className="mt-1.5 font-heading text-[17px] leading-snug tracking-[-0.01em] text-foreground/90">
                            {item.title}
                          </h2>
                          {item.summary && (
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {item.summary}
                            </p>
                          )}
                          <div className="mt-3 flex items-center justify-end gap-2">
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              Read original
                              <ArrowUpRight className="size-3" aria-hidden />
                            </a>
                            {item.draft_id ? (
                              <ConfirmIconButton
                                onConfirm={() => deleteDraftFor(item)}
                                idleLabel={`Delete draft for ${item.title}`}
                                armedLabel="Click again to delete this draft"
                                title="Delete draft"
                                disabled={rowDeleting === item.id || deleting}
                                className="tap-target rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                                icon={<Trash2 className="size-3.5" aria-hidden />}
                              />
                            ) : null}
                            <Button
                              size="sm"
                              variant="brand"
                              onClick={() => void addToCompose(item)}
                              disabled={addingId !== null}
                              aria-busy={adding}
                              aria-label={`Add "${item.title}" to Compose`}
                              className="min-w-[76px]"
                            >
                              {adding ? (
                                <Loader2
                                  className="size-3.5 animate-spin"
                                  aria-hidden
                                />
                              ) : (
                                <Plus className="size-3.5" aria-hidden />
                              )}
                              {adding ? 'Adding…' : 'Add'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : items.length ? (
                <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
                  <Newspaper className="mx-auto size-5 text-faint/60" aria-hidden />
                  <p className="mt-2 text-sm font-medium">No stories here</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Nothing from this source matches — try another tab, clear
                    the filters, or refresh the feeds.
                  </p>
                </div>
              ) : (
                <EmptyDesk
                  onRefresh={refresh}
                  onOpenSources={() => router.push('/sources')}
                  hasFeeds={feeds.length > 0}
                />
              )}
            </div>

            {items.length > 0 && (
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
                    All stories loaded
                  </p>
                )}
                <p className="mt-1.5 text-center text-[10px] tabular-nums text-muted-foreground">
                  {items.length} loaded · {counts.total} total
                </p>
              </footer>
            )}
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
