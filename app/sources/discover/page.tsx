'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Compass,
  Loader2,
  Plus,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { AppFrame } from '@/components/app-frame';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import {
  DEFAULT_DISCOVER_QUERY,
  DISCOVER_TOPICS,
  getTopic,
  type DiscoverSource,
  type DiscoverTopic,
} from '@/lib/discover';
import { formatCompact, formatDomain, timeAgo } from '@/lib/format';

type Feed = {
  id: number;
  url: string;
  title: string | null;
  enabled: boolean;
};

type PreviewData = {
  feed: {
    title: string;
    description: string;
    url: string;
    siteUrl: string | null;
  };
  items: {
    title: string;
    link: string;
    published_at: string | null;
    image_url: string | null;
  }[];
};

/** Source icon with a monogram fallback (Discover cards carry remote icons). */
function SourceIcon({
  src,
  title,
  className,
}: {
  src: string | null;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = (title.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  if (!src || failed) {
    return (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-lg bg-brand text-[13px] font-semibold text-brand-foreground',
          className,
        )}
      >
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote index imagery with arbitrary hosts; the app renders remote media with plain img (see page-selection.tsx)
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-lg object-cover', className)}
    />
  );
}

function SourceCard({
  source,
  added,
  adding,
  onPreview,
  onAdd,
}: {
  source: DiscoverSource;
  added: boolean;
  adding: boolean;
  onPreview: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-4 paper-shadow-sm transition-colors hover:border-border">
      <div className="flex items-start gap-3">
        <SourceIcon src={source.iconUrl} title={source.title} className="size-10 border border-border/60" />
        <div className="min-w-0 flex-1">
          <h3 className="font-heading text-[15px] leading-snug tracking-[-0.01em]">
            <button
              type="button"
              onClick={onPreview}
              className="text-left transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="line-clamp-1">{source.title}</span>
            </button>
          </h3>
          <p className="mt-0.5 truncate text-[10.5px] text-faint">
            {formatDomain(source.siteUrl || source.feedUrl)}
          </p>
        </div>
        {added ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
            <Check className="size-3" aria-hidden />
            Added
          </span>
        ) : (
          <Button
            variant="brand"
            size="sm"
            onClick={onAdd}
            disabled={adding}
            aria-busy={adding}
            aria-label={`Add ${source.title} to your sources`}
            className="shrink-0"
          >
            {adding ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {adding ? 'Adding…' : 'Add'}
          </Button>
        )}
      </div>
      {source.description && (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {source.description}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between">
        <span className="text-[10.5px] tabular-nums text-faint">
          {formatCompact(source.subscribers)} followers
        </span>
        <button
          type="button"
          onClick={onPreview}
          className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Preview latest stories
        </button>
      </div>
    </div>
  );
}

function TopicTile({ topic, onSelect }: { topic: DiscoverTopic; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col gap-1 rounded-xl border border-border/80 bg-card p-4 text-left paper-shadow-sm transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex items-center gap-2">
        <Compass className="size-4 text-brand" aria-hidden />
        <span className="font-heading text-[15px] tracking-[-0.01em]">{topic.label}</span>
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">{topic.blurb}</span>
    </button>
  );
}

function DiscoverPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawQuery = searchParams.get('query') ?? '';

  // ?query=topic/<slug> renders a topic page; a raw term renders search
  // results; no param renders the Discover home.
  const topicSlug = rawQuery.startsWith('topic/') ? rawQuery.slice('topic/'.length) : null;
  const activeTopic = topicSlug ? getTopic(topicSlug) : null;
  const searchQuery = activeTopic
    ? activeTopic.query
    : topicSlug
      ? DEFAULT_DISCOVER_QUERY
      : rawQuery.trim() || DEFAULT_DISCOVER_QUERY;

  const [inputValue, setInputValue] = useState(() =>
    rawQuery.startsWith('topic/') ? '' : rawQuery,
  );

  // Plain search terms in the URL drive the input (back/forward, deep
  // links). Topic params leave the input alone — selecting a chip clears it
  // imperatively instead.
  useEffect(() => {
    if (!rawQuery.startsWith('topic/')) setInputValue(rawQuery);
  }, [rawQuery]);

  // Input -> URL, debounced; typing over a topic page searches instead.
  useEffect(() => {
    const term = inputValue.trim();
    const urlTerm = rawQuery.startsWith('topic/') ? null : rawQuery;
    if (term === (urlTerm ?? '')) return;
    const timer = setTimeout(() => {
      router.replace(
        term ? `/sources/discover?query=${encodeURIComponent(term)}` : '/sources/discover',
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, rawQuery, router]);

  const [results, setResults] = useState<DiscoverSource[]>([]);
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);

  const [previewSource, setPreviewSource] = useState<DiscoverSource | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [addingUrl, setAddingUrl] = useState<string | null>(null);

  const loadFeeds = useCallback(async () => {
    try {
      const res = await fetch('/api/sources', { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load sources');
      const data = await res.json();
      setFeeds(data.feeds ?? []);
    } catch {
      // Added-state matching degrades to "not added"; adding still works.
      setFeeds([]);
    } finally {
      setFeedsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeeds();
  }, [loadFeeds]);

  const searchQueryRef = useRef(searchQuery);
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  const loadResults = useCallback(async () => {
    const queryAtRequest = searchQueryRef.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetch(
        `/api/discover/search?q=${encodeURIComponent(queryAtRequest)}&count=18`,
        { cache: 'no-store' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Search failed');
      if (queryAtRequest !== searchQueryRef.current) return;
      setResults(data.sources ?? []);
    } catch (error) {
      if (queryAtRequest !== searchQueryRef.current) return;
      setSearchError(error instanceof Error ? error.message : 'Search failed');
      setResults([]);
    } finally {
      if (queryAtRequest === searchQueryRef.current) setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadResults();
  }, [loadResults, searchQuery]);

  // Preview payloads are fetched per opened source; a local stale flag
  // guards against rapid open/close or switching sources.
  useEffect(() => {
    if (!previewSource) return;
    let stale = false;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/sources/preview?url=${encodeURIComponent(previewSource.feedUrl)}`,
          { cache: 'no-store' },
        );
        const data = await res.json();
        if (stale) return;
        if (!res.ok) throw new Error(data.error ?? 'Preview failed');
        setPreview(data);
      } catch (error) {
        if (stale) return;
        setPreviewError(
          error instanceof Error ? error.message : 'Could not load the preview',
        );
      } finally {
        if (!stale) setPreviewLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [previewSource]);

  const addedUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const feed of feeds) {
      urls.add(feed.url);
      urls.add(feed.url.replace(/\/$/, ''));
    }
    return urls;
  }, [feeds]);

  const isAdded = (source: DiscoverSource) =>
    addedUrls.has(source.feedUrl) || addedUrls.has(source.feedUrl.replace(/\/$/, ''));

  const selectTopic = (topic: DiscoverTopic) => {
    setInputValue('');
    router.replace(`/sources/discover?query=topic/${topic.slug}`);
  };

  const addSource = async (source: DiscoverSource) => {
    if (addingUrl) return;
    setAddingUrl(source.feedUrl);
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: source.feedUrl,
          category: activeTopic?.label ?? '',
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast.info('Already in your sources', {
          description: `${data.feed?.title ?? source.title} was added previously.`,
        });
        await loadFeeds();
        return;
      }
      if (!res.ok) throw new Error(data.error ?? 'Failed to add feed');
      toast.success('Source added', {
        description: `${data.feed?.title ?? source.title} is now pulling stories into your queue.`,
      });
      await loadFeeds();
    } catch (error) {
      toast.error('Could not add the source', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setAddingUrl(null);
    }
  };

  const isHome = !rawQuery;
  const showTopicHeader = Boolean(activeTopic);

  return (
    <AppFrame>
      <div className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 lg:py-8">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => router.push('/sources')}
            aria-label="Back to sources"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
          </Button>
          <p className="eyebrow">Sources</p>
        </div>
        <h1 className="page-title mt-1">Discover sources</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Browse publications by topic, preview their latest stories, and add
          them to your workspace.
        </p>

        {/* Search + topic chips */}
        <div className="mt-5">
          <div className="relative max-w-xl">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <Input
              value={inputValue}
              onChange={event => setInputValue(event.target.value)}
              placeholder="Search publications — e.g. Rappler, tech, startups"
              aria-label="Search publications"
              className="h-10 w-full bg-card pl-9 text-[13px]"
            />
          </div>
          <div
            className="mt-3 flex items-center gap-1 overflow-x-auto pb-1"
            role="group"
            aria-label="Browse topics"
          >
            {DISCOVER_TOPICS.map(topic => {
              const active = activeTopic?.slug === topic.slug;
              return (
                <button
                  key={topic.slug}
                  type="button"
                  onClick={() => selectTopic(topic)}
                  aria-pressed={active}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-ink text-paper'
                      : 'text-muted-foreground hover:bg-card hover:text-foreground',
                  )}
                >
                  {topic.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Heading for the current view */}
        <div className="mt-6">
          {showTopicHeader && activeTopic ? (
            <>
              <h2 className="font-heading text-2xl font-semibold tracking-tight">
                {activeTopic.label}
              </h2>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {activeTopic.blurb}
              </p>
            </>
          ) : isHome ? (
            <>
              <h2 className="font-heading text-2xl font-semibold tracking-tight">
                Popular right now
              </h2>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Top publications across the topics newsrooms follow most.
              </p>
            </>
          ) : (
            <h2 className="font-heading text-2xl font-semibold tracking-tight">
              Results for &ldquo;{rawQuery.trim()}&rdquo;
            </h2>
          )}
        </div>

        {/* Topic tiles on the home view */}
        {isHome && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DISCOVER_TOPICS.map(topic => (
              <TopicTile key={topic.slug} topic={topic} onSelect={() => selectTopic(topic)} />
            ))}
          </div>
        )}

        {/* Results grid */}
        <div className={cn(isHome && 'mt-8')}>
          {!isHome && <div className="mt-4" />}
          {searchLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="animate-pulse rounded-xl border border-border/80 bg-card p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="size-10 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-1.5 py-0.5">
                      <div className="h-3.5 w-3/4 rounded bg-muted" />
                      <div className="h-2.5 w-1/2 rounded bg-muted" />
                    </div>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    <div className="h-2.5 w-full rounded bg-muted" />
                    <div className="h-2.5 w-5/6 rounded bg-muted" />
                    <div className="h-2.5 w-2/3 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : searchError ? (
            <ErrorState
              title="Couldn't load suggestions"
              description={searchError}
              onRetry={loadResults}
              retrying={searchLoading}
              className="mt-4"
            />
          ) : results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
              <Compass className="mx-auto size-5 text-faint/60" aria-hidden />
              <p className="mt-2 text-sm font-medium">No publications found</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Try another topic or search term — or add a feed directly on
                the Sources page.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {results.map(source => (
                <SourceCard
                  key={source.feedUrl}
                  source={source}
                  added={!feedsLoading && isAdded(source)}
                  adding={addingUrl === source.feedUrl}
                  onPreview={() => setPreviewSource(source)}
                  onAdd={() => void addSource(source)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Source preview modal */}
      <Modal
        open={Boolean(previewSource)}
        onClose={() => setPreviewSource(null)}
        title="Source preview"
      >
        {previewSource && (
          <div className="mt-4">
            <div className="flex items-start gap-3">
              <SourceIcon
                src={previewSource.iconUrl}
                title={previewSource.title}
                className="size-12 border border-border/60"
              />
              <div className="min-w-0 flex-1">
                <h3 className="font-heading text-[17px] leading-snug tracking-[-0.01em]">
                  {previewSource.title}
                </h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatDomain(previewSource.siteUrl || previewSource.feedUrl)} ·{' '}
                  {formatCompact(previewSource.subscribers)} followers
                </p>
              </div>
              {isAdded(previewSource) ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
                  <Check className="size-3" aria-hidden />
                  Added
                </span>
              ) : (
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => void addSource(previewSource)}
                  disabled={addingUrl !== null}
                  aria-busy={addingUrl === previewSource.feedUrl}
                >
                  {addingUrl === previewSource.feedUrl ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Plus className="size-3.5" aria-hidden />
                  )}
                  {addingUrl === previewSource.feedUrl ? 'Adding…' : 'Add source'}
                </Button>
              )}
            </div>
            {previewSource.description && (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {previewSource.description}
              </p>
            )}

            <p className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-faint">
              Latest stories
            </p>
            {previewLoading ? (
              <div className="mt-2 animate-pulse space-y-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <div className="size-9 rounded-md bg-muted" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-full rounded bg-muted" />
                      <div className="h-2.5 w-1/3 rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : previewError ? (
              <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-[11px] leading-relaxed text-destructive">
                {previewError}
              </div>
            ) : preview && preview.items.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {preview.items.map(item => (
                  <li
                    key={item.link}
                    className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
                  >
                    {item.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- remote feed imagery with arbitrary hosts; the app renders remote media with plain img
                      <img
                        src={item.image_url}
                        alt=""
                        loading="lazy"
                        className="size-9 shrink-0 rounded-md border border-border/60 object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-[10px] font-semibold text-faint"
                      >
                        {(item.title.match(/[a-z0-9]/i)?.[0] ?? '·').toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noreferrer"
                        className="line-clamp-1 text-[12.5px] font-medium text-foreground/90 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {item.title}
                      </a>
                      {item.published_at && (
                        <p className="text-[10px] text-faint">{timeAgo(item.published_at)}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-muted-foreground">
                No stories parsed from this feed yet.
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreviewSource(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AppFrame>
  );
}

export default function DiscoverPage() {
  // useSearchParams opts the page out of prerendering without a boundary.
  return (
    <Suspense fallback={null}>
      <DiscoverPageInner />
    </Suspense>
  );
}
