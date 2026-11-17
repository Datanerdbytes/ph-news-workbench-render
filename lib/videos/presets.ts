/**
 * Broadcast-grade overlays for regular videos (compose + videos pages).
 *
 * Like the reel presets, every animation ships one deterministic `draw` that
 * the live preview and the bake both call, so what you preview is exactly what
 * gets rendered into the posted video. Unlike reels, the design space is not
 * fixed: `draw` receives the output box and lays itself out relative to the
 * shorter side, so the same animation reads correctly on 16:9, 1:1, 9:16 and
 * ultrawide footage.
 *
 * `draw` receives LOCAL time in seconds (0 at the effect's start); slots anchor
 * effects on the timeline. This module is GSAP-agnostic — preview timelines
 * live in presets.preview.ts.
 */

import {
  SLOT_ORDER,
  attachmentsFromSlots,
  effectLocals,
  planEffectsFor,
  plannedFramesFor,
  slotStart,
  type PlannedEffectOf,
  type PresetField,
  type PresetSlot,
  type PresetValues,
  type SlotAttachment,
} from '@/lib/animations/plan';

export type { PresetField, PresetSlot, PresetValues };
export { SLOT_ORDER, attachmentsFromSlots, effectLocals, slotStart };

export type AnimationBox = { w: number; h: number };

export type VideoPresetCategory =
  | 'Titles'
  | 'Captions'
  | 'Newsroom'
  | 'Data'
  | 'Branding'
  | 'Motion';

export type VideoPreset = {
  id: string;
  name: string;
  category: VideoPresetCategory;
  slots: PresetSlot[];
  window: string;
  duration: number;
  start: number;
  fields: PresetField[];
  /** Render one frame at local time `t` into the output box. */
  draw?: (
    ctx: CanvasRenderingContext2D,
    t: number,
    duration: number,
    values: PresetValues,
    box: AnimationBox
  ) => void;
  /** Streaming loop (ticker): `t` keeps growing past `duration`. */
  stream?: (
    ctx: CanvasRenderingContext2D,
    t: number,
    duration: number,
    values: PresetValues,
    box: AnimationBox
  ) => void;
  /** Frame zoom multiplier over local time (camera motion baked into footage). */
  scale?: (t: number) => number;
};

export type VideoAttachment = SlotAttachment;

const RED = '#d92d20';
const RED_SOFT = '#f3a8a1';

/* ---------------------------------- easing --------------------------------- */

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const inCubic = (x: number) => x * x * x;
const outQuart = (x: number) => 1 - Math.pow(1 - x, 4);
const inOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const outBack = (x: number) => {
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

/** One layout unit: the shorter side split into 9 parts (120 at 1080p). */
const unit = (box: AnimationBox) => Math.min(box.w, box.h) / 9;

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

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines = 3
): string[] {
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
  return lines.slice(0, maxLines);
}

/** Width of `text` with letter spacing applied between glyphs. */
function trackedWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  tracking: number
): number {
  let width = 0;
  for (const ch of text) width += ctx.measureText(ch).width + tracking;
  return Math.max(0, width - tracking);
}

/** Draws `text` glyph by glyph so canvas gets real letter spacing. */
function fillTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number
) {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

/** Canvas round-caps arc; used by the stat ring and logo sting. */
function arc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
  color: string,
  width: number
) {
  if (to <= from) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, from, to);
  ctx.stroke();
  ctx.restore();
}

/* --------------------------------- presets --------------------------------- */

