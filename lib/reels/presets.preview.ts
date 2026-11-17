import { gsap } from 'gsap';
import {
  headline,
  breaking,
  lowerthird,
  captionpop,
  captionActiveStart,
  quote,
  stat,
  punchzoom,
  logosting,
  endcard,
  getPreset,
  type PresetValues,
  type ReelPreset,
} from './presets';

type Timeline = ReturnType<typeof gsap.timeline>;

/* ----------------------------- DOM preview helpers ------------------------- */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function loop(fn: (tl: Timeline) => void): Timeline | null {
  if (prefersReducedMotion()) return null;
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.9 });
  fn(tl);
  return tl;
}

function div(parent: HTMLElement, css: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  if (text != null) d.textContent = text;
  parent.appendChild(d);
  return d;
}

/** Simulated footage background shared by every DOM preview. Bright enough
 * that the translucent panels read the way they will over real footage. */
function addStageBg(stage: HTMLElement): HTMLDivElement {
  stage.style.fontFamily = 'Manrope, sans-serif';
  return div(
    stage,
    'position:absolute;inset:0;background:radial-gradient(120% 90% at 22% 10%, #93b1bd 0%, #5e7d8a 46%, #365661 100%);'
  );
}

/** Masked word: clipped container + inner span that GSAP slides in from below. */
function maskedWord(parent: HTMLElement, css: string, text: string): HTMLDivElement {
  const mask = div(parent, 'display:block;overflow:hidden;');
  return div(mask, css, text);
}

const RED = '#d92d20';

/* --------------------------------- mounts ---------------------------------- */

const HEADLINE_SIZE = 30;
const HEADLINE_LINE = 1.14;

const headlineMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const wrap = div(stage, 'position:absolute;left:20px;right:20px;top:52px;');
  const bar = div(
    wrap,
    `position:absolute;top:-14px;left:0;width:34px;height:5px;background:${RED};border-radius:2px;`
  );
  const words = (v.text || '')
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const wordEls = words.map((w) =>
    maskedWord(
      wrap,
      `font-weight:800;font-size:${HEADLINE_SIZE}px;line-height:${HEADLINE_LINE};letter-spacing:-.3px;color:#fff;text-transform:uppercase;text-shadow:0 2px 16px rgba(0,0,0,.38);transform-origin:0% 100%;`,
      w
    )
  );
  const rule = words.length
    ? div(
        wrap,
        `position:absolute;left:0;top:${(words.length * HEADLINE_SIZE * HEADLINE_LINE + 6).toFixed(1)}px;width:85px;height:3px;background:${RED};border-radius:2px;transform-origin:0 50%;`
      )
    : null;
  return loop((tl) => {
    tl.from(bar, { scaleX: 0, transformOrigin: '0 50%', duration: 0.35, ease: 'power3.out' });
    if (!wordEls.length) {
      tl.to(bar, { scaleX: 0, transformOrigin: '100% 50%', duration: 0.3, ease: 'power2.in' }, '+=1');
      return;
    }
    tl.from(
      wordEls,
      {
        yPercent: 118,
        scale: 0.96,
        transformOrigin: '0% 100%',
        duration: 0.55,
        stagger: 0.16,
        ease: 'power4.out',
      },
      '-=0.1'
    )
      .from(rule!, { scaleX: 0, duration: 0.5, ease: 'power4.out' }, '-=0.35')
      .to(wordEls, { yPercent: -118, duration: 0.4, stagger: 0.05, ease: 'power2.in' }, '+=1.05')
      .to(rule!, { scaleX: 0, transformOrigin: '100% 50%', duration: 0.3, ease: 'power2.in' }, '-=0.35')
      .to(bar, { scaleX: 0, transformOrigin: '100% 50%', duration: 0.3, ease: 'power2.in' }, '-=0.3');
  });
};

const breakingMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const tag = div(
    stage,
    `position:absolute;top:30px;left:20px;width:85px;height:18.5px;background:${RED};border-radius:2px;`
  );
  div(
    tag,
    'position:absolute;left:0;right:8px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:7px;font-weight:800;letter-spacing:.12em;padding-right:3px;',
    'BREAKING'
  );
  const dot = div(
    tag,
    'position:absolute;right:4.5px;top:50%;width:4.5px;height:4.5px;margin-top:-2.25px;border-radius:50%;background:#fff;'
  );
  const bar = div(
    stage,
    'position:absolute;left:0;right:0;bottom:50px;height:35px;background:rgba(10,14,18,.92);overflow:hidden;'
  );
  div(bar, `position:absolute;left:0;right:0;top:0;height:1.5px;background:${RED};`);
  div(bar, 'position:absolute;left:0;right:0;top:1.5px;height:0.5px;background:rgba(255,255,255,.16);');
  const tick = div(
    bar,
    'position:absolute;left:0;top:50%;margin-top:-8px;white-space:nowrap;color:#fff;font-size:12px;font-weight:700;letter-spacing:.04em;',
    `${(v.text || '').toUpperCase()}   •   `.repeat(3)
  );
  return loop((tl) => {
    tl.from(tag, { scale: 1.7, opacity: 0, duration: 0.3, ease: 'back.out(2.2)' })
      .to(dot, { opacity: 0.35, duration: 0.35, yoyo: true, repeat: 5, ease: 'sine.inOut' }, 0.3)
      // Banner stays put — only the ticker scrolls.
      .from(bar, { opacity: 0, duration: 0.18, ease: 'none' }, 0)
      .fromTo(tick, { xPercent: 8 }, { xPercent: -60, duration: 5, ease: 'none' }, 0.1)
      .to([tag, bar], { opacity: 0, duration: 0.35 }, '+=0.2');
  });
};

const lowerthirdMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const wrap = div(
    stage,
    'position:absolute;left:14px;bottom:64px;display:flex;align-items:stretch;'
  );
  const accent = div(wrap, `width:4px;background:${RED};transform-origin:50% 100%;`);
  const body = div(
    wrap,
    'position:relative;background:rgba(10,14,18,.92);padding:8px 14px 9px 12px;border-radius:1.5px;'
  );
  div(body, 'position:absolute;left:0;right:0;top:0;height:0.5px;background:rgba(255,255,255,.14);');
  const name = div(
    body,
    'color:#fff;font-size:15px;font-weight:800;letter-spacing:-.2px;',
    (v.name || '').toUpperCase()
  );
  const role = div(
    body,
    'color:#f7b3ad;font-size:7.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:2px;',
    'FIELD REPORTER'
  );
  return loop((tl) => {
    tl.from(wrap, { xPercent: -130, duration: 0.45, ease: 'power4.out' })
      .from(accent, { scaleY: 0, duration: 0.4, ease: 'power2.out' }, '-=0.35')
      .from(name, { opacity: 0, y: 8, duration: 0.35, ease: 'power3.out' }, '-=0.3')
      .from(role, { opacity: 0, x: -6, duration: 0.35, ease: 'power3.out' }, '-=0.25')
      .to(wrap, { xPercent: -130, duration: 0.45, ease: 'power2.inOut' }, '+=1.35');
  });
};

const captionpopMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const wrap = div(
    stage,
    'position:absolute;left:18px;right:18px;bottom:110px;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;'
  );
  const chips = (v.text || '')
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      div(
        wrap,
        'background:rgba(10,14,18,.85);color:#fff;font-size:15px;font-weight:800;padding:5px 11px;border-radius:7px;text-transform:uppercase;',
        w
      )
    );
  return loop((tl) => {
    if (!chips.length) return;
    tl.from(chips, { scale: 0, opacity: 0, duration: 0.32, stagger: 0.22, ease: 'back.out(2.4)' });
    // Karaoke beat: each word flashes the brand red as it "speaks", on the
    // same sweep the baked reel draws.
    chips.forEach((chip, i) => {
      tl.to(
        chip,
        {
          backgroundColor: RED,
          scale: 1.04,
          duration: 0.16,
          yoyo: true,
          repeat: 1,
          ease: 'sine.inOut',
        },
        captionActiveStart(i, captionpop.duration, chips.length)
      );
    });
    tl.to(chips, { opacity: 0, duration: 0.3, stagger: 0.03 }, '+=0.4');
  });
};

const quoteMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const card = div(
    stage,
    'position:absolute;left:22px;right:22px;top:44%;background:rgba(10,14,18,.62);border-radius:9px;padding:14px 14px 30px;'
  );
  const accent = div(
    card,
    `position:absolute;left:0;top:0;bottom:0;width:3.5px;background:${RED};transform-origin:50% 50%;`
  );
  div(
    card,
    `position:absolute;left:10px;top:4px;color:${RED};font-size:34px;font-weight:800;line-height:1;`,
    '“'
  );
  const text = div(
    card,
    'position:relative;color:#fff;font-size:13.5px;font-weight:600;line-height:1.45;padding-left:18px;',
    v.text || ''
  );
  const by = div(
    card,
    'position:relative;color:#c8d2d8;font-size:7.5px;font-weight:700;margin-top:7px;letter-spacing:.08em;text-transform:uppercase;padding-left:18px;',
    (v.by || '').toUpperCase()
  );
  return loop((tl) => {
    tl.from(card, { y: 26, opacity: 0, scale: 0.98, duration: 0.5, ease: 'power3.out' })
      .from(accent, { scaleY: 0, duration: 0.5, ease: 'power4.out' }, '-=0.38')
      .from(text, { opacity: 0, y: 10, duration: 0.45, ease: 'power3.out' }, '-=0.34')
      .from(by, { opacity: 0, x: -5, duration: 0.35, ease: 'power3.out' }, '-=0.25')
      .to(card, { opacity: 0, y: -14, duration: 0.4, ease: 'power2.inOut' }, '+=1.5');
  });
};

const statMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  div(
    stage,
    'position:absolute;inset:0;background:radial-gradient(closest-side at 50% 44%, transparent 26%, rgba(5,10,14,.5) 78%);'
  );
  const wrap = div(
    stage,
    'position:absolute;left:20px;right:20px;top:40%;text-align:center;'
  );
  const num = div(
    wrap,
    'color:#fff;font-size:54px;font-weight:800;letter-spacing:-2px;line-height:1;text-shadow:0 4px 22px rgba(0,0,0,.4);',
    v.num || ''
  );
  const rule = div(
    wrap,
    `width:50px;height:3.5px;background:${RED};border-radius:2px;margin:9px auto 0;transform-origin:50% 50%;`
  );
  const label = div(
    wrap,
    'color:#d7e0e6;font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:6px;',
    (v.label || '').toUpperCase()
  );
  const match = /^(\d+)/.exec(v.num || '');
  const counter = { n: 0 };
  return loop((tl) => {
    tl.from(wrap, { scale: 1.35, opacity: 0, duration: 0.45, ease: 'power4.out' });
    if (match) {
      const target = Number(match[1]);
      const suffix = (v.num || '').slice(match[1].length);
      tl.fromTo(
        counter,
        { n: 0 },
        {
          n: target,
          duration: 0.8,
          ease: 'power2.out',
          onUpdate: () => {
            num.textContent = `${Math.round(counter.n)}${suffix}`;
          },
        },
        0.08
      );
    }
    tl.from(rule, { scaleX: 0, duration: 0.45, ease: 'power4.out' }, 0.32)
      .from(label, { opacity: 0, y: 5, duration: 0.4, ease: 'power3.out' }, 0.4)
      .to(wrap, { opacity: 0, duration: 0.35 }, '+=1.1');
  });
};

const punchzoomMount = (stage: HTMLElement): Timeline | null => {
  const bg = addStageBg(stage);
  div(
    stage,
    'position:absolute;inset:0;background:radial-gradient(90% 70% at 50% 45%, transparent 55%, rgba(5,10,14,.55) 100%);'
  );
  return loop((tl) => {
    tl.fromTo(bg, { scale: 1 }, { scale: 1.16, duration: 0.3, ease: 'power4.out' }).to(
      bg,
      { scale: 1, duration: 0.5, ease: 'power2.inOut' },
      '+=1.0'
    );
  });
};

const logostingMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const ring = div(
    stage,
    'position:absolute;left:50%;top:44%;width:84px;height:84px;margin:-42px 0 0 -42px;border:3px solid #fff;border-radius:50%;'
  );
  // Brand arc sweeps around the ring (SVG so the stroke can be drawn on).
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 84 84');
  svg.style.cssText =
    'position:absolute;left:50%;top:44%;width:84px;height:84px;margin:-42px 0 0 -42px;overflow:visible;';
  const arc = document.createElementNS(ns, 'circle');
  const circumference = 2 * Math.PI * 40.5;
  arc.setAttribute('cx', '42');
  arc.setAttribute('cy', '42');
  arc.setAttribute('r', '40.5');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', RED);
  arc.setAttribute('stroke-width', '3');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', `${circumference}`);
  arc.setAttribute('stroke-dashoffset', `${circumference}`);
  arc.setAttribute('transform', 'rotate(-90 42 42)');
  svg.appendChild(arc);
  stage.appendChild(svg);
  const mark = div(
    stage,
    'position:absolute;left:50%;top:44%;width:84px;height:84px;margin:-42px 0 0 -42px;display:grid;place-items:center;color:#fff;font-size:24px;font-weight:800;letter-spacing:1px;',
    (v.text || 'PN').toUpperCase()
  );
  const flash = div(stage, 'position:absolute;inset:0;background:#fff;opacity:0;');
  return loop((tl) => {
    tl.from(ring, { scale: 0, duration: 0.45, ease: 'back.out(2)' })
      .fromTo(
        arc,
        { strokeDashoffset: circumference },
        { strokeDashoffset: circumference * 0.25, duration: 0.9, ease: 'power2.out' },
        '-=0.32'
      )
      .from(mark, { scale: 0, duration: 0.4, ease: 'back.out(2.4)' }, '-=0.45')
      .to(flash, { opacity: 0.4, duration: 0.12, yoyo: true, repeat: 1 }, '-=0.1')
      .to([ring, mark, svg], { scale: 1.25, opacity: 0, duration: 0.4, ease: 'power2.in' }, '+=0.8');
  });
};

const endcardMount = (stage: HTMLElement, v: PresetValues): Timeline | null => {
  addStageBg(stage);
  const ov = div(
    stage,
    'position:absolute;inset:0;background:linear-gradient(180deg, rgba(6,10,14,.45) 0%, rgba(6,10,14,.8) 55%, rgba(6,10,14,.94) 100%);'
  );
  const wrap = div(
    stage,
    'position:absolute;left:24px;right:24px;top:42%;text-align:center;'
  );
  const title = maskedWord(
    wrap,
    'font-weight:800;font-size:27px;line-height:1.16;color:#fff;text-transform:uppercase;text-shadow:0 2px 16px rgba(0,0,0,.4);',
    (v.text || '').toUpperCase()
  );
  const rule = div(
    wrap,
    `width:52px;height:3px;background:${RED};border-radius:2px;margin:9px auto 0;transform-origin:50% 50%;`
  );
  const btn = div(
    wrap,
    `display:inline-block;margin-top:12px;background:${RED};color:#fff;font-size:10px;font-weight:800;letter-spacing:.12em;padding:7px 16px;border-radius:999px;`,
    'FOLLOW'
  );
  return loop((tl) => {
    tl.from(ov, { opacity: 0, duration: 0.4 })
      .from(title, { yPercent: 120, duration: 0.55, ease: 'power4.out' }, '-=0.1')
      .from(rule, { scaleX: 0, duration: 0.45, ease: 'power4.out' }, '-=0.35')
      .from(btn, { scale: 0, duration: 0.35, ease: 'back.out(2.2)' }, '-=0.28')
      .to([ov, wrap], { opacity: 0, duration: 0.4 }, '+=1.5');
  });
};

// Attach the GSAP mount functions to the preset objects (core is GSAP-free).
(headline as ReelPreset).mount = headlineMount;
(breaking as ReelPreset).mount = breakingMount;
(lowerthird as ReelPreset).mount = lowerthirdMount;
(captionpop as ReelPreset).mount = captionpopMount;
(quote as ReelPreset).mount = quoteMount;
(stat as ReelPreset).mount = statMount;
(punchzoom as ReelPreset).mount = punchzoomMount;
(logosting as ReelPreset).mount = logostingMount;
(endcard as ReelPreset).mount = endcardMount;

/**
 * Mount a preset's looping DOM preview into a 270×480 design-space stage.
 * Returns the timeline so the caller can kill it on cleanup.
 */
export function mountPreset(
  stage: HTMLElement,
  presetId: string,
  values: PresetValues
): Timeline | null {
  const preset = getPreset(presetId);
  if (!preset?.mount) return null;
  return preset.mount(stage, values ?? {}) as Timeline | null;
}
