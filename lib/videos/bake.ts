import { pickMimeType } from '@/lib/reels/bake';
import { finalizeBakedVideo } from '@/lib/reels/browser-normalize';
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
 * Bakes video overlays into footage, in the browser, at the source aspect
 * ratio.
 *
 * The video plays through once while each frame is composited onto a canvas the
 * same shape as the source (longest side capped at 1920): cover-cropped
 * footage, any camera zoom, then every attached overlay. The canvas stream is
 * recorded together with the video's audio, and the caller finalizes the
 * recording with finalizeBakedVideo (browser-normalize.ts) before publishing.
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
  const { videoUrl, attachments, values, onProgress, maxSide } = options;
  const usable = attachments.some((attachment) => {
    const preset = getVideoPreset(attachment.presetId);
    return (
      preset &&
      preset.id !== 'none' &&
      (preset.draw || preset.scale) &&
      preset.slots.includes(attachment.slot)
    );
  });
  if (!usable) throw new Error('Unknown animation preset.');

  const mimeType = pickMimeType();
  if (!mimeType || typeof HTMLCanvasElement === 'undefined') {
    throw new Error('This browser cannot record the animation.');
  }

  const video = document.createElement('video');
  video.src = videoUrl;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Could not read the video.'));
  });

  const box = outputSize(video.videoWidth, video.videoHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable.');

  // Route the video's audio into the recording while keeping the speakers
  // silent (unmuted capture through a zero-gain monitor).
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaElementSource(video);
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);
  const monitor = audioCtx.createGain();
  monitor.gain.value = 0;
  source.connect(monitor);
  monitor.connect(audioCtx.destination);
  if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});

  const stream = canvas.captureStream(30);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);

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
  try {
    await video.play();
  } catch {
    // Never retry muted: the audio is captured through the AudioContext from
    // this element, so a muted play would bake a silent video. Fail loudly and
    // let the caller post the original footage instead.
    await audioCtx.close().catch(() => {});
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      'Playback was blocked, so the animation bake was skipped. Try posting again — the video still publishes without it.'
    );
  }
  recorder.start(250);

  const duration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const effects = planVideoEffects(attachments, duration, values);

  let playbackError: Error | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const fps = 30;
      const minFrameMs = 1000 / fps;
      const start = performance.now();
      let lastFrameTime = start;
      let lastProgressAt = start;
      let lastPlayhead = 0;
      let raf = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(raf);
        if (error) reject(error);
        else resolve();
      };
      const tick = () => {
        const now = performance.now();
        const playhead = video.currentTime;
        if (now - lastFrameTime >= minFrameMs) {
          do {
            lastFrameTime += minFrameMs;
          } while (now - lastFrameTime >= minFrameMs);
          ctx.clearRect(0, 0, box.w, box.h);
          composeVideoFrame(
            ctx,
            effects,
            playhead,
            (zoom) => drawFootage(ctx, video, box, zoom),
            box
          );
          if (duration) onProgress?.(Math.min(1, playhead / duration));
        }
        if (duration && playhead >= duration - 0.05) {
          finish();
          return;
        }
        if (playhead > lastPlayhead + 0.01) {
          lastPlayhead = playhead;
          lastProgressAt = now;
        } else if (now - lastProgressAt > 15_000) {
          finish(new Error('The video stopped playing during the bake.'));
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      video.onended = () => finish();
      video.onerror = () =>
        finish(new Error('The video stopped playing during the bake.'));
    });
  } catch (error) {
    playbackError =
      error instanceof Error ? error : new Error('The bake was interrupted.');
  }

  video.pause();
  if (recorder.state !== 'inactive') recorder.stop();
  const blob = await finished;
  stream.getTracks().forEach((track) => track.stop());
  await audioCtx.close().catch(() => {});
  video.src = '';
  if (playbackError) throw playbackError;
  if (blob.size === 0) throw new Error('Recording produced no data.');
  return blob;
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
  return finalizeBakedVideo(baked, options.onProgress);
}