export const cinemaTitle: VideoPreset = {
  id: 'cinema-title',
  name: 'Cinematic Title',
  category: 'Titles',
  slots: ['start', 'middle'],
  window: 'First 4s',
  duration: 4.2,
  start: 0,
  fields: [
    { key: 'kicker', label: 'Kicker', value: 'PH NEWS' },
    { key: 'title', label: 'Title', value: 'The story behind the headline' },
  ],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const pad = U * 0.85;
    const title = (v.title || '').toUpperCase().trim();
    if (!title) return;
    const size = U * 1.02;
    const lineH = size * 1.12;
    ctx.font = font(800, size);
    const lines = wrapText(ctx, title, box.w - pad * 2);
    const blockTop = box.h * 0.42 - (lines.length * lineH) / 2;
    const outAll = inCubic(seg(t, duration - 0.5, 0.5));
    if (outAll === 1) return;

    const kicker = (v.kicker || '').toUpperCase();
    const kickIn = outCubic(seg(t, 0, 0.45));
    if (kicker && kickIn > 0) {
      ctx.save();
      ctx.globalAlpha = (1 - outAll) * kickIn;
      ctx.font = font(700, U * 0.24);
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.textBaseline = 'middle';
      fillTracked(ctx, kicker, pad, blockTop - U * 0.62, U * 0.05);
      ctx.restore();
    }

    const ruleP = outQuart(seg(t, 0.1, 0.55));
    if (ruleP > 0) {
      ctx.save();
      ctx.globalAlpha = 1 - outAll;
      ctx.fillStyle = RED;
      ctx.fillRect(pad, blockTop - U * 0.3, U * 1.25 * ruleP, Math.max(2, U * 0.04));
      ctx.restore();
    }

    ctx.save();
    ctx.font = font(800, size);
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = U * 0.24;
    lines.forEach((line, i) => {
      const inP = outQuart(seg(t, 0.22 + i * 0.12, 0.72));
      if (inP <= 0) return;
      const y = blockTop + i * lineH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad - U * 0.06, y - U * 0.06, box.w - pad * 2 + U * 0.12, lineH + U * 0.12);
      ctx.clip();
      ctx.globalAlpha = 1 - outAll;
      ctx.fillText(line, pad, y + (1 - inP) * (lineH + U * 0.12));
      ctx.restore();
    });
    ctx.restore();
  },
};

export const lowerThird: VideoPreset = {
  id: 'lower-third',
  name: 'Editorial Lower Third',
  category: 'Newsroom',
  slots: ['start', 'middle'],
  window: '1–5s',
  duration: 3.8,
  start: 1,
  fields: [
    { key: 'name', label: 'Name', value: 'Maria Santos' },
    { key: 'role', label: 'Role', value: 'Field reporter' },
  ],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const pad = U * 0.85;
    const inP = outQuart(seg(t, 0, 0.55));
    const outP = inCubic(seg(t, duration - 0.5, 0.45));
    if (inP === 0 || outP === 1) return;

    const name = (v.name || '').toUpperCase().trim();
    if (!name) return;
    const role = (v.role || '').toUpperCase().trim();
    const barW = Math.max(3, U * 0.11);
    const panelH = U * 1.22;
    const nameSize = U * 0.5;
    const roleSize = U * 0.23;
    const inset = U * 0.42;

    ctx.font = font(800, nameSize);
    const nameW = ctx.measureText(name).width;
    ctx.font = font(700, roleSize);
    const roleW = trackedWidth(ctx, role, U * 0.045);
    const panelW = Math.max(nameW, roleW) + inset * 2;

    const x = pad - (1 - inP + outP) * (panelW + pad);
    const y = box.h - pad - panelH;

    ctx.save();
    ctx.fillStyle = RED;
    ctx.fillRect(x, y, barW, Math.max(1, panelH * inP));

    ctx.fillStyle = 'rgba(8,12,16,.82)';
    roundRect(ctx, x + barW, y, panelW, panelH, U * 0.06);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(x + barW, y, panelW, Math.max(1, U * 0.012));

    ctx.textBaseline = 'middle';
    if (role) {
      ctx.font = font(700, roleSize);
      ctx.fillStyle = RED_SOFT;
      fillTracked(ctx, role, x + barW + inset, y + panelH - U * 0.34, U * 0.045);
    }
    ctx.font = font(800, nameSize);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, x + barW + inset, y + panelH * 0.36);
    ctx.restore();
  },
};

