import { rm } from 'node:fs/promises';
import {
  assertStagedBlob,
  stagedFileExtension,
  stagedFileToTempFile,
} from '@/lib/blob';
import {
  createYouTubeUploadSession,
  uploadYouTubeFile,
  YouTubeMetadata,
} from '@/lib/youtube';

export type YouTubePublishResult = {
  id: string;
  permalink: string;
};

/** Blob staging caps uploads at 1 GB — held until YouTube streaming lands. */
const YOUTUBE_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

function contentTypeForUrl(url: string): string {
  // stagedFileExtension strips the random suffix stagedKey() appends, so a
  // staged ".mov" is still recognised as QuickTime.
  return stagedFileExtension(url) === '.mov' ? 'video/quicktime' : 'video/mp4';
}

/**
 * End-to-end video publish: staged blob → temp file on disk → resumable
 * upload session → streamed upload → video id. Processing on YouTube's side
 * is async; processing state lives in YouTube's studio, not our queue.
 * The temp-file leg replaced stagedFileToBuffer: holding a 1 GB staged video
 * (plus a second copy for the upload body) OOM-killed 512 MB instances.
 */
export async function publishYouTubeVideo({
  accessToken,
  metadata,
  videoUrl,
}: {
  accessToken: string;
  metadata: YouTubeMetadata;
  videoUrl: string;
}): Promise<YouTubePublishResult> {
  await assertStagedBlob(videoUrl);
  const staged = await stagedFileToTempFile(videoUrl);
  try {
    if (staged.size === 0) {
      throw new Error('The staged video file is empty.');
    }
    if (staged.size > YOUTUBE_UPLOAD_MAX_BYTES) {
      throw new Error(
        'The video is larger than the 1 GB staging cap. Trim the file and retry.'
      );
    }
    const contentType = contentTypeForUrl(videoUrl);
    const location = await createYouTubeUploadSession({
      accessToken,
      sizeBytes: staged.size,
      contentType,
      metadata,
    });
    const id = await uploadYouTubeFile(location, staged.path, staged.size, contentType);
    return {
      id,
      permalink: `https://www.youtube.com/watch?v=${id}`,
    };
  } finally {
    await rm(staged.workDir, { recursive: true, force: true });
  }
}
