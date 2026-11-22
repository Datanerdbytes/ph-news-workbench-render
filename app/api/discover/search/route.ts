import { NextResponse } from 'next/server';
import { requireWorkspace, unauthorized } from '@/lib/session';
import { DiscoverSearchError, searchFeeds } from '@/lib/discover';

export const dynamic = 'force-dynamic';

// Backs the Discover page: proxy a feed-index search for a topic or free
// text query. Cached upstream in lib/discover.ts; results are metadata only
// (adding a source still runs our own validate + ingest flow).
export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  const wanted = Number(params.get('count'));
  const count = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 12;

  if (!query) {
    return NextResponse.json({ error: 'A search query is required' }, { status: 400 });
  }

  try {
    const sources = await searchFeeds(query, count);
    return NextResponse.json(
      { sources },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error(JSON.stringify({
      route: 'discover-search',
      event: 'search_error',
      workspaceId: access.workspace.id,
      query,
      error: error instanceof Error ? error.message : String(error),
    }));
    const message =
      error instanceof DiscoverSearchError
        ? error.message
        : 'Couldn\'t reach the source index. Try again in a moment.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