export const kineticCaption: VideoPreset = {
  id: 'kinetic-caption',
  name: 'Kinetic Caption',
  category: 'Captions',
  slots: ['start', 'middle'],
  window: 'After 1s',
  duration: 4.4,
  start: 1,
  fields: [
    { key: 'text', label: 'Caption words', value: 'The cleanup started at dawn' },
  ],
  draw(ctx, t, duration, v, box) {
    const words = (v.text || '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 12);
    if (!words.length) return;
    const U = unit(box);
    const pad = U * 0.85;
    const size = U * 0.42;
    const chipH = U * 0.74;
    const gap = U * 0.16;
    const padX = U * 0.26;
    const exit = 1 - seg(t, duration - 0.45, 0.45);
    if (exit <= 0) return;

    ctx.save();
    ctx.font = font(800, size);
    ctx.textBaseline = 'middle';
    const rows: { word: string; w: number }[][] = [[]];
    const maxW = box.w - pad * 2;
    for (const word of words) {
      const w = ctx.measureText(word).width + padX * 2;
      const row = rows[rows.length - 1];
      const rowW = row.reduce((sum, chip) => sum + chip.w + gap, -gap);
      if (rowW + w > maxW && row.length) rows.push([{ word, w }]);
      else row.push({ word, w });
    }
    const blockH = rows.length * chipH + (rows.length - 1) * gap;
    const top = box.h - pad * 1.6 - blockH;

    const karaoke = seg(t, 0.2, Math.max(0.1, duration - 0.9));
    const active = Math.min(
      words.length - 1,
      Math.floor(karaoke * words.length)
    );

    let index = 0;
    rows.forEach((row, rowIndex) => {
      const total = row.reduce((sum, chip) => sum + chip.w + gap, -gap);
      let x = (box.w - total) / 2;
      const y = top + rowIndex * (chipH + gap);
      row.forEach(({ word, w }) => {
        const p = outBack(seg(t, index * 0.14, 0.42));
        if (p > 0.001) {
          ctx.save();
          ctx.globalAlpha = Math.min(1, p * 1.4) * exit;
          ctx.translate(x + w / 2, y + chipH / 2);
          ctx.scale(p, p);
          ctx.fillStyle = index === active ? RED : 'rgba(8,12,16,.75)';
          roundRect(ctx, -w / 2, -chipH / 2, w, chipH, U * 0.1);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(word, -w / 2 + padX, 1);
          ctx.restore();
        }
        x += w + gap;
        index += 1;
      });
    });
    ctx.restore();
  },
};

export const statRing: VideoPreset = {
  id: 'stat-ring',
  name: 'Data Stat Ring',
  category: 'Data',
  slots: ['start', 'middle'],
  window: '0–4s',
  duration: 4,
  start: 0.4,
  fields: [
    { key: 'num', label: 'Big number', value: '72%' },
    { key: 'label', label: 'Stat label', value: 'of flood projects audited' },
  ],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const inP = outQuart(seg(t, 0, 0.55));
    const outP = seg(t, duration - 0.45, 0.45);
    if (inP === 0 || outP === 1) return;
    const cx = box.w / 2;
    const cy = box.h * 0.44;
    const r = U * 1.55;
    const lw = Math.max(3, U * 0.13);
    const ringP = outQuart(seg(t, 0.1, 1.15));

    ctx.save();
    ctx.globalAlpha = Math.min(1, inP * 1.5) * (1 - outP);
    ctx.translate(cx, cy);
    const scale = 1 + (1 - inP) * 0.12;
    ctx.scale(scale, scale);

    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    arc(ctx, 0, 0, r, -Math.PI / 2, -Math.PI / 2 + ringP * Math.PI * 2, RED, lw);

    const match = /^(\d+)/.exec(v.num || '');
    const shown = match
      ? `${Math.round(Number(match[1]) * ringP)}${(v.num || '').slice(match[1].length)}`
      : v.num || '';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(800, U * 1.35);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = U * 0.3;
    ctx.fillText(shown, 0, -U * 0.06);
    ctx.shadowBlur = 0;

    const ruleP = outCubic(seg(t, 0.5, 0.45));
    if (ruleP > 0) {
      ctx.fillStyle = RED;
      ctx.fillRect(-U * 0.55 * ruleP, U * 0.83, U * 1.1 * ruleP, Math.max(2, U * 0.05));
    }
    ctx.font = font(700, U * 0.24);
    ctx.fillStyle = '#d7e0e6';
    fillTracked(ctx, (v.label || '').toUpperCase(), -trackedWidth(ctx, (v.label || '').toUpperCase(), U * 0.045) / 2, U * 1.2, U * 0.045);
    ctx.restore();
  },
};

