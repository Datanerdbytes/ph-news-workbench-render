import { createReadStream, type ReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import {
  localRuntimeEnabled,
  probeVideoDurationSeconds,
  transcodeToReelFootage,
} from '@/lib/reels/media';
import { requireWorkspace, unauthorized } from '@/lib/session';
import {
  parseMultipartToDisk,
  uploadedFileType,
  MultipartTooLargeError,
  type ParsedMultipart,
} from '@/lib/media-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIN_DURATION = 3;
// Facebook's chunked video upload (used for clips over 90 seconds) accepts
// up to 45 minutes; the reel-length cap lives in the publish route only.
const MAX_DURATION = 45 * 60;
const MAX_BYTES = 1024 * 1024 * 1024;
// WebM is accepted for reels baked in the browser (the GSAP animation overlay
// is recorded to WebM by MediaRecorder) — it is transcoded to H.264 MP4 here
// like every other input.
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Normalize an uploaded reel to H.264/AAC 1080×1920 before preview or
 * publishing. Browsers without AV1/HEVC support (Safari) cannot even preview
 * such files, and Facebook prefers standard encodings, so the Reels page runs
 * every picked video through here first.
 *
 * Everything streams: the upload spools to a temp file (request.formData()
 * used to hold two full copies of the video in the heap — the Render 512 MB
 * OOM), and the transcoded file streams back out instead of readFile().
 */
export async function POST(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  if (!localRuntimeEnabled()) {
    return NextResponse.json(
      {
        error:
          'Video normalization runs locally only. The original video will be used.',
      },
      { status: 503 }
    );
  }

  let parsed: ParsedMultipart;
  try {
    parsed = await parseMultipartToDisk(request, {
      video: { maxBytes: MAX_BYTES, spool: 'file' },
    });
  } catch (error) {
    if (error instanceof MultipartTooLargeError) {
      return NextResponse.json(
        { error: 'Videos must be 1 GB or smaller.' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Choose an MP4 or MOV video.' },
      { status: 400 }
    );
  }

  // The reader for the response body, once it exists: a body that is never
  // consumed would otherwise hold the fd open past the workDir's removal.
  let outputStream: ReadStream | null = null;
  const cleanup = async () => {
    outputStream?.destroy();
    await rm(parsed.workDir, { recursive: true, force: true });
  };

  // Once the response streams from the workDir, deletion must wait for the
  // stream to close — finally{} would rm the file before the runtime reads it.
  let streaming = false;
  // A client that disconnects before the body is read never fires 'close',
  // so the abort is the only signal left to reclaim the workDir.
  request.signal.addEventListener(
    'abort',
    () => {
      void cleanup();
    },
    { once: true }
  );
  try {
    const video = parsed.files.video;
    if (!video || video.kind !== 'file' || video.size === 0) {
      return NextResponse.json(
        { error: 'Choose an MP4 or MOV video.' },
        { status: 400 }
      );
    }
    const looksLikeVideo = VIDEO_TYPES.has(uploadedFileType(video));
    if (!looksLikeVideo) {
      return NextResponse.json(
        { error: 'Upload an MP4 or MOV video.' },
        { status: 400 }
      );
    }

    const inputPath = video.path;
    const outputPath = path.join(parsed.workDir, 'output.mp4');

    let duration = await probeVideoDurationSeconds(inputPath);
    let transcoded = false;
    if (duration === null) {
      // MediaRecorder WebM (browser-baked animation reels) carries no Duration
      // header, so ffprobe cannot read it up front. Transcode first — the
      // H.264 MP4 output is well-formed — and probe that instead.
      await transcodeToReelFootage(inputPath, outputPath);
      transcoded = true;
      duration = await probeVideoDurationSeconds(outputPath);
      if (duration === null) {
        return NextResponse.json(
          { error: 'Could not read the video. Is it a valid video file?' },
          { status: 400 }
        );
      }
    }
    if (duration < MIN_DURATION || duration > MAX_DURATION) {
      return NextResponse.json(
        {
          error: `Facebook reels must be ${MIN_DURATION} seconds to ${Math.floor(MAX_DURATION / 60)} minutes (this one is ${duration.toFixed(1)}s).`,
        },
        { status: 400 }
      );
    }

    if (!transcoded) {
      await transcodeToReelFootage(inputPath, outputPath);
    }
    const { size } = await stat(outputPath);

    outputStream = createReadStream(outputPath);
    outputStream.on('close', () => {
      void cleanup();
    });
    const response = new NextResponse(
      Readable.toWeb(outputStream) as unknown as ReadableStream<Uint8Array>,
      {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(size),
          'cache-control': 'no-store',
        },
      }
    );
    streaming = true;
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The video could not be normalized.',
      },
      { status: 500 }
    );
  } finally {
    if (!streaming) await cleanup();
  }
}
