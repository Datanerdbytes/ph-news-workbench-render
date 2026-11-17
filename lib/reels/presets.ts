/**
 * Pre-built reel animation presets.
 *
 * Every preset ships two renderers over the same time base:
 *  - `draw` renders one frame into a 1080×1920 design space. The live preview
 *    overlay and the baked video both call this, so what you preview is
 *    exactly what gets rendered into the posted reel.
 *  - `mount` builds a looping GSAP DOM preview in a 270×480 design space for
 *    the picker's gallery cards, where no video is playing underneath.
 *
 * `draw` receives LOCAL time in seconds (0 at the effect's start), so presets
 * are anchored by the registry — the slot they are attached to (`start`,
 * `middle`, `end`) decides where each effect lands on the reel, not callers.
 *
 * This module is intentionally GSAP-free so the bake path (lib/reels/bake.ts)
 * can import it without pulling GSAP into module scope. GSAP-dependent mount
 * functions live in presets.preview.ts.
 */

import {
  planEffectsFor,
  plannedFramesFor,
  type PlannedEffectOf,
  type PresetField,
  type PresetSlot,
  type PresetValues,
} from '@/lib/animations/plan';

export type { PresetField, PresetSlot, PresetValues };

/** One animation picked for a reel slot. */
export type ReelAttachment = {
  presetId: string;
  slot: PresetSlot;
  loop: boolean;
};

export type PresetCategory =
  | 'Headlines'
  | 'Captions'
  | 'Newsroom'
  | 'Branding'
  | 'Motion';

export {
  SLOT_ORDER,
  attachmentsFromSlots,
  effectLocals,
  slotStart,
} from '@/lib/animations/plan';

type Ctx = CanvasRenderingContext2D;

export type ReelPreset = {
  id: string;
  name: string;
  category: PresetCategory;
  /** Slots this effect suits — the picker only offers it there. */
  slots: PresetSlot[];
  /** Display label for where the effect lands on the reel. */
  window: string;
  /** Effect length in seconds. */
  duration: number;
  /** Seconds into the reel where the effect starts (in the 'start' slot). */
  start: number;
  /** Text inputs the user can edit for this preset. */
  fields: PresetField[];
  /** Render one frame at local time `t` in a 1080×1920 design space. */
  draw?: (ctx: Ctx, t: number, duration: number, values: PresetValues) => void;
  /**
   * Renderer for a looped effect whose content should keep flowing instead of
   * replaying its intro — e.g. a ticker, where each repeat's text follows the
   * one before on the same line. `t` keeps growing past `duration`.
   */
  stream?: (ctx: Ctx, t: number, duration: number, values: PresetValues) => void;
  /** Frame zoom multiplier over local time (camera motion baked into footage). */
  scale?: (t: number) => number;
  /** Build the looping DOM preview for picker cards (GSAP, preview only). */
  mount?: (stage: HTMLElement, values: PresetValues) => unknown;
};

const RED = '#d92d20';
const DESIGN_W = 1080;
const DESIGN_H = 1920;

