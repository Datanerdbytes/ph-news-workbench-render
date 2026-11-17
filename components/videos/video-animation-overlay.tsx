'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  attachmentsFromSlots,
  planVideoEffects,
  plannedVideoFrames,
  videoEffectRenderer,
  type PresetSlot,
  type PresetValues,
} from '@/lib/videos/presets';

/**
 * Letterboxed content area of `videoWidth × videoHeight` footage inside a
 * `boxWidth × boxHeight` element that centers it with object-contain.
 */
export function contentBox(
  videoWidth: number,
  videoHeight: number,
  boxWidth: number,
  boxHeight: number
) {
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const w = videoWidth * scale;
  const h = videoHeight * scale;
  return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h };
}

/**
 * Live preview of the attached animation presets: a transparent canvas drawn
 * over the video's playhead so the composer shows the same overlays the bake
 * renders on post. Camera presets (scale) zoom the video element itself.
 *
 * Must be placed inside the media box that contains the video element, which
 * the canvas overlays.
 */
export function VideoAnimationOverlay({
  videoRef,
  slots,
  loops,
  values,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  slots: Record<PresetSlot, string | null>;
  loops: Record<PresetSlot, boolean>;
  values: Record<string, PresetValues>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = attachmentsFromSlots(slots, loops).length > 0;

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const attachments = attachmentsFromSlots(slots, loops);
    let raf = 0;
    let lastT = -1;
    let lastW = 0;
    let lastH = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Idle previews (paused, hidden tab) redraw once and then stay quiet;
      // seeking changes currentTime and repaints the frozen frame.
      if (document.hidden) return;
      const t = video.currentTime;
      const cw = video.clientWidth;
      const ch = video.clientHeight;
      if (!cw || !ch) return;
      if (video.paused && t === lastT && cw === lastW && ch === lastH) return;
      lastT = t;
      lastW = cw;
      lastH = ch;
      const duration =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const box = contentBox(
        video.videoWidth || 16,
        video.videoHeight || 9,
        cw,
        ch
      );
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.max(2, Math.round(box.w * dpr));
      const ph = Math.max(2, Math.round(box.h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = `${box.w}px`;
      canvas.style.height = `${box.h}px`;
      canvas.style.left = `${box.x}px`;
      canvas.style.top = `${box.y}px`;

      const effects = planVideoEffects(attachments, duration, values);
      const frames = plannedVideoFrames(effects, video.currentTime);
      let zoom = 1;
      for (const { effect, local } of frames) {
        if (effect.preset.scale) zoom *= effect.preset.scale(local);
      }
      video.style.transform = zoom === 1 ? '' : `scale(${zoom})`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.w, box.h);
      for (const { effect, local } of frames) {
        const render = videoEffectRenderer(effect);
        if (!render) continue;
        ctx.save();
        render(ctx, local, effect.preset.duration, effect.values, {
          w: box.w,
          h: box.h,
        });
        ctx.restore();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.style.transform = '';
    };
  }, [active, slots, loops, values, videoRef]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute"
    />
  );
}
