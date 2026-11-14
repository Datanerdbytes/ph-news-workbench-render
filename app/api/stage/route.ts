import { NextResponse } from 'next/server';
import { requireUser, unauthorized } from '@/lib/session';
import {
  getStorageDriver,
  presignStagedUpload,
  stageFileToRepo,
  type StorageDriver,
} from '@/lib/storage';

export const runtime = 'nodejs';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// WebM joins the video list because browser-baked reels record to it — the
// same superset /api/reels/prepare accepts.
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Aligned with the chunked Video API's 45-minute / 1.75 GB envelope the
// publish route enforces (1 GB own cap).
const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Staging ingest for the s3 and hf drivers (the blob driver stages straight
 * from the browser via /api/blob and never lands here):
 *   - s3 → answer with a presigned PUT so the browser uploads directly to
 *     the bucket and large reels never cross the app server;
 *   - hf → accept a multipart body and stream it into the private dataset
 *     repo, since Hugging Face has no direct browser upload API.
 * Both paths enforce the same media types and size caps as /api/blob.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireUser(request);
  if (!user) return unauthorized();

  let driver: StorageDriver;
  try {
    driver = getStorageDriver();
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Storage is misconfigured.',
      },
      { status: 500 }
    );
  }

  if (driver === 'blob') {
    return NextResponse.json(
      { error: 'The blob driver stages via /api/blob.' },
      { status: 400 }
    );
  }

  try {
    if (driver === 's3') {
      const body = (await request.json().catch(() => null)) as {
        pathname?: unknown;
        contentType?: unknown;
        size?: unknown;
      } | null;
      const pathname =
        typeof body?.pathname === 'string' ? body.pathname.trim() : '';
      const contentType =
        typeof body?.contentType === 'string' ? body.contentType : '';
      const size = typeof body?.size === 'number' ? body.size : NaN;
      if (!pathname || !contentType || !Number.isFinite(size)) {
        return NextResponse.json(
          { error: 'Pass pathname, contentType and size.' },
          { status: 400 }
        );
      }
      const problem = assertMediaType(contentType, size);
      if (problem) {
        return NextResponse.json({ error: problem }, { status: 400 });
      }
      const presigned = await presignStagedUpload(pathname, contentType);
      return NextResponse.json(presigned);
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    const pathname = form?.get('pathname');
    if (!(file instanceof File) || typeof pathname !== 'string' || !pathname) {
      return NextResponse.json(
        { error: 'Pass a multipart body with pathname and file.' },
        { status: 400 }
      );
    }
    const problem = assertMediaType(file.type, file.size);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
    const url = await stageFileToRepo(pathname, file);
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'The upload was rejected.',
      },
      { status: 500 }
    );
  }
}

function assertMediaType(contentType: string, sizeBytes: number): string | null {
  const isVideo = VIDEO_TYPES.includes(contentType);
  const isImage = IMAGE_TYPES.includes(contentType);
  if (!isVideo && !isImage) {
    return 'Only JPEG, PNG and WebP images or MP4, MOV and WebM videos can be staged.';
  }
  if (sizeBytes > (isVideo ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES)) {
    return 'The file is too large to stage.';
  }
  return null;
}