/* ---------------------------------- easing --------------------------------- */

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const inCubic = (x: number) => x * x * x;
/** GSAP `power4.out` / `outQuart`: 1 - (1 - x)^4. */
const outQuart = (x: number) => 1 - Math.pow(1 - x, 4);
const outBack = (x: number) => {
  // Snap the ends so a resolved segment is exactly 0 / 1 — `back` easing
  // leaves float dust at x=0 that would otherwise paint a zero-scale frame.
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
/** Normalized progress of `t` through a segment starting at `from` lasting `len`. */
const seg = (t: number, from: number, len: number) =>
  clamp01((t - from) / (len || 1));

/* ------------------------------- canvas helpers ---------------------------- */

let cachedFamily: string | null = null;
function fontFamily(): string {
  if (!cachedFamily && typeof window !== 'undefined') {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-manrope')
      .trim();
    if (v) cachedFamily = v;
  }
  return cachedFamily || 'Manrope, sans-serif';
}

const font = (weight: number, size: number) =>
  `${weight} ${size}px ${fontFamily()}`;

function roundRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

/** GSAP `power2.inOut` / `inOutCubic`. */
const inOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** Width of `text` with letter spacing applied between glyphs. */
function trackedWidth(ctx: Ctx, text: string, tracking: number): number {
  let width = 0;
  for (const ch of text) width += ctx.measureText(ch).width + tracking;
  return Math.max(0, width - tracking);
}

/** Draws `text` glyph by glyph so canvas gets real letter spacing. */
function fillTracked(ctx: Ctx, text: string, x: number, y: number, tracking: number) {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

const CAPTION_BEAT_FROM = 0.35;
const captionBeatLen = (duration: number) => Math.max(0.1, duration - 1);

/**
 * Which caption chip is "speaking" at local time `t` — the karaoke beat
 * sweeps the words after they have popped in.
 */
export function captionActiveIndex(
  t: number,
  duration: number,
  count: number
): number {
  if (count <= 0) return 0;
  const beat = seg(t, CAPTION_BEAT_FROM, captionBeatLen(duration));
  return Math.min(count - 1, Math.floor(beat * count));
}

/** Local time the beat reaches `index` — the moment `captionActiveIndex`
 * starts returning it, so per-chip accents land on their beat. */
export function captionActiveStart(
  index: number,
  duration: number,
  count: number
): number {
  if (count <= 0) return 0;
  return CAPTION_BEAT_FROM + (index / count) * captionBeatLen(duration);
}

/* --------------------------------- presets --------------------------------- */

export const headline: ReelPreset = {
  id: 'headline',
  name: 'Kinetic Headline',
  category: 'Headlines',
  slots: ['start'],
  window: 'First 3s',
  duration: 3.4,
  start: 0,
  fields: [{ key: 'text', label: 'Headline text', value: 'Big news today' }],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const words = (v.text || '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    if (!words.length) return;
    const size = 132;
    const lineH = 158;
    const top = 360;
    const padX = 110;
    const barIn = outQuart(seg(t, 0, 0.35));
    // Entrance starts at 0 and the exit ends exactly on `duration` so a
    // looped pass finishes as the next one begins — no dead air at the seam.
    const barOut = inCubic(seg(t, duration - 0.35, 0.35));
    if (barIn > 0 && barOut < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - barOut;
      ctx.translate(padX + barOut * 40, top - 64);
      ctx.scale(barIn, 1);
      ctx.fillStyle = RED;
      ctx.fillRect(0, 0, 150, 18);
      ctx.restore();
    }
    ctx.save();
    ctx.font = font(800, size);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 28;
    words.forEach((word, i) => {
      const inP = outQuart(seg(t, i * 0.28, 0.55));
      // Last word leaves exactly at `duration`.
      const outP = inCubic(
        seg(t, duration - 0.4 - (words.length - 1 - i) * 0.07, 0.4)
      );
      if (inP === 0 || outP === 1) return;
      const y = top + i * lineH;
      const dy = (1 - inP) * (lineH + 30) - outP * (lineH + 30);
      const settle = 0.965 + 0.035 * inP;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padX - 6, y - 8, DESIGN_W - padX * 2 + 12, lineH);
      ctx.clip();
      ctx.translate(padX, y + dy);
      ctx.scale(settle, settle);
      ctx.fillText(word, 0, 0);
      ctx.restore();
    });
    ctx.restore();
    // Underline rule sweeps out under the last line once the words land.
    const ruleP = outQuart(seg(t, 0.55 + words.length * 0.1, 0.5));
    if (ruleP > 0 && barOut < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - barOut;
      ctx.fillStyle = RED;
      const ruleW = 340 * ruleP;
      ctx.fillRect(padX, top + words.length * lineH + 6, ruleW, 12);
      ctx.restore();
    }
  },
};

/**
 * Banner frame at local time `t`. The ticker's offset is continuous in `t`,
 * so a streamed loop keeps scrolling instead of restarting the line.
 */
function drawBreaking(ctx: Ctx, t: number, v: PresetValues, fade: number) {
  if (fade <= 0) return;
  ctx.save();
  ctx.globalAlpha = fade;
  const tagIn = outBack(seg(t, 0, 0.3));
  if (tagIn > 0) {
    const tagW = 340;
    const tagH = 74;
    const tagX = 80;
    const tagY = 120;
    ctx.save();
    ctx.translate(tagX + tagW / 2, tagY + tagH / 2);
    const s = Math.max(tagIn, 0.001);
    ctx.scale(s, s);
    ctx.fillStyle = RED;
    roundRect(ctx, -tagW / 2, -tagH / 2, tagW, tagH, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = font(800, 38);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BREAKING', -14, 2);
    // Live dot pulses on the tag's trailing edge.
    ctx.globalAlpha = fade * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5)));
    ctx.beginPath();
    ctx.arc(tagW / 2 - 34, 1, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = fade;
    ctx.restore();
  }
  // The banner is stationary — only the ticker text scrolls right to left.
  const barP = seg(t, 0, 0.18);
  if (barP > 0) {
    const barH = 140;
    const barY = DESIGN_H - 340;
    ctx.save();
    ctx.globalAlpha = fade * barP;
    ctx.fillStyle = 'rgba(10,14,18,0.92)';
    ctx.fillRect(0, barY, DESIGN_W, barH);
    ctx.fillStyle = RED;
    ctx.fillRect(0, barY, DESIGN_W, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, barY + 6, DESIGN_W, 2);
    ctx.font = font(700, 54);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    const text = (v.text || '').toUpperCase();
    const unit = Math.max(ctx.measureText(`${text}   •   `).width, 100);
    const x = -((t * 240) % unit);
    for (let i = 0; i < Math.ceil(DESIGN_W / unit) + 2; i++) {
      ctx.fillText(`${text}   •   `, x + i * unit, barY + barH / 2 + 2);
    }
    ctx.restore();
  }
  ctx.restore();
}

