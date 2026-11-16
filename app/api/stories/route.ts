import { NextResponse } from 'next/server';
import type { PublishImage } from '@/lib/facebook';
import { requirePublishingConnection } from '@/lib/publishing/connection';
import {
  crosspostResponse,
  publishToSelectedPages,
  type CrosspostResult,
} from '@/lib/publishing/crosspost';
import { facebookErrorResponse } from '@/lib/publishing/errors';
import { readPageIds } from '@/lib/publishing/request';
import {
  MAX_STORY_VIDEO_BYTES,
  publishPhotoStory,
  publishVideoStory,
} from '@/lib/publishing/stories';
import {
  cleanupParsedMultipart,
  parseMultipartToDisk,
  uploadedFileType,
  MultipartTooLargeError,
  type ParsedMultipart,
} from '@/lib/media-file';
import { recordNativeSchedule } from '@/lib/schedule-mirror';

export const dynamic = 'force-dynamic';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const result = await requirePublishingConnection(request, 'publish stories');
  if (result.response) return result.response;

  const { access } = result.context;

  /**
   * Stories are a Facebook format the mirror did not know about, so every
   * publish used to leave no local trace — the Dashboard's per-platform
   * counters would have stayed at zero forever. Mirroring is best-effort:
   * the mirror swallows its own failures, so a broken row never undoes a
   * story that is already live.
   */
  const recordStory = (results: CrosspostResult[]) =>
    recordNativeSchedule({
      workspaceId: access.workspace.id,
      userId: access.user.id,
      kind: 'story',
      text: '',
      scheduledFor: null,
      results,
    });

  // Videos spool to disk; photos (≤20 MB) stay in memory. request.formData()
  // buffered the whole upload in the heap — the Render 512 MB OOM.
  let parsed: ParsedMultipart;
  try {
    parsed = await parseMultipartToDisk(request, {
      photo: { maxBytes: MAX_IMAGE_BYTES, spool: 'memory' },
      video: { maxBytes: MAX_STORY_VIDEO_BYTES, spool: 'file' },
    });
  } catch (error) {
    if (error instanceof MultipartTooLargeError) {
      return NextResponse.json(
        {
          error:
            error.part === 'video'
              ? 'Story videos must be 100 MB or smaller.'
              : 'Photo stories must be 20 MB or smaller.',
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Choose a photo or video story.' },
      { status: 400 }
    );
  }

  try {
    const kind = parsed.fields.kind;
    if (kind !== 'photo' && kind !== 'video') {
      return NextResponse.json(
        { error: 'Choose a photo or video story.' },
        { status: 400 }
      );
    }

    const pageIds = readPageIds(parsed.fields.pageIds);

    if (kind === 'photo') {
      const file = parsed.files.photo;
      const url = parsed.fields.photoUrl;
      let image: PublishImage | null = null;

      if (file && file.kind === 'buffer' && file.buffer.length > 0) {
        // uploadedFileType falls back to the filename when the client sent
        // no Content-Type — the same signal request.formData() used to give.
        const fileType = uploadedFileType(file);
        if (!IMAGE_TYPES.has(fileType)) {
          return NextResponse.json(
            { error: 'Photo stories must be JPEG, PNG, or WebP.' },
            { status: 400 }
          );
        }
        const extension =
          fileType === 'image/jpeg'
            ? 'jpg'
            : fileType === 'image/webp'
              ? 'webp'
              : 'png';
        image = {
          base64: file.buffer.toString('base64'),
          type: fileType,
          filename: `story.${extension}`,
        };
      } else if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
        image = { url: url.trim() };
      }

      if (!image) {
        return NextResponse.json(
          { error: 'Choose a photo or paste a public image URL.' },
          { status: 400 }
        );
      }

      const { results } = await publishToSelectedPages({
        workspaceId: access.workspace.id,
        pageIds,
        publish: (page) =>
          publishPhotoStory({
            pageId: page.id,
            accessToken: page.accessToken,
            image,
          }),
      });

      await recordStory(results);

      return crosspostResponse(
        results,
        { kind },
        {
          workspaceId: access.workspace.id,
          actorUserId: access.user.id,
          kind,
        }
      );
    }

    const video = parsed.files.video;
    if (!video || video.kind !== 'file' || video.size === 0) {
      return NextResponse.json(
        { error: 'Choose an MP4 or MOV video for the story.' },
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

    const { results } = await publishToSelectedPages({
      workspaceId: access.workspace.id,
      pageIds,
      publish: (page) =>
        publishVideoStory({
          pageId: page.id,
          accessToken: page.accessToken,
          video: {
            path: video.path,
            size: video.size,
            type: uploadedFileType(video) || 'video/mp4',
            filename: video.filename || 'story.mp4',
          },
        }),
    });

    await recordStory(results);

    return crosspostResponse(
      results,
      { kind },
      {
        workspaceId: access.workspace.id,
        actorUserId: access.user.id,
        kind,
      }
    );
  } catch (error) {
    return facebookErrorResponse(
      error,
      'story_failed',
      'The story could not be published.'
    );
  } finally {
    await cleanupParsedMultipart(parsed);
  }
}
