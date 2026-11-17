import { gsap } from 'gsap';
import {
  getVideoPreset,
  type AnimationBox,
  type PresetValues,
} from './presets';

export type PreviewHandle = { kill: () => void };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Simulated footage so translucent panels and camera moves read correctly on
 * a card that has no video behind it. */
function drawBackdrop(ctx: CanvasRenderingContext2D, box: AnimationBox) {
  const gradient = ctx.createRadialGradient(
    box.w * 0.24,
    box.h * 0.14,
    0,
    box.w * 0.5,
    box.h * 0.5,
    Math.hypot(box.w, box.h) * 0.72
  );
  gradient.addColorStop(0, '#93b1bd');
  gradient.addColorStop(0.46, '#5e7d8a');
  gradient.addColorStop(1, '#2d4954');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, box.w, box.h);

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#e7f0f4';
  ctx.beginPath();
  ctx.arc(box.w * 0.78, box.h * 0.3, box.h * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  ctx.arc(box.w * 0.18, box.h * 0.82, box.h * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * GSAP-driven looping preview of one video preset, painted into a canvas.
 *
 * The same `draw` the bake uses is sampled each tick, so the card is a true
 * preview of the rendered result — including camera presets, whose zoom is
 * applied to the simulated backdrop.
 */
export function mountVideoPreset(
  stage: HTMLElement,
  presetId: string,
  values: PresetValues,
  box: AnimationBox
): PreviewHandle | null {
  const preset = getVideoPreset(presetId);
  if (!preset || preset.id === 'none' || !preset.draw) return null;

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

  const drawAt = (t: number) => {
    ctx.clearRect(0, 0, box.w, box.h);
    const zoom = preset.scale ? preset.scale(t) : 1;
    ctx.save();
    ctx.translate(box.w / 2, box.h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-box.w / 2, -box.h / 2);
    drawBackdrop(ctx, box);
    ctx.restore();
    ctx.save();
    preset.draw!(ctx, t, preset.duration, values, box);
    ctx.restore();
  };

  if (prefersReducedMotion()) {
    drawAt(preset.duration * 0.55);
    return { kill: () => canvas.remove() };
  }

  const proxy = { t: 0 };
  const tween = gsap.to(proxy, {
    t: preset.duration,
    duration: preset.duration,
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
