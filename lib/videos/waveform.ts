/**
 * Deterministic narration waveform overlay for baked slideshows.
 *
 * Like presets.ts, every draw here is a pure function of local time so the
 * GSAP-driven preview (voice-over panel) and the recorded bake render the
 * exact same frames — GSAP animates the preview timeline, the bake redraws
 * this draw per frame from the wall clock. No GSAP imports in this module.
 */

export const WAVEFORM_BAR_COUNT = 34;

const BAR_MIN = 0.14; // bars never flatten completely
const DANCE_BASE = 0.55; // oscillation floor around each peak
const DANCE_DEPTH = 0.45; // oscillation amplitude around each peak
const UPCOMING_ALPHA = 0.42;
const PLAYED_ALPHA = 0.95;
const POP_IN_SECONDS = 0.6;

/** Bar heights 0..1 from the decoded narration: max |sample| per bucket, normalized. */
export function computeNarrationPeaks(
  buffer: AudioBuffer,
  barCount = WAVEFORM_BAR_COUNT
): number[] {
  const count = Math.max(1, Math.floor(barCount));
  const channel = buffer.getChannelData(0);
  if (!channel.length) return new Array(count).fill(0);
  const bucketSize = Math.max(1, Math.floor(channel.length / count));
  const peaks: number[] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = bar * bucketSize;
    const end = Math.min(channel.length, start + bucketSize);
    let peak = 0;
    for (let sample = start; sample < end; sample += 1) {
      const amplitude = Math.abs(channel[sample]);
      if (amplitude > peak) peak = amplitude;
    }
    peaks.push(peak);
  }
  const loudest = Math.max(...peaks);
  if (loudest <= 0) return new Array(count).fill(0);
  return peaks.map((peak) => peak / loudest);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, h / 2, w / 2)));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/** Organic, reproducible motion for bar i at elapsed seconds. */
function dance(bar: number, elapsed: number) {
  const omega = 6 + (bar % 5) * 1.7;
  const phase = bar * 1.31;
  return DANCE_BASE + DANCE_DEPTH * Math.sin(elapsed * omega + phase);
}

/** Staggered pop-in during the first moments of the bake. */
function popIn(bar: number, elapsed: number) {
  const raw = clamp01((elapsed - bar * 0.015) / 0.35);
  return 1 - (1 - raw) ** 3;
}

export type WaveformDrawOptions = {
  box: { w: number; h: number };
  peaks: number[];
  /** Seconds into the narration — the same clock the bake's rAF loop uses. */
  elapsed: number;
  duration: number;
};

/**
 * Instagram-style pill: rounded translucent container, bottom-center, bars
 * dancing around the narration's real peaks with a playhead fade for the
 * portion already "spoken".
 */
export function drawNarrationWaveform(
  ctx: CanvasRenderingContext2D,
  options: WaveformDrawOptions
): void {
  const peaks = options.peaks;
  if (!peaks.length) return;
  const unit = Math.min(options.box.w, options.box.h) / 9;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

  const pillWidth = even(unit * 4.6);
  const pillHeight = even(unit * 0.72);
  const pillX = Math.round((options.box.w - pillWidth) / 2);
  const pillY = Math.round(options.box.h - pillHeight - unit * 0.55);

  const padding = pillHeight * 0.3;
  const innerWidth = pillWidth - padding * 2;
  const innerHeight = pillHeight - padding * 2;
  const slot = innerWidth / peaks.length;
  const barWidth = Math.max(2, slot * 0.52);
  const centerY = pillY + pillHeight / 2;

  const progress =
    options.duration > 0
      ? clamp01(options.elapsed / options.duration)
      : 1;

  ctx.save();
  ctx.fillStyle = 'rgba(23, 27, 38, 0.72)';
  roundRect(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();

  for (let bar = 0; bar < peaks.length; bar += 1) {
    const amplitude =
      (BAR_MIN + (1 - BAR_MIN) * peaks[bar]) *
      dance(bar, options.elapsed) *
      popIn(bar, options.elapsed);
    const barHeight = Math.max(2, amplitude * innerHeight);
    const x = pillX + padding + slot * bar + (slot - barWidth) / 2;
    const played = peaks.length > 0 && bar / peaks.length <= progress;
    ctx.globalAlpha = played ? PLAYED_ALPHA : UPCOMING_ALPHA;
    ctx.fillStyle = '#ffffff';
    roundRect(
      ctx,
      x,
      centerY - barHeight / 2,
      barWidth,
      barHeight,
      barWidth / 2
    );
    ctx.fill();
  }
  ctx.restore();
}
