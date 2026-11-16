// Shared client for the Story Queue data (/api/items) used by the /queue
// browse page and the /compose workspace, so both pages read the same shapes
// and never drift apart.

export type QueueItem = {
  id: number;
  title: string;
  summary: string;
  link: string;
  status: string;
  created_at?: string;
  draft_id?: number | null;
  feed_id?: number | null;
  feed_title?: string | null;
};

export type QueueCounts = {
  total: number;
  pending: number;
  drafted: number;
  published: number;
};

/** Per-feed windowed totals keyed by String(feed_id); feeds are never null here —
 * stories whose feed was deleted (feed_id null) only count toward the overall counts. */
export type FeedCounts = Record<string, QueueCounts>;

export type QueuePage = {
  rows: QueueItem[];
  nextCursor: number | null;
  hasMore: boolean;
  counts: QueueCounts;
  feedCounts: FeedCounts;
};

export async function fetchQueuePage(before?: number | null): Promise<QueuePage> {
  const res = await fetch(
    before ? `/api/items?before=${before}` : '/api/items',
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error('Could not load the news feed');
  const data = await res.json();
  const feedCounts: FeedCounts = {};
  for (const row of data.feedCounts ?? []) {
    if (row.feed_id != null) {
      feedCounts[String(row.feed_id)] = {
        total: row.total,
        pending: row.pending,
        drafted: row.drafted,
        published: row.published,
      };
    }
  }
  return {
    rows: Array.isArray(data) ? data : (data.rows ?? []),
    nextCursor: typeof data.nextCursor === 'number' ? data.nextCursor : null,
    hasMore: Boolean(data.hasMore),
    counts: data.counts ?? { total: 0, pending: 0, drafted: 0, published: 0 },
    feedCounts,
  };
}

/** One story by id (single-item mode of /api/items) — resolves Compose deep
 * links to stories that sit beyond the first list page. Throws on request
 * failure; returns null only when the story does not exist. */
export async function fetchQueueItem(id: number): Promise<QueueItem | null> {
  const res = await fetch(`/api/items?item=${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load the story.');
  const data = await res.json();
  const rows: QueueItem[] = data.rows ?? [];
  return rows[0] ?? null;
}
