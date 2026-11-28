// Photo-motion presets for the narrated photo slideshow (slideshow.ts).
//
// Like lib/videos/presets.ts and lib/reels/presets.ts, this module is
// intentionally GSAP-free so the bake path can import it without pulling GSAP
// into module scope: the bake samples `draw` once per frame from the wall
// clock, and the GSAP-driven looping preview lives in
// slideshow-presets.preview.ts and samples the very same draw — what you
// preview is exactly what gets baked.

export const SLIDESHOW_WIDTH = 1920;
export const SLIDESHOW_HEIGHT = 1080;

export type SlideshowBox = { w: number; h: number };

export type SlideshowPreset = {
  id: string;
  name: string;
  description: string;
  /** Paint one frame at global time `t` across `images` over `duration`. */
  draw: (
    context: CanvasRenderingContext2D,
    images: HTMLImageElement[],
    t: number,
    duration: number,
    box: SlideshowBox,
  ) => void;
};

/** Cover-crop a photo into the box, centered. */
export function drawSlideshowImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width = SLIDESHOW_WIDTH,
  height = SLIDESHOW_HEIGHT,
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

export type SlideshowCard = {
  /** Card rect in box space, before transforms. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Slow push-in around the card center (1 = no zoom). */
  zoom?: number;
  /** Horizontal offset in px from the card's resting center. */
  offsetX?: number;
  /** Horizontal compression — the fake rotateY perspective. */
  scaleX?: number;
  /** Slight rotation in radians for the side cards. */
  tilt?: number;
  /** 0–1 darkening overlay so side cards recede. */
  darken?: number;
};

/** Draw one photo cover-fit inside a card rect with coverflow transforms. */
export function drawSlideshowCard(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  card: SlideshowCard,
): void {
  const zoom = card.zoom ?? 1;
  const centerX = card.x + card.w / 2;
  const centerY = card.y + card.h / 2;
  context.save();
  context.translate(centerX + (card.offsetX ?? 0), centerY);
  if (card.tilt) context.rotate(card.tilt);
  context.scale(card.scaleX ?? 1, 1);
  const sourceWidth = image.naturalWidth || card.w;
  const sourceHeight = image.naturalHeight || card.h;
  const scale = Math.max(card.w / sourceWidth, card.h / sourceHeight) * zoom;
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  if (card.darken) {
    context.fillStyle = `rgba(9, 14, 22, ${card.darken})`;
    context.fillRect(-card.w / 2, -card.h / 2, card.w, card.h);
  }
  context.restore();
}

function drawBackdrop(context: CanvasRenderingContext2D, box: SlideshowBox): void {
  const gradient = context.createRadialGradient(
    box.w / 2,
    box.h * 0.42,
    box.h * 0.1,
    box.w / 2,
    box.h / 2,
    Math.hypot(box.w, box.h) * 0.62,
  );
  gradient.addColorStop(0, '#1d2836');
  gradient.addColorStop(1, '#0b111b');
  context.fillStyle = gradient;
  context.fillRect(0, 0, box.w, box.h);
}

function drawStraightFrame(
  context: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  t: number,
  duration: number,
  box: SlideshowBox,
): void {
  const image = images[straightImageIndex(images.length, t, duration)];
  if (image) drawSlideshowImage(context, image, box.w, box.h);
}

/** Equal windows, like the original slideshow: photo i owns [i·w, (i+1)·w). */
function straightImageIndex(count: number, t: number, duration: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.floor((t / duration) * count));
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Carousel (coverflow) tuning — all deterministic from t, no easing libs.
const CAROUSEL_TRANSITION_SECONDS = 0.8;
const CAROUSEL_MAX_TRANSITION_FRACTION = 0.4;
const CAROUSEL_SPACING = 0.55; // × box width between neighboring card centers
const CAROUSEL_CARD_WIDTH = 0.5; // × box width
const CAROUSEL_CARD_HEIGHT = 0.76; // × box height
const CAROUSEL_SIDE_SCALE = 0.72;
const CAROUSEL_SIDE_SQUEEZE = 0.85;
const CAROUSEL_SIDE_TILT = (4 * Math.PI) / 180;
const CAROUSEL_SIDE_DARKEN = 0.35;
const CAROUSEL_DWELL_ZOOM = 0.04;
const CAROUSEL_VISIBLE_SPAN = 1.2; // |d| beyond this paints no visible pixels

