import { gsap } from 'gsap';
import {
  drawSlideshowFrame,
  getSlideshowPreset,
  type SlideshowBox,
} from './slideshow-presets';

export type PreviewHandle = { kill: () => void };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** How long each photo is showcased in the looping preview, seconds. */
const PREVIEW_WINDOW_SECONDS = 2.4;

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('A photo could not be loaded for the preview.'));
    image.src = source;
  });
}

/**
 * GSAP-driven looping preview of a slideshow preset painted over the real
 * attached photos. The same `draw` the bake samples per wall-clock frame is
 * sampled here each tick, so the card is a true preview of the baked result.
 */
export async function mountSlideshowPreset(
  stage: HTMLElement,
  presetId: string,
  images: string[],
  box: SlideshowBox,
): Promise<PreviewHandle | null> {
  const preset = getSlideshowPreset(presetId);
  if (!preset || images.length < 2) return null;

  let loaded: HTMLImageElement[];
  try {
    loaded = await Promise.all(images.map(loadImage));
  } catch {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = box.w;
  canvas.height = box.h;
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  stage.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return null;
  }

  const duration = Math.max(4, loaded.length * PREVIEW_WINDOW_SECONDS);
  const drawAt = (t: number) => {
    ctx.clearRect(0, 0, box.w, box.h);
    drawSlideshowFrame(ctx, loaded, t, duration, box, presetId);
  };

  if (prefersReducedMotion()) {
    // Park inside the first move so side cards show in the static frame.
    const window = duration / loaded.length;
    drawAt(window * 0.9);
    return { kill: () => canvas.remove() };
  }

  const proxy = { t: 0 };
  const tween = gsap.to(proxy, {
    t: duration,
    duration,
    ease: 'none',
    repeat: -1,
    repeatDelay: 0.55,
    onUpdate: () => drawAt(proxy.t),
    onRepeat: () => drawAt(0),
  });
  drawAt(0);

  return {
    kill: () => {
      tween.kill();
      canvas.remove();
    },
  };
}
