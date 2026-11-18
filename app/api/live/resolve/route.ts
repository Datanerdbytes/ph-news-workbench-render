import { NextResponse } from 'next/server';
import { ResolveError, resolveVideoUrl } from '@/lib/live/resolve';
import { readText } from '@/lib/publishing/request';
import { requireWorkspace, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Resolving runs yt-dlp on the server, so this is signed-in only — but
  // unlike the other live routes it needs no Facebook connection.
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const body = await request.json().catch(() => null);
  const url = readText(body?.url, 2048);
  if (!url) {
    return NextResponse.json(
      { error: 'Paste a video link to preview.' },
      { status: 400 }
    );
  }

  try {
    const video = await resolveVideoUrl(url);
    return NextResponse.json(video, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof ResolveError) {
      // The message is friendly by construction; raw yt-dlp stderr never
      // reaches this response.
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === 'invalid_url' ? 400 : 502 }
      );
    }
    return NextResponse.json(
      { error: 'The video link could not be resolved.' },
      { status: 502 }
    );
  }
}