export const breaking: ReelPreset = {
  id: 'breaking',
  name: 'Breaking Banner',
  category: 'Newsroom',
  slots: ['start', 'middle'],
  window: '0–5s',
  duration: 5,
  start: 0,
  fields: [
    { key: 'text', label: 'Banner text', value: 'Supreme Court rules on charter case' },
  ],
  draw(ctx, t, duration, v) {
    drawBreaking(ctx, t, v, 1 - seg(t, duration - 0.4, 0.4));
  },
  // Looped banner stays up and its ticker keeps rolling: each repeat's text
  // follows the previous one off-screen on the same line.
  stream(ctx, t, _duration, v) {
    drawBreaking(ctx, t, v, 1);
  },
};

export const lowerthird: ReelPreset = {
  id: 'lowerthird',
  name: 'Lower Third',
  category: 'Newsroom',
  slots: ['start', 'middle'],
  window: '1–4s',
  duration: 3.4,
  start: 1,
  fields: [{ key: 'name', label: 'Reporter name', value: 'Maria Santos' }],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const inP = outQuart(seg(t, 0, 0.5));
    const outP = inOutCubic(seg(t, duration - 0.45, 0.45));
    if (inP === 0 || outP === 1) return;
    const name = (v.name || '').toUpperCase();
    if (!name) return;
    const role = 'FIELD REPORTER';
    ctx.save();
    ctx.font = font(800, 62);
    const nameW = ctx.measureText(name).width;
    ctx.font = font(700, 34);
    const roleW = trackedWidth(ctx, role, 4);
    ctx.font = font(800, 62);
    const bx = 70;
    const by = DESIGN_H - 430;
    const bh = 150;
    const barW = 16;
    const panelW = Math.max(nameW + 110, roleW + 110, 430);
    const slide = (inP - 1) * (panelW + 160) - outP * (panelW + 160);
    ctx.translate(slide, 0);
    // Accent bar rises with the panel instead of snapping in at full height.
    const barP = outCubic(seg(t, 0.12, 0.4));
    if (barP > 0) {
      ctx.fillStyle = RED;
      ctx.fillRect(bx, by + bh * (1 - barP), barW, bh * barP);
    }
    ctx.fillStyle = 'rgba(10,14,18,0.92)';
    roundRect(ctx, bx + barW, by, panelW, bh, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(bx + barW, by, panelW, 2);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, bx + 52, by + 52);
    const roleP = outCubic(seg(t, 0.22, 0.4));
    if (roleP > 0) {
      ctx.globalAlpha = Math.min(1, roleP * 1.4);
      ctx.font = font(700, 34);
      ctx.fillStyle = '#f7b3ad';
      fillTracked(ctx, role, bx + 52 + (1 - roleP) * 24, by + 110, 4);
    }
    ctx.restore();
  },
};