function drawTicker(
  ctx: CanvasRenderingContext2D,
  t: number,
  v: PresetValues,
  box: AnimationBox,
  intro: number,
  alpha: number
) {
  if (alpha <= 0) return;
  const U = unit(box);
  const tag = (v.tag || 'UPDATE').toUpperCase();
  const text = (v.text || '').toUpperCase();
  const barH = U * 0.95;
  const margin = U * 0.85;
  const barY = box.h - margin - barH + (1 - intro) * (barH + margin);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'middle';

  ctx.font = font(800, U * 0.26);
  const tagW = trackedWidth(ctx, tag, U * 0.05) + U * 0.72;
  ctx.fillStyle = RED;
  roundRect(ctx, margin, barY, tagW, barH, U * 0.08);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  fillTracked(ctx, tag, margin + U * 0.36, barY + barH / 2 + 1, U * 0.05);

  const barX = margin + tagW;
  const barW = box.w - barX - margin;
  ctx.fillStyle = 'rgba(8,12,16,.9)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.fillRect(barX, barY, barW, Math.max(1, U * 0.012));

  // Live dot pulses on the tag's trailing edge.
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 4));
  ctx.globalAlpha = alpha * pulse;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(margin + tagW - U * 0.28, barY + barH / 2, Math.max(2, U * 0.05), 0, Math.PI * 2);
  ctx.fill();

  if (text) {
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.beginPath();
    ctx.rect(barX, barY, barW, barH);
    ctx.clip();
    ctx.font = font(700, U * 0.3);
    ctx.fillStyle = '#ffffff';
    const unitW = ctx.measureText(`${text}   •   `).width + U * 0.5;
    const x = barX + U * 0.35 - ((t * U * 1.6) % unitW);
    for (let i = 0; i < Math.ceil(barW / unitW) + 2; i++) {
      ctx.fillText(`${text}   •   `, x + i * unitW, barY + barH / 2 + 1);
    }
    ctx.restore();
  }
  ctx.restore();
}

export const newsTicker: VideoPreset = {
  id: 'news-ticker',
  name: 'News Ticker',
  category: 'Newsroom',
  slots: ['start', 'middle'],
  window: 'Rolling',
  duration: 6,
  start: 0,
  fields: [
    { key: 'tag', label: 'Tag', value: 'UPDATE' },
    { key: 'text', label: 'Ticker text', value: 'Markets close higher as inflation eases' },
  ],
  draw(ctx, t, duration, v, box) {
    drawTicker(
      ctx,
      t,
      v,
      box,
      outCubic(seg(t, 0, 0.55)),
      1 - seg(t, duration - 0.45, 0.45)
    );
  },
  stream(ctx, t, _duration, v, box) {
    drawTicker(ctx, t, v, box, 1, 1);
  },
};

export const frameWipe: VideoPreset = {
  id: 'frame-wipe',
  name: 'Cinematic Frame',
  category: 'Motion',
  slots: ['start', 'end'],
  window: 'Open / close',
  duration: 4,
  start: 0,
  fields: [{ key: 'label', label: 'Frame label', value: 'IN FOCUS' }],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const barH = Math.max(U * 0.55, box.h * 0.075);
    const inP = outQuart(seg(t, 0, 0.65));
    const outP = inCubic(seg(t, duration - 0.6, 0.6));
    if (inP === 0 || outP === 1) return;
    const topY = -barH + inP * barH - outP * (barH + U * 0.2);
    const bottomY = box.h - inP * barH + outP * (barH + U * 0.2);

    ctx.save();
    ctx.fillStyle = '#05080b';
    ctx.fillRect(0, topY, box.w, barH);
    ctx.fillRect(0, bottomY, box.w, barH);

    const label = (v.label || '').toUpperCase();
    if (label) {
      ctx.globalAlpha = inP * (1 - outP) * 0.85;
      ctx.font = font(700, U * 0.2);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      fillTracked(
        ctx,
        label,
        box.w - U * 0.85 - trackedWidth(ctx, label, U * 0.12),
        topY + barH / 2 + 1,
        U * 0.12
      );
    }

    const bracketP = outCubic(seg(t, 0.35, 0.55));
    if (bracketP > 0) {
      const len = U * 0.65 * bracketP;
      const inset = U * 1.05;
      const line = Math.max(2, U * 0.03);
      ctx.globalAlpha = (1 - outP) * 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = line;
      ctx.beginPath();
      // top-left
      ctx.moveTo(inset, inset + len + barH * 0.4);
      ctx.lineTo(inset, inset + barH * 0.4);
      ctx.lineTo(inset + len, inset + barH * 0.4);
      // top-right
      ctx.moveTo(box.w - inset - len, inset + barH * 0.4);
      ctx.lineTo(box.w - inset, inset + barH * 0.4);
      ctx.lineTo(box.w - inset, inset + len + barH * 0.4);
      // bottom-left
      ctx.moveTo(inset, box.h - inset - barH * 0.4 - len);
      ctx.lineTo(inset, box.h - inset - barH * 0.4);
      ctx.lineTo(inset + len, box.h - inset - barH * 0.4);
      // bottom-right
      ctx.moveTo(box.w - inset - len, box.h - inset - barH * 0.4);
      ctx.lineTo(box.w - inset, box.h - inset - barH * 0.4);
      ctx.lineTo(box.w - inset, box.h - inset - barH * 0.4 - len);
      ctx.stroke();
    }
    ctx.restore();
  },
};

