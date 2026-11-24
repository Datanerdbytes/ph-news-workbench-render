import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import {
  parseSourceItemFilters,
  SourceItemFilterError,
} from '@/lib/source-item-filters';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

type SourceItemRow = {
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

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const params = new URL(request.url).searchParams;
  const wanted = Number(params.get('feed'));
  const feedId = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : null;
  const cursor = Number(params.get('before'));
  const before = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : null;
  const requested = Number(params.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT)
      : DEFAULT_LIMIT;

  try {
    const filters = parseSourceItemFilters(params);
    const rows = (await sql`
      WITH stories AS (
        SELECT n.id, n.title, n.summary, n.image_url, n.link, n.published_at, n.created_at,
               n.feed_id, f.title AS feed_title,
               CASE
                 WHEN EXISTS (SELECT 1 FROM drafts d
                   WHERE d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id} AND d.status = 'published')
                   THEN 'published'
                 WHEN EXISTS (SELECT 1 FROM drafts d
                   WHERE d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id})
                   THEN 'drafted'
                 ELSE 'pending'
               END AS status
        FROM news_items n
        LEFT JOIN feeds f ON f.id = n.feed_id
        WHERE n.workspace_id = ${access.workspace.id}
          AND (${feedId}::int IS NULL OR n.feed_id = ${feedId})
          AND (${filters.start}::timestamptz IS NULL OR n.published_at >= ${filters.start}::timestamptz)
          AND (${filters.end}::timestamptz IS NULL OR n.published_at < ${filters.end}::timestamptz)
          AND ${filters.searchPatterns.length} = (
            SELECT COUNT(*)
            FROM unnest(${filters.searchPatterns}::text[]) AS search_terms(pattern)
            WHERE n.title ILIKE search_terms.pattern
              OR n.summary ILIKE search_terms.pattern
              OR f.title ILIKE search_terms.pattern
              OR COALESCE(n.raw_payload->>'creator', n.raw_payload->>'author', '') ILIKE search_terms.pattern
              OR COALESCE(n.raw_payload->>'categories', '') ILIKE search_terms.pattern
          )
      ),
      with_total AS (
        SELECT *, COUNT(*) OVER()::int AS total FROM stories
      )
      SELECT * FROM with_total
      WHERE id < COALESCE(${before}, 2147483647)
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `) as unknown as (SourceItemRow & { total: number })[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;
    const payload: SourceItemRow[] = page.map(row => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      link: row.link,
      image_url: row.image_url,
      published_at: row.published_at,
      created_at: row.created_at,
      feed_id: row.feed_id,
      feed_title: row.feed_title,
      status: row.status,
    }));

    return NextResponse.json(
      { rows: payload, total: page[0]?.total ?? 0, nextCursor, hasMore },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof SourceItemFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(JSON.stringify({
      route: 'source-items',
      event: 'list_error',
      workspaceId: access.workspace.id,
      feedId,
      range: params.get('range') ?? 'today',
      error: error instanceof Error ? error.message : String(error),
    }));
    return NextResponse.json({ error: 'Failed to load stories' }, { status: 500 });
  }
}
