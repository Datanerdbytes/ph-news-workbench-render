import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  FacebookApiError,
  graphPostForm,
  graphRequest,
  type GraphUploadFile,
} from '@/lib/facebook';
import { scheduledFields } from './schedule';

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 3 * 60_000;

type StartResponse = {
  upload_session_id?: string;
  video_id?: string;
  start_offset?: string | number;
  end_offset?: string | number;
};

export type VideoUpload = {
  /** Temp file on disk — chunks are read off disk so heap use stays flat. */
  path: string;
  size: number;
  type: string;
  filename: string;
};

export type PageVideo = {
  id: string;
  permalink: string | null;
};

export async function publishPageVideo({
  pageId,
  accessToken,
  title = '',
  description = '',
  video,
  thumbnail = null,
  feedTargeting = '',
  scheduledPublishTime = null,
}: {
  pageId: string;
  accessToken: string;
  /** Optional — long reels posted as videos describe themselves via the caption. */
  title?: string;
  description?: string;
  video: VideoUpload;
  /** Small enough to hold in memory (≤20 MB), unlike the video itself. */
  thumbnail?: { bytes: Buffer; type: string; filename: string } | null;
  feedTargeting?: string;
  scheduledPublishTime?: number | null;
}): Promise<PageVideo> {
  if (video.size > MAX_VIDEO_BYTES) {
    throw new Error(
      'Videos must be 1 GB or smaller for the chunked uploader.'
    );
  }

  const session = await graphPostForm<StartResponse>(
    `${pageId}/videos`,
    {
      upload_phase: 'start',
      file_size: String(video.size),
    },
    accessToken
  );

  if (!session.upload_session_id || !session.video_id) {
    throw new FacebookApiError(
      'Facebook did not return a video upload session.'
    );
  }

  const sessionId = session.upload_session_id;

  // Reused scratch buffer + subarray views: each transfer puts only 4 MB of
  // fresh bytes on the wire-heap. (Slicing the backing ArrayBuffer instead
  // used to copy the WHOLE video once per chunk.)
  const scratch = Buffer.alloc(CHUNK_BYTES);
  const handle = await open(video.path, 'r');
  try {
    for (let offset = 0; offset < video.size; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, video.size);
      const { bytesRead } = await handle.read(scratch, 0, end - offset, offset);
      if (bytesRead !== end - offset) {
        throw new Error('The video file changed while uploading.');
      }
      const chunk: GraphUploadFile = {
        field: 'video_file_chunk',
        bytes: scratch.subarray(0, bytesRead),
        type: 'application/octet-stream',
        filename: 'chunk',
      };

      await graphPostForm(
        `${pageId}/videos`,
        {
          upload_phase: 'transfer',
          upload_session_id: sessionId,
          start_offset: String(offset),
        },
        accessToken,
        [chunk],
        CHUNK_TIMEOUT_MS
      );
    }
  } finally {
    await handle.close();
  }

  const finishFields: Record<string, string> = {
    upload_phase: 'finish',
    upload_session_id: sessionId,
    ...scheduledFields(scheduledPublishTime),
  };
  if (title) finishFields.title = title;
  if (description) finishFields.description = description;
  if (feedTargeting) finishFields.feed_targeting = feedTargeting;

  await graphPostForm(
    `${pageId}/videos`,
    finishFields,
    accessToken,
    thumbnail ? [{ field: 'thumb', ...thumbnail }] : [],
    CHUNK_TIMEOUT_MS
  );

  let permalink: string | null = null;
  try {
    const body = await graphRequest<{ permalink_url?: string }>(
      session.video_id,
      { fields: 'permalink_url' },
      accessToken
    );
    permalink = body.permalink_url ?? null;
  } catch {
    // Facebook processes the video asynchronously; the post still exists.
  }

  return { id: session.video_id, permalink };
}

export type DownloadedVideo = {
  upload: VideoUpload;
  /** Removes the temp file. Safe to call more than once. */
  cleanup: () => Promise<void>;
};

/**
 * Stream a hosted video (e.g. a staged Blob URL) to a temp file and hand it
 * to publishPageVideo. Bytes flow straight to disk so a 1 GB video never
 * touches the heap, and the size cap is enforced mid-stream.
 */
export async function downloadVideoFromUrl(
  url: string,
  filename = 'video.mp4',
): Promise<DownloadedVideo> {
  // The URL comes from the request body, so the server fetch must not become
  // a probe of the internal network: block loopback/private/link-local hosts
  // and allow only http(s).
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The attached video URL is not allowed.');
  }
  const host = parsed.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\[::1\]$/.test(host) ||
    /^\[f[cd]/i.test(host);
  if (privateHost) {
    throw new Error('The attached video URL is not allowed.');
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error('The attached video could not be read from storage.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'ph-video-'));
  const filePath = path.join(dir, filename);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  let size = 0;
  try {
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += (chunk as Uint8Array).byteLength;
        if (size > MAX_VIDEO_BYTES) {
          cb(new Error('Videos must be 1 GB or smaller.'));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(res.body as never, counter, createWriteStream(filePath));
  } catch (error) {
    await cleanup();
    throw error;
  }

  if (size === 0) {
    await cleanup();
    throw new Error('The attached video could not be read from storage.');
  }

  return {
    upload: {
      path: filePath,
      size,
      type: res.headers.get('content-type') || 'video/mp4',
      filename,
    },
    cleanup,
  };
}
