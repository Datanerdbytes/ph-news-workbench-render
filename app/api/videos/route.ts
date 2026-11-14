import { NextResponse } from 'next/server';
import { stripMarkdown } from '@/lib/format';
import { requirePublishingConnection } from '@/lib/publishing/connection';
import {
  crosspostResponse,
  publishToSelectedPages,
} from '@/lib/publishing/crosspost';
import { facebookErrorResponse } from '@/lib/publishing/errors';
import { readPageIds, readText } from '@/lib/publishing/request';
import { parseScheduledPublishTime } from '@/lib/publishing/schedule';
import { MAX_VIDEO_BYTES, publishPageVideo } from '@/lib/publishing/videos';
import { notifyPublishAttemptFailure } from '@/lib/notifications';
import { recordNativeSchedule } from '@/lib/schedule-mirror';
import { readMp4DurationSecondsFromFile } from '@/lib/reel-meta';
import {
  cleanupParsedMultipart,
  parseMultipartToDisk,
  uploadedFileType,
  MultipartTooLargeError,
  type ParsedMultipart,
} from '@/lib/media-file';

export const dynamic = 'force-dynamic';

const MAX_DURATION_SECONDS = 45 * 60;
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request) {
  const result = await requirePublishingConnection(request, 'publish videos');
  if (result.response) return result.response;

  const { access } = result.context;

  // The file was attached but Facebook's formats or our envelope reject it —
  // ring the bell like any other failed post attempt.
  const notifyFailure = (reason: string) =>
    notifyPublishAttemptFailure({
      workspaceId: access.workspace.id,
      kind: 'video',
      reason,
    });

  // Stream the multipart body to disk instead of request.formData(), which
  // buffers the whole upload in the heap (the Render 512 MB OOM).
  let parsed: ParsedMultipart;
  try {
    parsed = await parseMultipartToDisk(request, {
      video: { maxBytes: MAX_VIDEO_BYTES, spool: 'file' },
      thumbnail: { maxBytes: MAX_THUMBNAIL_BYTES, spool: 'memory' },
    });
  } catch (error) {
    if (error instanceof MultipartTooLargeError) {
      const message =
        error.part === 'thumbnail'
          ? 'Thumbnails must be 20 MB or smaller.'
          : 'Videos must be 1 GB or smaller.';
      // Only the video itself rings the failure bell — thumbnail problems
      // are envelope errors, like the original formData() flow.
      if (error.part !== 'thumbnail') await notifyFailure(message);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: 'Choose an MP4 or MOV video.' },
      { status: 400 }
    );
  }

  try {
    const video = parsed.files.video;
    if (!video || video.kind !== 'file' || video.size === 0) {
      return NextResponse.json(
        { error: 'Choose an MP4 or MOV video.' },
        { status: 400 }
      );
    }

    // uploadedFileType falls back to the filename when the client sent no
    // Content-Type — the same signal request.formData() used to give us.
    const looksLikeVideo = VIDEO_TYPES.has(uploadedFileType(video));
    if (!looksLikeVideo) {
      const message = 'Upload an MP4 or MOV video.';
      await notifyFailure(message);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (video.size > MAX_VIDEO_BYTES) {
      const message = 'Videos must be 1 GB or smaller.';
      await notifyFailure(message);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const title = stripMarkdown(readText(parsed.fields.title, 200));
    const description = stripMarkdown(readText(parsed.fields.description, 5000));
    if (!title && !description) {
      return NextResponse.json(
        { error: 'Add a title or description for the video.' },
        { status: 400 }
      );
    }

    let thumbnail: { bytes: Buffer; type: string; filename: string } | null =
      null;
    const thumbnailFile = parsed.files.thumbnail;
    // An empty part is not a thumbnail — an <input type="file"> the user
    // never picked still posts a zero-byte part, and Facebook rejects a
    // 0-byte image with an opaque error.
    if (
      thumbnailFile &&
      thumbnailFile.kind === 'buffer' &&
      thumbnailFile.buffer.length > 0
    ) {
      if (!IMAGE_TYPES.has(uploadedFileType(thumbnailFile))) {
        return NextResponse.json(
          { error: 'Thumbnails must be JPEG, PNG, or WebP.' },
          { status: 400 }
        );
      }
      if (thumbnailFile.buffer.length > MAX_THUMBNAIL_BYTES) {
        return NextResponse.json(
          { error: 'Thumbnails must be 20 MB or smaller.' },
          { status: 400 }
        );
      }
      thumbnail = {
        bytes: thumbnailFile.buffer,
        type: uploadedFileType(thumbnailFile),
        filename: thumbnailFile.filename || 'thumbnail.jpg',
      };
    }

    let feedTargeting = '';
    const rawTargeting = parsed.fields.feedTargeting;
    if (typeof rawTargeting === 'string' && rawTargeting.trim()) {
      try {
        const parsedTargeting = JSON.parse(rawTargeting);
        if (
          !parsedTargeting ||
          typeof parsedTargeting !== 'object' ||
          Array.isArray(parsedTargeting)
        ) {
          throw new Error('not an object');
        }
        feedTargeting = JSON.stringify(parsedTargeting);
      } catch {
        return NextResponse.json(
          {
            error:
              'Audience targeting must be a JSON object, for example {"geo_locations":{"countries":["PH"]}}.',
          },
          { status: 400 }
        );
      }
    }

    const schedule = parseScheduledPublishTime(parsed.fields.scheduledFor);
    if (schedule.error) {
      return NextResponse.json({ error: schedule.error }, { status: 400 });
    }

    const pageIds = readPageIds(parsed.fields.pageIds);
    const duration = await readMp4DurationSecondsFromFile(video.path);
    if (duration !== null && duration > MAX_DURATION_SECONDS) {
      const message = `Facebook videos must be 45 minutes or shorter. This video is ${Math.round(duration / 60)} minutes.`;
      await notifyFailure(message);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
      const { results } = await publishToSelectedPages({
        workspaceId: access.workspace.id,
        pageIds,
        publish: (page) =>
          publishPageVideo({
            pageId: page.id,
            accessToken: page.accessToken,
            title,
            description,
            video: {
              path: video.path,
              size: video.size,
              type: uploadedFileType(video) || 'video/mp4',
              filename: video.filename || 'video.mp4',
            },
            thumbnail,
            feedTargeting,
            scheduledPublishTime: schedule.unix,
          }),
      });

      await recordNativeSchedule({
        workspaceId: access.workspace.id,
        userId: access.user.id,
        kind: 'video',
        text: title,
        scheduledFor: schedule.unix ? new Date(schedule.unix * 1000) : null,
        results,
      });

      return crosspostResponse(
        results,
        {
          scheduledFor: schedule.unix
            ? new Date(schedule.unix * 1000).toISOString()
            : null,
        },
        {
          workspaceId: access.workspace.id,
          actorUserId: access.user.id,
          kind: 'video',
        }
      );
    } catch (error) {
      return facebookErrorResponse(
        error,
        'video_failed',
        'The video could not be published.',
        {
          workspaceId: access.workspace.id,
          kind: 'video',
        }
      );
    }
  } finally {
    await cleanupParsedMultipart(parsed);
  }
}
