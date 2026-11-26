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
import {
  getVideoPreset,
  planVideoEffects,
  plannedVideoFrames,
  videoEffectRenderer,
  type AnimationBox,
  type PlannedVideoEffect,
  type PresetValues,
  type VideoAttachment,
} from './presets';

/**
 * Bakes video overlays into footage, in the browser, at the requested aspect
 * ratio.
 *
 * The video plays through once while each frame is composited onto a
 * source-aspect canvas (longest side capped at 1920) or a cover-cropped 16:9
 * canvas: footage, any camera zoom, then every attached overlay. The canvas
 * stream is recorded together with the video's audio, and the caller finalizes
 * the recording with finalizeBakedVideo (browser-normalize.ts) before publishing.
 */

const MAX_SIDE = 1920;

/** Output canvas size for source footage, keeping aspect and even dimensions. */
export function outputSize(vw: number, vh: number, maxSide = MAX_SIDE) {
  const width = Number.isFinite(vw) && vw > 0 ? vw : 1920;
  const height = Number.isFinite(vh) && vh > 0 ? vh : 1080;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { w: even(width * scale), h: even(height * scale) };
}

export function widescreenSize(maxSide = MAX_SIDE) {
  return outputSize(1920, 1080, maxSide);
}

/** Draw the current video frame cover-cropped into the output box. */
function drawFootage(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  box: AnimationBox,
  zoom: number
) {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.max(box.w / vw, box.h / vh) * zoom;
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (box.w - dw) / 2, (box.h - dh) / 2, dw, dh);
}

export type BakeVideoOptions = {
  /** Blob URL of the source footage. */
  videoUrl: string;
  attachments: VideoAttachment[];
  values: Record<string, PresetValues>;
  onProgress?: (fraction: number) => void;
  /** Longest output side; defaults to 1920. */
  maxSide?: number;
  aspectRatio?: 'source' | '16:9';
  /** Generated speech mixed at full volume over the footage. */
  narration?: Blob;
  /** Original footage volume while narration or an avatar is present. */
  originalAudioVolume?: number;
  /** Managed avatar MP4 composited above the footage. */
  avatarUrl?: string;
  avatarPlacement?: AvatarPlacement;
};

/**
 * Draws one composited frame: footage (with every active camera zoom
 * multiplied in), then each active overlay in attachment order. Exported for
 * tests.
 */
export function composeVideoFrame(
  ctx: CanvasRenderingContext2D,
  effects: PlannedVideoEffect[],
  videoTime: number,
  draw: (zoom: number) => void,
  box: AnimationBox
): void {
  let zoom = 1;
  const frames = plannedVideoFrames(effects, videoTime);
  for (const { effect, local } of frames) {
    if (effect.preset.scale) zoom *= effect.preset.scale(local);
  }
  draw(zoom);
  for (const { effect, local } of frames) {
    const render = videoEffectRenderer(effect);
    if (!render) continue;
    ctx.save();
    render(ctx, local, effect.preset.duration, effect.values, box);
    ctx.restore();
  }
}

/**
 * Renders the video with the picked animations baked in. Resolves with the
 * recording (MP4 where the browser supports it, WebM otherwise); throws when
 * the browser cannot record.
 */