export const logoSting: VideoPreset = {
  id: 'logo-sting',
  name: 'Brand Sting',
  category: 'Branding',
  slots: ['start', 'end'],
  window: 'Intro / outro',
  duration: 3,
  start: 0.2,
  fields: [
    { key: 'mark', label: 'Mark', value: 'PN' },
    { key: 'tagline', label: 'Tagline', value: 'Philippine News' },
  ],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const inP = outBack(seg(t, 0, 0.5));
    const outP = seg(t, duration - 0.5, 0.5);
    const flash = seg(t, 0.55, 0.12) * (1 - seg(t, 0.67, 0.12));
    if ((inP === 0 && flash === 0) || outP === 1) return;
    const cx = box.w / 2;
    const cy = box.h * 0.43;
    const r = U * 1.35;
    const scale = Math.max(inP, 0.001) * (1 + outP * 0.18);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 1 - outP;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.lineWidth = Math.max(3, U * 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    const sweep = outCubic(seg(t, 0.2, 0.9));
    if (sweep > 0) {
      arc(ctx, 0, 0, r, -Math.PI / 2, -Math.PI / 2 + sweep * Math.PI * 0.75, RED, Math.max(3, U * 0.1));
    }
    ctx.font = font(800, U * 0.72);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((v.mark || 'PN').toUpperCase(), 0, U * 0.02);

    const tagline = (v.tagline || '').toUpperCase();
    if (tagline) {
      ctx.font = font(700, U * 0.2);
      ctx.fillStyle = 'rgba(255,255,255,.78)';
      fillTracked(
        ctx,
        tagline,
        -trackedWidth(ctx, tagline, U * 0.1) / 2,
        r + U * 0.55,
        U * 0.1
      );
    }
    ctx.restore();

    if (flash > 0) {
      ctx.save();
      ctx.globalAlpha = flash * 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, box.w, box.h);
      ctx.restore();
    }
  },
};