export const captionpop: ReelPreset = {
  id: 'captionpop',
  name: 'Caption Pop',
  category: 'Captions',
  slots: ['start', 'middle'],
  window: 'After 1.5s',
  duration: 4,
  start: 1.5,
  fields: [
    { key: 'text', label: 'Caption words', value: 'The cleanup started at dawn' },
  ],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const words = (v.text || '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 10);
    if (!words.length) return;
    const fadeOut = 1 - seg(t, duration - 0.45, 0.45);
    if (fadeOut <= 0) return;
    ctx.save();
    ctx.font = font(800, 58);
    ctx.textBaseline = 'middle';
    const padX = 24;
    const chipH = 96;
    const gap = 16;
    const rows: { word: string; w: number }[][] = [[]];
    let rowW = 0;
    const maxW = DESIGN_W - 180;
    for (const word of words) {
      const w = ctx.measureText(word).width + padX * 2;
      const lineW = rows[rows.length - 1];
      rowW = lineW.reduce((sum, c) => sum + c.w + gap, -gap);
      if (rowW + w > maxW && lineW.length) rows.push([{ word, w }]);
      else rows[rows.length - 1].push({ word, w });
    }
    const blockH = rows.length * chipH + (rows.length - 1) * gap;
    let y = 1480 - blockH / 2;
    let index = 0;
    const active = captionActiveIndex(t, duration, words.length);
    rows.forEach((row) => {
      const total = row.reduce((sum, c) => sum + c.w + gap, -gap);
      let x = (DESIGN_W - total) / 2;
      row.forEach(({ word, w }) => {
        const p = outBack(seg(t, index * 0.22, 0.32));
        if (p > 0.001) {
          const isActive = index === active;
          // The speaking word lands 4% larger on its beat, easing back as
          // the sweep moves on — not during its entrance pop.
          const talk = isActive
            ? 1 +
              0.04 *
                (1 - seg(t, captionActiveStart(index, duration, words.length), 0.22))
            : 1;
          ctx.save();
          ctx.globalAlpha = Math.min(1, p) * fadeOut;
          ctx.translate(x + w / 2, y + chipH / 2);
          const s = p * talk;
          ctx.scale(s, s);
          ctx.fillStyle = isActive ? RED : 'rgba(10,14,18,0.85)';
          roundRect(ctx, -w / 2, -chipH / 2, w, chipH, 16);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(word, -w / 2 + padX, 2);
          ctx.restore();
        }
        x += w + gap;
        index += 1;
      });
      y += chipH + gap;
    });
    ctx.restore();
  },
};

