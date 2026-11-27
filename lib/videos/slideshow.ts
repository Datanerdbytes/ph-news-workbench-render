import { pickMimeType } from '@/lib/reels/bake';
import { finalizeBakedVideo } from '@/lib/reels/browser-normalize';
import {
  createAudioMix,
  MAX_NARRATED_SECONDS,
  type AudioMix,
} from './audio-mix';
import {
  drawAvatarVideo,
  loadAvatarVideo,
  type LoadedAvatarVideo,
} from './avatar-video';
import {
  DEFAULT_AVATAR_PLACEMENT,
  type AvatarPlacement,
} from './composition';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

export type NarratedSlideshowOptions = {
  images: string[];
  narration?: Blob;
  avatarUrl?: string;
  avatarPlacement?: AvatarPlacement;
  onProgress?: (fraction: number) => void;
};

export function drawSlideshowImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width = WIDTH,
  height = HEIGHT,
): void {
  const sourceWidth = image.naturalWidth || width;
  const sourceHeight = image.naturalHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    const timer = setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('A photo could not be loaded for the slideshow.'));
    }, 15_000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error('A photo could not be loaded for the slideshow.'));
    };
    image.src = source;
  });
}

export async function bakeNarratedSlideshow(
  options: NarratedSlideshowOptions,
): Promise<Blob> {
  const hasNarration = Boolean(options.narration);
  const hasAvatar = Boolean(options.avatarUrl);
  if (hasNarration === hasAvatar) {
    throw new Error('Choose either a voice-over or an avatar video for the slideshow.');
  }
  if (!options.images.length) {
    throw new Error('Add at least one photo for the voice-over.');
  }
  const mimeType = pickMimeType();
  if (!mimeType || typeof HTMLCanvasElement === 'undefined') {
    throw new Error(
      hasAvatar
        ? 'This browser cannot record the avatar slideshow.'
        : 'This browser cannot record the voice-over slideshow.'
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');

  const audioContext = new AudioContext();
  let audioMix!: AudioMix;
  let loadedAvatar: LoadedAvatarVideo | undefined;
  let images: HTMLImageElement[];
  try {
    if (options.avatarUrl) {
      loadedAvatar = await loadAvatarVideo(options.avatarUrl);
    }
    audioMix = await createAudioMix(audioContext, {
      narration: options.narration,
      avatar: loadedAvatar?.video,
    });
    if (audioMix.duration > MAX_NARRATED_SECONDS) {
      throw new Error(
        hasAvatar
          ? 'Avatar slideshows are limited to 10 minutes.'
          : 'Narrated slideshows are limited to 10 minutes.'
      );
    }
    images = await Promise.all(options.images.map(loadImage));
  } catch (error) {
    audioMix?.stop();
    loadedAvatar?.release();
    await audioContext.close().catch(() => {});
    throw error;
  }

  const avatar = loadedAvatar?.video;
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(FPS);
    for (const track of audioMix.destination.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  } catch (error) {
    audioMix.stop();
    loadedAvatar?.release();
    await audioContext.close().catch(() => {});
    throw error;
  }

  try {
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const container = mimeType.startsWith('video/mp4')
          ? 'video/mp4'
          : 'video/webm';
        resolve(new Blob(chunks, { type: container }));
      };
      recorder.onerror = () => reject(new Error('Recording failed.'));
    });

    if (avatar) {
      avatar.currentTime = 0;
      try {
        await avatar.play();
      } catch {
        avatar.pause();
        throw new Error(
          'Playback was blocked, so the avatar slideshow bake was skipped. Try posting again.'
        );
      }
    }
    context.clearRect(0, 0, WIDTH, HEIGHT);
    drawSlideshowImage(context, images[0]);
    if (avatar) {
      drawAvatarVideo(
        context,
        avatar,
        options.avatarPlacement ?? DEFAULT_AVATAR_PLACEMENT,
        WIDTH,
        HEIGHT,
      );
    }
    recorder.start(250);
    if (hasAvatar) audioMix.startAvatar();
    else audioMix.startNarration();
    const startedAt = performance.now();
    let playbackError: Error | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        const minFrameMs = 1000 / FPS;
        let lastFrameAt = startedAt;
        let lastAvatarProgressAt = startedAt;
        let lastAvatarPlayhead = 0;
        let avatarEnded = avatar?.ended ?? false;
        let raf = 0;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          cancelAnimationFrame(raf);
          document.removeEventListener('visibilitychange', onVisibility);
          if (error) reject(error);
          else resolve();
        };
        const finishIfReady = () => {
          const elapsed = (performance.now() - startedAt) / 1000;
          if (elapsed >= audioMix.duration - 0.02 && (!avatar || avatarEnded)) {
            finish();
          }
        };
        const onVisibility = () => {
          if (document.hidden) {
            finish(
              new Error(
                hasAvatar
                  ? 'The tab was hidden, so the avatar slideshow was stopped.'
                  : 'The tab was hidden, so the voice-over slideshow was stopped.',
              ),
            );
          }
        };
        const tick = () => {
          const now = performance.now();
          const elapsed = (now - startedAt) / 1000;
          const avatarPlayhead =
            avatar && !avatarEnded
              ? Math.min(avatar.currentTime, audioMix.duration || avatar.currentTime)
              : audioMix.duration;
          if (now - lastFrameAt >= minFrameMs) {
            do {
              lastFrameAt += minFrameMs;
            } while (now - lastFrameAt >= minFrameMs);
            const index = Math.min(
              images.length - 1,
              Math.floor((elapsed / audioMix.duration) * images.length),
            );
            context.clearRect(0, 0, WIDTH, HEIGHT);
            drawSlideshowImage(context, images[index]);
            if (avatar) {
              drawAvatarVideo(
                context,
                avatar,
                options.avatarPlacement ?? DEFAULT_AVATAR_PLACEMENT,
                WIDTH,
                HEIGHT,
              );
            }
            options.onProgress?.(Math.min(1, elapsed / audioMix.duration));
          }
          finishIfReady();
          if (settled) return;
          if (avatar && !avatarEnded && avatarPlayhead > lastAvatarPlayhead + 0.01) {
            lastAvatarPlayhead = avatarPlayhead;
            lastAvatarProgressAt = now;
          } else if (avatar && !avatarEnded && now - lastAvatarProgressAt > 15_000) {
            finish(new Error('The avatar stopped playing during the bake.'));
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        document.addEventListener('visibilitychange', onVisibility);
        if (document.hidden) {
          onVisibility();
          return;
        }
        finished.catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error('Recording failed.'));
        });
        if (avatar) {
          avatar.onended = () => {
            avatarEnded = true;
            audioMix.restoreOriginalAudio();
            finishIfReady();
          };
          avatar.onerror = () =>
            finish(new Error('The avatar stopped playing during the bake.'));
        }
      });
    } catch (error) {
      playbackError =
        error instanceof Error ? error : new Error('The slideshow was interrupted.');
    }

    avatar?.pause();
    if (avatar) {
      avatar.onended = null;
      avatar.onerror = null;
    }
    if (recorder.state !== 'inactive') recorder.stop();
    let blob: Blob | null = null;
    try {
      blob = await finished;
    } catch (error) {
      playbackError ??=
        error instanceof Error ? error : new Error('Recording failed.');
    }
    if (playbackError) throw playbackError;
    if (!blob || blob.size === 0) {
      throw new Error('Recording produced no data.');
    }
    return blob;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    audioMix.stop();
    loadedAvatar?.release();
    await audioContext.close().catch(() => {});
  }
}

export async function bakeAndFinalizeNarratedSlideshow(
  options: NarratedSlideshowOptions,
): Promise<File> {
  const baked = await bakeNarratedSlideshow(options);
  return finalizeBakedVideo(baked, options.onProgress, {
    aspectRatio: '16:9',
    name: options.avatarUrl ? 'avatar-photos.mp4' : 'narrated-photos.mp4',
  });
}