/**
 * Photo-space progress: whole part = photo in focus, fraction = eased move
 * toward the next photo during the tail of each window.
 */
function carouselProgress(count: number, t: number, duration: number): number {
  const window = count > 0 ? duration / count : 0;
  if (window <= 0) return 0;
  const index = Math.min(count - 1, Math.floor(t / window));
  const local = Math.min(1, Math.max(0, (t - index * window) / window));
  const transitionFraction = Math.min(
    CAROUSEL_MAX_TRANSITION_FRACTION,
    CAROUSEL_TRANSITION_SECONDS / window,
  );
  const moveStart = 1 - transitionFraction;
  const moving = index < count - 1 && local >= moveStart;
  const eased = moving
    ? easeInOutCubic((local - moveStart) / transitionFraction)
    : 0;
  return index + eased;
}

function drawCarouselFrame(
  context: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  t: number,
  duration: number,
  box: SlideshowBox,
): void {
  const count = images.length;
  if (!count) return;
  drawBackdrop(context, box);
  if (count === 1) {
    // A lone photo fronts the frame with a gentle push-in, cover-style.
    const progress = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0;
    drawSlideshowCard(context, images[0], {
      x: 0,
      y: 0,
      w: box.w,
      h: box.h,
      zoom: 1 + CAROUSEL_DWELL_ZOOM * progress,
    });
    return;
  }
  const window = duration / count;
  const progress = carouselProgress(count, t, duration);
  const baseCardWidth = box.w * CAROUSEL_CARD_WIDTH;
  const baseCardHeight = box.h * CAROUSEL_CARD_HEIGHT;
  const centerX = box.w / 2;
  const centerY = box.h / 2;
  const spacing = box.w * CAROUSEL_SPACING;
  // |d| = how far a photo is from the focus slot; paint back-to-front so the
  // focused card lands on top.
  const cards = images
    .map((image, index) => ({ image, index, d: progress - index }))
    .filter(({ d }) => Math.abs(d) <= CAROUSEL_VISIBLE_SPAN)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const { image, index, d } of cards) {
    const side = Math.min(1, Math.abs(d));
    // Each photo pushes in slowly across its own window; neighbors rest at
    // the ends of that ramp. Side cards shrink back, squeeze, tilt, and
    // darken as they recede.
    const age = Math.min(1, Math.max(0, (t - index * window) / window));
    const cardScale = 1 - (1 - CAROUSEL_SIDE_SCALE) * side;
    const cardWidth = baseCardWidth * cardScale;
    const cardHeight = baseCardHeight * cardScale;
    drawSlideshowCard(context, image, {
      x: centerX - cardWidth / 2,
      y: centerY - cardHeight / 2,
      w: cardWidth,
      h: cardHeight,
      zoom: 1 + CAROUSEL_DWELL_ZOOM * age,
      offsetX: -d * spacing,
      scaleX: 1 - (1 - CAROUSEL_SIDE_SQUEEZE) * side,
      tilt: d * CAROUSEL_SIDE_TILT,
      darken: CAROUSEL_SIDE_DARKEN * side,
    });
  }
}

export const SLIDESHOW_PRESETS: SlideshowPreset[] = [
  {
    id: 'straight',
    name: 'Straight cuts',
    description: 'Each photo fills the frame and changes on the beat.',
    draw: drawStraightFrame,
  },
  {
    id: 'carousel',
    name: 'Carousel',
    description: 'Coverflow — the photo fronts the frame while neighbors glide by at the sides.',
    draw: drawCarouselFrame,
  },
];

export const DEFAULT_SLIDESHOW_PRESET_ID = 'straight';

export function getSlideshowPreset(presetId: string): SlideshowPreset | null {
  return SLIDESHOW_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

/**
 * Paint one frame of the slideshow. Unknown or missing preset ids fall back
 * to straight cuts, so the bake behaves exactly as before the preset system.
 */
export function drawSlideshowFrame(
  context: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  t: number,
  duration: number,
  box: SlideshowBox,
  presetId?: string,
): void {
  const preset = presetId ? getSlideshowPreset(presetId) : null;
  if (preset) {
    preset.draw(context, images, t, duration, box);
    return;
  }
  drawStraightFrame(context, images, t, duration, box);
}