export const quote: ReelPreset = {
  id: 'quote',
  name: 'Quote Reveal',
  category: 'Headlines',
  slots: ['middle'],
  window: 'Mid reel',
  duration: 4,
  start: 3,
  fields: [
    { key: 'text', label: 'Quote', value: '“We will finish what we started.”' },
    { key: 'by', label: 'Attribution', value: '— Mayor Lim' },
  ],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const inP = outCubic(seg(t, 0, 0.5));
    const outP = inOutCubic(seg(t, duration - 0.45, 0.45));
    if (inP === 0 || outP === 1) return;
    const base = Math.min(1, inP * 1.4) * (1 - outP);
    const settle = 0.97 + 0.03 * inP;
    ctx.save();
    ctx.globalAlpha = base;
    ctx.translate(0, (1 - inP) * 60 - outP * 50);
    ctx.translate(DESIGN_W / 2, 830);
    ctx.scale(settle, settle);
    ctx.translate(-DESIGN_W / 2, -830);
    const cardX = 90;
    const cardW = DESIGN_W - cardX * 2;
    ctx.font = font(600, 58);
    const lines = wrapText(ctx, v.text || '', cardW - 130);
    const lineH = 84;
    const cardH = lines.length * lineH + 170;
    const cardY = 830 - cardH / 2;
    ctx.fillStyle = 'rgba(10,14,18,0.62)';
    roundRect(ctx, cardX, cardY, cardW, cardH, 36);
    ctx.fill();
    const barP = outQuart(seg(t, 0.12, 0.5));
    if (barP > 0) {
      ctx.fillStyle = RED;
      ctx.fillRect(
        cardX,
        cardY + (cardH * (1 - barP)) / 2,
        14,
        cardH * barP
      );
    }
    const glyphP = outCubic(seg(t, 0.2, 0.35));
    if (glyphP > 0) {
      ctx.save();
      ctx.globalAlpha = base * glyphP * 0.9;
      ctx.font = font(800, 140);
      ctx.fillStyle = RED;
      ctx.textBaseline = 'top';
      ctx.fillText('“', cardX + 40, cardY + 6);
      ctx.restore();
    }
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => {
      const lineP = outCubic(seg(t, 0.18 + i * 0.1, 0.5));
      if (lineP === 0) return;
      ctx.save();
      ctx.globalAlpha = base * Math.min(1, lineP * 1.5);
      ctx.fillText(line, cardX + 64, cardY + 64 + i * lineH + (1 - lineP) * 26);
      ctx.restore();
    });
    const byP = outCubic(seg(t, 0.4, 0.4));
    if (byP > 0) {
      ctx.save();
      ctx.globalAlpha = base * Math.min(1, byP * 1.4);
      ctx.font = font(700, 36);
      ctx.fillStyle = '#c8d2d8';
      ctx.textBaseline = 'top';
      fillTracked(ctx, (v.by || '').toUpperCase(), cardX + 64, cardY + cardH - 78, 3);
      ctx.restore();
    }
    ctx.restore();
  },
};

export const stat: ReelPreset = {
  id: 'stat',
  name: 'Stat Pop',
  category: 'Headlines',
  slots: ['start', 'middle'],
  window: '0–3s',
  duration: 3.2,
  start: 0.5,
  fields: [
    { key: 'num', label: 'Big number', value: '72%' },
    { key: 'label', label: 'Stat label', value: 'of flood projects audited' },
  ],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const inP = outQuart(seg(t, 0, 0.45));
    const outP = seg(t, duration - 0.4, 0.4);
    if (inP === 0 || outP === 1) return;
    const cx = DESIGN_W / 2;
    const cy = 830;
    const fade = (1 - outP) * Math.min(1, inP * 1.5);
    // Soft vignette lifts the number off busy footage.
    const vignette = ctx.createRadialGradient(cx, cy, 260, cx, cy, 760);
    vignette.addColorStop(0, 'rgba(5,10,14,0)');
    vignette.addColorStop(1, `rgba(5,10,14,${(0.5 * fade).toFixed(3)})`);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const scale = 1 + 0.55 * (1 - inP);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.font = font(800, 300);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 44;
    const match = /^(\d+)/.exec(v.num || '');
    const countP = outQuart(seg(t, 0.08, 0.8));
    const shown = match
      ? `${Math.round(Number(match[1]) * countP)}${(v.num || '').slice(match[1].length)}`
      : v.num || '';
    ctx.fillText(shown, 0, 0);
    ctx.restore();
    const ruleIn = outQuart(seg(t, 0.32, 0.45));
    if (ruleIn > 0) {
      ctx.fillStyle = RED;
      ctx.fillRect(cx - 100 * ruleIn, cy + 220, 200 * ruleIn, 14);
    }
    const label = (v.label || '').toUpperCase();
    const labelP = outCubic(seg(t, 0.4, 0.4));
    if (label && labelP > 0) {
      ctx.save();
      ctx.globalAlpha = fade * Math.min(1, labelP * 1.4);
      ctx.font = font(700, 46);
      ctx.fillStyle = '#d7e0e6';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      fillTracked(
        ctx,
        label,
        cx - trackedWidth(ctx, label, 4) / 2,
        cy + 300 + (1 - labelP) * 20,
        4
      );
      ctx.restore();
    }
    ctx.restore();
  },
};

