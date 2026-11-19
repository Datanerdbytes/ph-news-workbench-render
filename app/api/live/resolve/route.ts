import { NextResponse } from 'next/server';
import { ResolveError, resolveVideoUrl } from '@/lib/live/resolve';
import { readText } from '@/lib/publishing/request';
import {
  NetworkPolicyError,
  validateSourceUrl,
} from '@/lib/live/public-network';
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
    // Shared network policy: shape + scheme + port checks run here, before
    // yt-dlp can ever see the input. DNS-based public checks happen inside
    // the resolver path and (for HLS) the preview proxy.
    const validated = validateSourceUrl(url);
    const video = await resolveVideoUrl(validated);
    return NextResponse.json(video, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      // The shared network policy rejected the input (scheme, port, size):
      // a 400 with the policy's safe message and the same code the resolver
      // uses for bad input keeps the client contract uniform.
      return NextResponse.json(
        { error: error.message, code: 'invalid_url' },
        { status: 400 }
      );
    }
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
