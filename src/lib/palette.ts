/** A color with channels 0 to 255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Colors the visuals draw with, picked from an album cover. */
export interface Palette {
  /** Darkest tone, for the canvas background. */
  background: Rgb;
  /** Strong, saturated tone for the main shapes. */
  accent: Rgb;
  /** Light tone for glints and edges. */
  highlight: Rgb;
  /** Every distinct color found, most common first. Always has at least one entry. */
  swatches: Rgb[];
}

export function rgba({ r, g, b }: Rgb, alpha = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/** Hue 0-360, saturation and lightness 0-1. */
export function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

const distance = (a: Rgb, b: Rgb) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Swatches closer than this look like the same color. */
const MIN_SWATCH_GAP = 60;
const MAX_SWATCHES = 6;

/**
 * Picks the visuals' colors from RGBA pixel data (for example a small canvas copy of the cover).
 * Colors are grouped into coarse buckets, then ranked by how common and how colorful they are,
 * so a mostly gray cover with one vivid accent still gives that accent.
 */
export function paletteFromPixels(data: ArrayLike<number>): Palette {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else buckets.set(key, { count: 1, r, g, b });
  }
  if (buckets.size === 0) return fallbackPalette(210);

  const ranked = [...buckets.values()]
    .map((b) => {
      const color = { r: b.r / b.count, g: b.g / b.count, b: b.b / b.count };
      const { s, l } = toHsl(color);
      // Very dark and very light buckets are rarely the cover's character.
      const mid = 1 - Math.abs(l - 0.5) * 1.2;
      return { color, score: b.count * (0.35 + s) * Math.max(mid, 0.15) };
    })
    .sort((a, b) => b.score - a.score);

  const swatches: Rgb[] = [];
  for (const { color } of ranked) {
    if (swatches.every((s) => distance(s, color) >= MIN_SWATCH_GAP)) swatches.push(color);
    if (swatches.length === MAX_SWATCHES) break;
  }

  const hsl = swatches.map((c) => toHsl(c));
  const vivid = hsl.reduce((best, c, i) => (c.s * (1 - Math.abs(c.l - 0.55)) > hsl[best].s * (1 - Math.abs(hsl[best].l - 0.55)) ? i : best), 0);
  const accentHsl = hsl[vivid];
  const accent = fromHsl(accentHsl.h, Math.max(accentHsl.s, 0.35), Math.min(Math.max(accentHsl.l, 0.5), 0.68));

  const darkest = hsl.reduce((best, c, i) => (c.l < hsl[best].l ? i : best), 0);
  const background = fromHsl(hsl[darkest].h, Math.min(hsl[darkest].s, 0.5), Math.min(hsl[darkest].l, 0.1));

  const lightest = hsl.reduce((best, c, i) => (c.l > hsl[best].l ? i : best), 0);
  const highlight = fromHsl(hsl[lightest].h, Math.min(hsl[lightest].s, 0.6), Math.max(hsl[lightest].l, 0.8));

  return { background, accent, highlight, swatches: swatches.map((_, i) => (i === vivid ? accent : swatches[i])) };
}

/** Colors for a song with no readable cover, built from the same hue its placeholder cover uses. */
export function fallbackPalette(hue: number): Palette {
  const accent = fromHsl(hue, 0.6, 0.58);
  return {
    background: fromHsl(hue, 0.35, 0.07),
    accent,
    highlight: fromHsl((hue + 30) % 360, 0.7, 0.85),
    swatches: [accent, fromHsl((hue + 40) % 360, 0.55, 0.5), fromHsl((hue + 320) % 360, 0.5, 0.55)],
  };
}