export async function bakeVideoAnimation(
  options: BakeVideoOptions
): Promise<Blob> {
  const {
    videoUrl,
    attachments,
    values,
    onProgress,
    maxSide,
    aspectRatio = 'source',
    narration,
    originalAudioVolume,
    avatarUrl,
    avatarPlacement = DEFAULT_AVATAR_PLACEMENT,
  } = options;
  const hasAvatar = Boolean(avatarUrl);
  const hasNarration = Boolean(narration);
  if (hasAvatar && hasNarration) {
    throw new Error('Choose either a voice-over or an avatar video for the bake.');
  }
  const usable = attachments.some((attachment) => {
    const preset = getVideoPreset(attachment.presetId);
    return (
      preset &&
      preset.id !== 'none' &&
      (preset.draw || preset.scale) &&
      preset.slots.includes(attachment.slot)
    );
  });
  if (!usable && !hasNarration && !hasAvatar) {
    throw new Error('Unknown animation preset.');
  }

  const mimeType = pickMimeType();
  if (!mimeType || typeof HTMLCanvasElement === 'undefined') {
    throw new Error(
      hasAvatar
        ? 'This browser cannot record the avatar composite.'
        : hasNarration
          ? 'This browser cannot record the voice-over.'
          : 'This browser cannot record the animation.'
    );
  }

  const video = document.createElement('video');
  video.src = videoUrl;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Could not read the video.'));
  });

  let loadedAvatar: LoadedAvatarVideo | undefined;
  if (avatarUrl) {
    try {
      loadedAvatar = await loadAvatarVideo(avatarUrl);
    } catch (error) {
      video.src = '';
      throw error;
    }
  }
  const avatar = loadedAvatar?.video;
  const box =
    aspectRatio === '16:9'
      ? widescreenSize(maxSide)
      : outputSize(video.videoWidth, video.videoHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    loadedAvatar?.release();
    video.src = '';
    throw new Error('Canvas is unavailable.');
  }

  const audioCtx = new AudioContext();
  let audioMix: AudioMix;
  try {
    audioMix = await createAudioMix(audioCtx, {
      video,
      avatar,
      narration,
      originalVolume: originalAudioVolume,
    });
  } catch (error) {
    loadedAvatar?.release();
    video.src = '';
    await audioCtx.close().catch(() => {});
    throw error;
  }
  const videoDuration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const avatarDuration =
    avatar && Number.isFinite(avatar.duration) && avatar.duration > 0
      ? avatar.duration
      : 0;
  const renderDuration = Math.max(videoDuration, audioMix.duration);
  if ((hasNarration || hasAvatar) && renderDuration > MAX_NARRATED_SECONDS) {
    audioMix.stop();
    loadedAvatar?.release();
    video.src = '';
    await audioCtx.close().catch(() => {});
    throw new Error(
      hasAvatar
        ? 'Avatar composite videos are limited to 10 minutes.'
        : 'Narrated videos are limited to 10 minutes.',
    );
  }

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(30);
    for (const track of audioMix.destination.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  } catch (error) {
    audioMix.stop();
    loadedAvatar?.release();
    video.src = '';
    await audioCtx.close().catch(() => {});
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

    video.currentTime = 0;
    if (avatar) avatar.currentTime = 0;
    try {
      await Promise.all([
        video.play(),
        ...(avatar ? [avatar.play()] : []),
      ]);
    } catch {
      video.pause();
      avatar?.pause();
      // Never retry muted: the audio is captured through the AudioContext from
      // these elements, so muted playback would bake silent video.
      throw new Error(
        hasAvatar
          ? 'Playback was blocked, so the avatar composite bake was skipped. Try posting again.'
          : hasNarration
            ? 'Playback was blocked, so the voice-over bake was skipped. Try posting again.'
            : 'Playback was blocked, so the animation bake was skipped. Try posting again — the video still publishes without it.'
      );
    }
    recorder.start(250);
    if (hasAvatar) audioMix.startAvatar();
    else audioMix.startNarration();

    const effects = planVideoEffects(attachments, videoDuration, values);
    const holdForAudio = audioMix.duration > videoDuration;
    const renderStartedAt = performance.now();

    let playbackError: Error | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const fps = 30;
        const minFrameMs = 1000 / fps;
        const start = renderStartedAt;
        let lastFrameTime = start;
        let lastProgressAt = start;
        let lastAvatarProgressAt = start;
        let lastPlayhead = 0;
        let lastAvatarPlayhead = 0;
        let videoEnded = false;
        let avatarEnded = false;
        let raf = 0;
        let settled = false;
        function finish(error?: Error) {
          if (settled) return;
          settled = true;
          cancelAnimationFrame(raf);
          document.removeEventListener('visibilitychange', onVisibility);
          if (error) reject(error);
          else resolve();
        }
        function finishIfReady() {
          const elapsed = (performance.now() - renderStartedAt) / 1000;
          const timelineDone = holdForAudio
            ? elapsed >= audioMix.duration - 0.02
            : videoEnded;
          if (timelineDone && (!avatar || avatarEnded)) finish();
        }
        function onVisibility() {
          if (document.hidden) {
            finish(
              new Error(
                hasAvatar
                  ? 'The tab was hidden, so the avatar composite bake was stopped.'
                  : hasNarration
                    ? 'The tab was hidden, so the voice-over bake was stopped.'
                    : 'The tab was hidden, so the animation bake was stopped.'
              )
            );
          }
        }
        const tick = () => {
          const now = performance.now();
          const playhead = videoEnded
            ? videoDuration
            : Math.min(video.currentTime, videoDuration || video.currentTime);
          const avatarPlayhead =
            avatar && !avatarEnded
              ? Math.min(avatar.currentTime, avatarDuration || avatar.currentTime)
              : avatarDuration;
          const elapsed = (now - renderStartedAt) / 1000;
          const timeline = holdForAudio ? elapsed : playhead;
          if (now - lastFrameTime >= minFrameMs) {
            do {
              lastFrameTime += minFrameMs;
            } while (now - lastFrameTime >= minFrameMs);
            ctx.clearRect(0, 0, box.w, box.h);
            composeVideoFrame(
              ctx,
              effects,
              timeline,
              (zoom) => drawFootage(ctx, video, box, zoom),
              box
            );
            if (avatar && !avatarEnded) {
              drawAvatarVideo(ctx, avatar, avatarPlacement, box.w, box.h);
            }
            if (renderDuration) {
              onProgress?.(Math.min(1, timeline / renderDuration));
            }
          }
          if (!videoEnded && videoDuration && playhead >= videoDuration - 0.05) {
            videoEnded = true;
          }
          finishIfReady();
          if (settled) return;
          if (!videoEnded && playhead > lastPlayhead + 0.01) {
            lastPlayhead = playhead;
            lastProgressAt = now;
          } else if (!videoEnded && now - lastProgressAt > 15_000) {
            finish(new Error('The attached video stopped playing during the bake.'));
            return;
          }
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
        // The tab can already be hidden by the time the listener lands (the
        // user switched away while playback was starting); no event fires in
        // that case, so reject up front.
        if (document.hidden) {
          onVisibility();
          return;
        }
        // A recorder failure has to end the take too — otherwise the fallback
        // waits for the rest of a long clip before it can run.
        finished.catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error('Recording failed.'));
        });
        video.onended = () => {
          videoEnded = true;
          finishIfReady();
        };
        video.onerror = () =>
          finish(new Error('The attached video stopped playing during the bake.'));
        if (avatar) {
          avatar.onended = () => {
            avatarEnded = true;
            finishIfReady();
          };
          avatar.onerror = () =>
            finish(new Error('The avatar stopped playing during the bake.'));
        }
      });
    } catch (error) {
      playbackError =
        error instanceof Error ? error : new Error('The bake was interrupted.');
    }

    video.pause();
    avatar?.pause();
    video.onended = null;
    video.onerror = null;
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
    if (!blob || blob.size === 0) throw new Error('Recording produced no data.');
    return blob;
  } finally {
    video.pause();
    stream.getTracks().forEach((track) => track.stop());
    audioMix.stop();
    loadedAvatar?.release();
    await audioCtx.close().catch(() => {});
    video.src = '';
  }
}

/**
 * Bakes the attached animations into the footage and finalizes the recording
 * into a publishable MP4. Throws on failure; callers fall back to the original
 * clip.
 */
export async function bakeAndFinalizeVideo(
  options: BakeVideoOptions
): Promise<File> {
  const baked = await bakeVideoAnimation(options);
  const aspectRatio = options.aspectRatio ?? 'source';
  return finalizeBakedVideo(baked, options.onProgress, {
    preserveAspect: aspectRatio === 'source' && Boolean(options.narration),
    aspectRatio: aspectRatio === '16:9' ? '16:9' : undefined,
    name: options.avatarUrl
      ? 'avatar-composite.mp4'
      : options.narration
        ? 'narrated-video.mp4'
        : undefined,
  });
}
