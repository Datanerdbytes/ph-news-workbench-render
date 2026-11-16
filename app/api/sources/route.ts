import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireOwner, unauthorized } from '@/lib/session';
import { feedParser, ingestFeed, resolveFeedUrl, describeFeedError, FeedFetchError } from '@/lib/feeds';
import { randomUUID } from 'crypto';

type FeedRow = {
  id: number;
  workspace_id: string;
  url: string;
  title: string | null;
  last_fetched_at: string | null;
  error_message: string | null;
  enabled: boolean;
  created_at: string;
  item_count: number;
};

export async function GET(request: Request) {
  const access = await requireOwner(request);
  if (!access) return unauthorized();
  if (access instanceof NextResponse) return access;

  try {
    const feeds = (await sql`
      SELECT
        f.id,
        f.workspace_id,
        f.url,
        f.title,
        f.last_fetched_at,
        f.error_message,
        f.enabled,
        f.created_at,
        COALESCE(ni_count.cnt, 0) AS item_count
      FROM feeds f
      LEFT JOIN (
        SELECT feed_id, COUNT(*)::int AS cnt
        FROM news_items
        WHERE workspace_id = ${access.workspace.id}
        GROUP BY feed_id
      ) ni_count ON ni_count.feed_id = f.id
      WHERE f.workspace_id = ${access.workspace.id}
      ORDER BY f.created_at DESC
    `) as unknown as FeedRow[];

    return NextResponse.json({ feeds }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error(JSON.stringify({
      route: 'sources',
      event: 'list_error',
      workspaceId: access.workspace.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return NextResponse.json({ error: 'Failed to fetch sources' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await requireOwner(request);
  if (!access) return unauthorized();
  if (access instanceof NextResponse) return access;

  try {
    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Feed URL is required' }, { status: 400 });
    }

    const trimmedUrl = url.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Resolve the URL before parsing: follow HTML pages to their advertised
    // feed and surface reachability problems as specific errors instead of a
    // generic "could not parse" failure.
    let resolvedUrl = trimmedUrl;
    try {
      resolvedUrl = await resolveFeedUrl(trimmedUrl);
    } catch (resolveError) {
      console.error(JSON.stringify({
        route: 'sources',
        event: 'resolve_error',
        workspaceId: access.workspace.id,
        url: trimmedUrl,
        error: resolveError instanceof Error ? resolveError.message : String(resolveError),
      }));
      const message = resolveError instanceof FeedFetchError
        ? resolveError.message
        : describeFeedError(resolveError);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // The resolved feed URL may differ from what was submitted (e.g. a
    // homepage that advertises /feed/), so check both for duplicates.
    const existing = await sql`
      SELECT id FROM feeds
      WHERE workspace_id = ${access.workspace.id}
        AND url = ANY(${[trimmedUrl, resolvedUrl]})
    `;
    if (existing.length > 0) {
      return NextResponse.json({ error: 'This feed is already added to your workspace' }, { status: 409 });
    }

    // Validate and fetch feed to get title and preview items
    let feedTitle = '';
    let previewItems: Array<{ title: string; link: string; published_at: string | null }> = [];

    try {
      const feed = await feedParser.parseURL(resolvedUrl);
      feedTitle = feed.title?.trim() || new URL(resolvedUrl).hostname;

      // Get first 3 items for preview
      previewItems = (feed.items ?? []).slice(0, 3).map(item => ({
        title: item.title ?? '',
        link: item.link ?? '',
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      }));
    } catch (parseError) {
      console.error(JSON.stringify({
        route: 'sources',
        event: 'parse_error',
        workspaceId: access.workspace.id,
        url: trimmedUrl,
        resolvedUrl,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      }));
      return NextResponse.json({ error: describeFeedError(parseError) }, { status: 400 });
    }

    // Insert the new feed
    const result = await sql`
      INSERT INTO feeds (workspace_id, url, title, enabled, created_at)
      VALUES (${access.workspace.id}, ${resolvedUrl}, ${feedTitle}, true, now())
      RETURNING id, workspace_id, url, title, last_fetched_at, error_message, enabled, created_at
    `;

    const newFeed = result[0];

    // Trigger initial ingest for this feed
    try {
      await ingestFeed(
        { id: newFeed.id, workspace_id: access.workspace.id, url: resolvedUrl, title: feedTitle },
        { correlationId: randomUUID(), trigger: 'initial' },
      );
    } catch (ingestError) {
      console.error(JSON.stringify({
        route: 'sources',
        event: 'initial_ingest_error',
        workspaceId: access.workspace.id,
        feedId: newFeed.id,
        url: trimmedUrl,
        error: ingestError instanceof Error ? ingestError.message : String(ingestError),
      }));
      // Don't fail the request, just log the error
    }

    return NextResponse.json({
      feed: {
        ...newFeed,
        item_count: 0,
      },
      preview: previewItems,
    }, { status: 201 });
  } catch (error) {
    console.error(JSON.stringify({
      route: 'sources',
      event: 'create_error',
      workspaceId: access.workspace.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof Error && error.message.includes('feeds_workspace_url_unique')) {
      return NextResponse.json({ error: 'This feed is already added to your workspace' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to add source' }, { status: 500 });
  }
}