export const endPlate: VideoPreset = {
  id: 'end-plate',
  name: 'End Plate',
  category: 'Branding',
  slots: ['end'],
  window: 'Last 4s',
  duration: 4,
  start: 0,
  fields: [
    { key: 'title', label: 'End plate text', value: 'Follow for daily news' },
    { key: 'cta', label: 'Button label', value: 'Follow' },
  ],
  draw(ctx, t, duration, v, box) {
    const U = unit(box);
    const ovIn = seg(t, 0, 0.45);
    const outP = seg(t, duration - 0.55, 0.55);
    if (ovIn === 0 || outP === 1) return;
    const fade = 1 - outP;

    ctx.save();
    ctx.globalAlpha = fade;
    const gradient = ctx.createLinearGradient(0, box.h * 0.2, 0, box.h);
    gradient.addColorStop(0, 'rgba(6,10,14,0)');
    gradient.addColorStop(0.45, `rgba(6,10,14,${0.65 * ovIn})`);
    gradient.addColorStop(1, `rgba(6,10,14,${0.94 * ovIn})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, box.w, box.h);

    const words = (v.title || '')
      .toUpperCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    const size = U * 0.78;
    const lineH = size * 1.14;
    ctx.font = font(800, size);
    const lines = wrapText(ctx, words.join(' '), box.w - U * 2.6);
    const top = box.h * 0.6 - (lines.length * lineH) / 2;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = U * 0.25;
    lines.forEach((line, i) => {
      const inP = outQuart(seg(t, 0.22 + i * 0.13, 0.62));
      if (inP <= 0) return;
      const y = top + i * lineH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(U * 0.8, y - U * 0.06, box.w - U * 1.6, lineH + U * 0.12);
      ctx.clip();
      ctx.fillText(line, U * 1.3, y + (1 - inP) * (lineH + U * 0.12));
      ctx.restore();
    });
    ctx.shadowBlur = 0;

    const cta = (v.cta || 'Follow').toUpperCase();
    const btnP = outBack(seg(t, 0.7, 0.4));
    if (btnP > 0.001) {
      ctx.font = font(800, U * 0.3);
      const label = cta;
      const labelW = trackedWidth(ctx, label, U * 0.06);
      const bw = labelW + U * 1.5;
      const bh = U * 0.78;
      const by = top + lines.length * lineH + U * 0.55;
      ctx.save();
      ctx.translate(box.w / 2, by + bh / 2);
      ctx.scale(Math.max(btnP, 0.001), Math.max(btnP, 0.001));
      ctx.fillStyle = RED;
      roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      fillTracked(ctx, label, -labelW / 2, 1, U * 0.06);
      ctx.restore();
    }
    ctx.restore();
  },
};

export const cameraPush: VideoPreset = {
  id: 'camera-push',
  name: 'Slow Push In',
  category: 'Motion',
  slots: ['start', 'middle', 'end'],
  window: 'Whole clip',
  duration: 6,
  start: 0,
  fields: [],
  scale(t) {
    // Push in, then ease back out so the effect leaves the frame (and every
    // repeat starts) at zoom 1 — no jump when the planner drops it.
    const zoomIn = outCubic(seg(t, 0, 2.6));
    const settle = inCubic(seg(t, 4.6, 1.4));
    return 1 + 0.075 * zoomIn * (1 - settle);
  },
  draw(ctx, t, _duration, _v, box) {
    const U = unit(box);
    const p = inOutCubic(seg(t, 0, 1.2));
    if (p <= 0) return;
    const cx = box.w / 2;
    const cy = box.h / 2;
    const inner = U * 1.8;
    const outer = Math.hypot(box.w, box.h) / 2;
    const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${(0.34 * p).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, box.w, box.h);
    ctx.restore();
  },
};

export const VIDEO_PRESETS: VideoPreset[] = [
  {
    id: 'none',
    name: 'None',
    category: 'Titles',
    slots: [],
    window: 'No animation',
    duration: 0,
    start: 0,
    fields: [],
  },
  cinemaTitle,
  lowerThird,
  kineticCaption,
  statRing,
  newsTicker,
  frameWipe,
  logoSting,
  endPlate,
  cameraPush,
];

export const VIDEO_PRESET_CATEGORIES = [
  'All',
  'Titles',
  'Captions',
  'Newsroom',
  'Data',
  'Branding',
  'Motion',
] as const;

export function getVideoPreset(id: string | null | undefined): VideoPreset | null {
  if (!id) return null;
  return VIDEO_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function presetDefaultValues(presetId: string): PresetValues {
  const preset = getVideoPreset(presetId);
  if (!preset) return {};
  return Object.fromEntries(
    preset.fields.map((field) => [field.key, field.value])
  );
}

export type PlannedVideoEffect = PlannedEffectOf<VideoPreset>;
export type VideoEffectFrame = { effect: PlannedVideoEffect; local: number };

export function planVideoEffects(
  attachments: VideoAttachment[],
  videoDuration: number,
  values: Record<string, PresetValues> = {}
): PlannedVideoEffect[] {
  return planEffectsFor(
    attachments.map((attachment) => ({
      ...attachment,
      valuesKey: attachment.slot,
    })),
    videoDuration,
    values,
    getVideoPreset
  );
}

export function plannedVideoFrames(
  effects: PlannedVideoEffect[],
  t: number
): VideoEffectFrame[] {
  return plannedFramesFor(effects, t);
}

export function videoEffectRenderer(
  effect: PlannedVideoEffect
): VideoPreset['draw'] | VideoPreset['stream'] {
  return effect.loop && effect.preset.stream
    ? effect.preset.stream
    : effect.preset.draw;
}
