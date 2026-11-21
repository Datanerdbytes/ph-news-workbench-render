import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
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

// Unlike /api/items (the 30-day Story Queue inbox), this endpoint backs the
// Sources page archive browser: it serves the feed's lifetime articles so a
// source can be paged through the way a reader browses a publication.
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
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;

  try {
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
      )
      SELECT * FROM stories
      WHERE id < COALESCE(${before}, 2147483647)
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `) as unknown as SourceItemRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    return NextResponse.json(
      { rows: page, nextCursor, hasMore },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    console.error(JSON.stringify({
      route: 'source-items',
      event: 'list_error',
      workspaceId: access.workspace.id,
      feedId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return NextResponse.json({ error: 'Failed to load stories' }, { status: 500 });
  }
}
