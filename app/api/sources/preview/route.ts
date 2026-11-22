import { NextResponse } from 'next/server';
import { requireWorkspace, unauthorized } from '@/lib/session';
import { describeFeedError, extractItemImage, feedParser, resolveFeedUrl, FeedFetchError } from '@/lib/feeds';

export const dynamic = 'force-dynamic';

const PREVIEW_ITEMS = 8;

function previewDate(isoDate?: string, pubDate?: string): string | null {
  const value = isoDate ?? pubDate;
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

type PreviewItem = {
  title: string;
  link: string;
  published_at: string | null;
  image_url: string | null;
};

// Parse-only feed preview for the Discover flow: resolves the URL the same
// way add-source does, parses the feed, and returns its metadata plus the
// first items — without writing anything to the database.
export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const params = new URL(request.url).searchParams;
  const url = (params.get('url') ?? '').trim();
  if (!url) {
    return NextResponse.json({ error: 'A feed URL is required' }, { status: 400 });
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
  }

  try {
    const resolvedUrl = await resolveFeedUrl(url);
    const feed = await feedParser.parseURL(resolvedUrl);

    const items: PreviewItem[] = (feed.items ?? []).slice(0, PREVIEW_ITEMS).map(item => ({
      title: item.title ?? '',
      link: item.link ?? '',
      published_at: previewDate(item.isoDate, item.pubDate),
      image_url: extractItemImage(item),
    }));

    let siteUrl: string | null = null;
    try {
      siteUrl = new URL(resolvedUrl).origin;
    } catch {
      siteUrl = null;
    }

    return NextResponse.json(
      {
        feed: {
          title: feed.title?.trim() || new URL(resolvedUrl).hostname,
          description: feed.description?.trim() || '',
          url: resolvedUrl,
          siteUrl,
        },
        items,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error(JSON.stringify({
      route: 'sources-preview',
      event: 'preview_error',
      workspaceId: access.workspace.id,
      // Feed URLs may carry credentials. Error messages from the transport
      // or parser can also repeat the input or feed content.
      url: parsedUrl.origin + parsedUrl.pathname,
      status: error instanceof FeedFetchError ? error.status : undefined,
    }));
    const message =
      error instanceof FeedFetchError
        ? error.message
        : describeFeedError(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
