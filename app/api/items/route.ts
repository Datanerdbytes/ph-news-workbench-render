import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

type ItemRow = {
  id: number;
  title: string;
  summary: string | null;
  link: string;
  created_at: string | null;
  draft_id: number | null;
  status: string;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// The Story Queue is the active inbox: list and stat chips cover the last N
// days of ingested stories, so Published drifts back to zero on its own as
// stories age out instead of counting everything ever ingested. Lifetime
// numbers belong on the Dashboard. (created_at = ingest time, not the
// article's own publication date — an old article ingested today is queue
// work you haven't handled.)
const QUEUE_WINDOW_DAYS = 30;

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const params = new URL(request.url).searchParams;
  const requested = Number(params.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const cursor = Number(params.get('before'));
  const before = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : null;

  const rows = (await sql`
    WITH stories AS (
      SELECT n.id, n.title, n.summary, n.link, n.created_at,
             (SELECT d.id FROM drafts d
               WHERE d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id}
               ORDER BY d.id DESC LIMIT 1) AS draft_id,
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
      WHERE n.workspace_id = ${access.workspace.id}
        AND n.created_at > now() - (${QUEUE_WINDOW_DAYS} * interval '1 day')
    )
    SELECT * FROM stories
    WHERE id < COALESCE(${before}, 2147483647)
    ORDER BY id DESC
    LIMIT ${limit + 1}
  `) as unknown as ItemRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  const totalsRows = (await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'drafted')::int AS drafted,
           COUNT(*) FILTER (WHERE status = 'published')::int AS published
    FROM (
      SELECT CASE
               WHEN EXISTS (SELECT 1 FROM drafts d
                 WHERE d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id} AND d.status = 'published')
                 THEN 'published'
               WHEN EXISTS (SELECT 1 FROM drafts d
                 WHERE d.news_item_id = n.id AND d.workspace_id = ${access.workspace.id})
                 THEN 'drafted'
               ELSE 'pending'
             END AS status
      FROM news_items n
      WHERE n.workspace_id = ${access.workspace.id}
        AND n.created_at > now() - (${QUEUE_WINDOW_DAYS} * interval '1 day')
    ) stories
  `) as unknown as {
    total: number;
    pending: number;
    drafted: number;
    published: number;
  }[];

  return NextResponse.json(
    {
      rows: page,
      nextCursor,
      hasMore,
      counts: totalsRows[0] ?? {
        total: page.length,
        pending: 0,
        drafted: 0,
        published: 0,
      },
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