export const punchzoom: ReelPreset = {
  id: 'punchzoom',
  name: 'Punch Zoom',
  category: 'Motion',
  slots: ['start', 'middle', 'end'],
  window: 'On beat drops',
  duration: 2.4,
  start: 2,
  fields: [],
  scale(t) {
    const inP = outQuart(seg(t, 0, 0.3));
    const outP = inOutCubic(seg(t, 1.9, 0.5));
    return 1 + 0.16 * inP * (1 - outP);
  },
};

export const logosting: ReelPreset = {
  id: 'logosting',
  name: 'Logo Sting',
  category: 'Branding',
  slots: ['start', 'end'],
  window: 'Intro / outro',
  duration: 2.6,
  start: 0.2,
  fields: [{ key: 'text', label: 'Mark', value: 'PN' }],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const ringIn = outBack(seg(t, 0, 0.45));
    const markIn = outBack(seg(t, 0.12, 0.4));
    const outP = seg(t, duration - 0.5, 0.5);
    const flash = seg(t, 0.55, 0.12) * (1 - seg(t, 0.67, 0.12));
    if ((ringIn === 0 && markIn === 0 && flash === 0) || outP === 1) return;
    const cx = DESIGN_W / 2;
    const cy = 850;
    const s = (1 + outP * 0.25) * Math.max(ringIn, 0.001);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.globalAlpha = 1 - outP;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(0, 0, 170, 0, Math.PI * 2);
    ctx.stroke();
    // Brand arc sweeps around the ring before the mark lands.
    const sweep = outCubic(seg(t, 0.18, 0.9));
    if (sweep > 0) {
      ctx.save();
      ctx.strokeStyle = RED;
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, 170, -Math.PI / 2, -Math.PI / 2 + sweep * Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();
    }
    if (markIn > 0) {
      ctx.save();
      ctx.scale(Math.max(markIn, 0.001), Math.max(markIn, 0.001));
      ctx.fillStyle = '#ffffff';
      ctx.font = font(800, 96);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((v.text || 'PN').toUpperCase(), 0, 4);
      ctx.restore();
    }
    ctx.restore();
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(flash * 0.45).toFixed(3)})`;
      ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    }
  },
};

export const endcard: ReelPreset = {
  id: 'endcard',
  name: 'End Card',
  category: 'Branding',
  slots: ['end'],
  window: 'Last 4s',
  duration: 3.6,
  start: 0,
  fields: [
    { key: 'text', label: 'End card text', value: 'Follow for daily news' },
  ],
  draw(ctx, t, duration, v) {
    if (t >= duration) return;
    const ovIn = seg(t, 0, 0.4);
    const outP = seg(t, duration - 0.5, 0.5);
    if (ovIn === 0 || outP === 1) return;
    ctx.save();
    ctx.globalAlpha = 1 - outP;
    const shade = ctx.createLinearGradient(0, 0, 0, DESIGN_H);
    shade.addColorStop(0, `rgba(6,10,14,${(0.45 * ovIn).toFixed(3)})`);
    shade.addColorStop(0.55, `rgba(6,10,14,${(0.8 * ovIn).toFixed(3)})`);
    shade.addColorStop(1, `rgba(6,10,14,${(0.94 * ovIn).toFixed(3)})`);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    const words = (v.text || '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    const size = words.length > 3 ? 92 : 108;
    const lineH = size * 1.16;
    const top = 810 - (words.length * lineH) / 2;
    ctx.font = font(800, size);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 26;
    const cx = DESIGN_W / 2;
    words.forEach((word, i) => {
      const inP = outQuart(seg(t, 0.3 + i * 0.16, 0.55));
      if (inP === 0) return;
      const y = top + i * lineH;
      const w = ctx.measureText(word).width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(80, y - 8, DESIGN_W - 160, lineH);
      ctx.clip();
      ctx.fillText(word, cx - w / 2, y + (1 - inP) * (lineH + 20));
      ctx.restore();
    });
    ctx.shadowBlur = 0;
    const btnP = outBack(seg(t, 0.75, 0.35));
    if (btnP > 0.001) {
      const label = 'FOLLOW';
      ctx.save();
      ctx.translate(cx, top + words.length * lineH + 150);
      ctx.scale(Math.max(btnP, 0.001), Math.max(btnP, 0.001));
      ctx.font = font(800, 48);
      const labelW = trackedWidth(ctx, label, 4);
      const bw = labelW + 130;
      ctx.fillStyle = RED;
      roundRect(ctx, -bw / 2, -52, bw, 104, 52);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      fillTracked(ctx, label, -labelW / 2, 2, 4);
      ctx.restore();
    }
    ctx.restore();
  },
};

export const REEL_PRESETS: ReelPreset[] = [
  { id: 'none', name: 'None', category: 'Headlines', slots: [], window: 'No animation', duration: 0, start: 0, fields: [] },
  headline,
  breaking,
  lowerthird,
  captionpop,
  quote,
  stat,
  punchzoom,
  logosting,
  endcard,
];

export const PRESET_CATEGORIES = [
  'All',
  'Headlines',
  'Captions',
  'Newsroom',
  'Branding',
  'Motion',
] as const;

/** A planned effect: a preset resolved to one absolute time on a reel. */
export type PlannedEffect = PlannedEffectOf<ReelPreset>;

/**
 * Resolves the picker's attachments into concrete timed effects for one reel.
 */
export function planEffects(
  attachments: ReelAttachment[],
  videoDuration: number,
  values: Record<string, PresetValues> = {}
): PlannedEffect[] {
  return planEffectsFor(attachments, videoDuration, values, getPreset);
}

/** One draw of a planned effect at its own local time. */
export type EffectFrame = { effect: PlannedEffect; local: number };

/**
 * The draws one reel frame needs, in attachment order, with streaming loops
 * handled and loops stopped at the closing effect's start.
 */
export function plannedFrames(
  effects: PlannedEffect[],
  t: number
): EffectFrame[] {
  return plannedFramesFor(effects, t);
}

/** Renderer for one planned frame: `stream` while streaming, else `draw`. */
export function effectRenderer(
  effect: PlannedEffect
): ReelPreset['draw'] | ReelPreset['stream'] {
  return effect.loop && effect.preset.stream
    ? effect.preset.stream
    : effect.preset.draw;
}

export function getPreset(id: string | null | undefined): ReelPreset | null {
  if (!id) return null;
  return REEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function defaultPresetValues(): Record<string, PresetValues> {
  return Object.fromEntries(
    REEL_PRESETS.map((preset) => [
      preset.id,
      Object.fromEntries(preset.fields.map((field) => [field.key, field.value])),
    ])
  );
}
