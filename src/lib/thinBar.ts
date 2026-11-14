import type { Track } from "./types";

/** What the wide thin bar shows about the queue. `next` is the song directly below the current one. */
export function queueSummary(queue: Track[], currentIndex: number | null) {
  return {
    count: queue.length,
    next: queue[(currentIndex ?? -1) + 1] ?? null,
    totalMs: queue.reduce((sum, t) => sum + t.durationMs, 0),
  };
}

/** The bar's width while dragging the handle: its width at the start plus how far the pointer moved. */
export function widthFromDrag(startWidth: number, startX: number, x: number): number {
  return Math.round(startWidth + (x - startX));
}

/** The narrowest the thin bar goes, in logical pixels. Keep in step with THIN_MIN_WIDTH in window_state.rs. */
export const THIN_MIN_WIDTH = 120;

/** Everything the thin bar can show. */
export interface ThinParts {
  playPause: boolean;
  volume: boolean;
  next: boolean;
  prev: boolean;
  title: boolean;
  time: boolean;
  /** Switch to the large window, and quit. */
  expandQuit: boolean;
  seek: boolean;
  repeat: boolean;
  shuffle: boolean;
  artist: boolean;
  cover: boolean;
  album: boolean;
  queue: boolean;
}

/**
 * The widths (logical pixels) at which the bar shows more, narrowest first. Each tier adds
 * to the one before it. Growing from the minimum: play/pause and volume, then next,
 * previous, the title, the time, the scrubber, then the extras. Narrowing drops them in
 * the reverse order.
 */
export const THIN_TIERS: readonly { min: number; adds: (keyof ThinParts)[] }[] = [
  { min: THIN_MIN_WIDTH, adds: ["playPause", "volume"] },
  { min: 160, adds: ["next"] },
  { min: 200, adds: ["prev"] },
  { min: 260, adds: ["title"] },
  { min: 340, adds: ["time", "expandQuit"] },
  { min: 420, adds: ["seek"] },
  { min: 520, adds: ["repeat"] },
  { min: 620, adds: ["shuffle"] },
  { min: 760, adds: ["artist"] },
  { min: 960, adds: ["cover", "album"] },
  { min: 1280, adds: ["queue"] },
];

/** The tier for a bar this wide. Anything under the minimum, or not a number, is the smallest tier. */
export function thinTier(width: number): number {
  let tier = 0;
  THIN_TIERS.forEach((t, i) => {
    if (width >= t.min) tier = i;
  });
  return tier;
}

/** What the bar shows at `tier`. */
export function thinParts(tier: number): ThinParts {
  const parts: ThinParts = {
    playPause: false, volume: false, next: false, prev: false, title: false, time: false, expandQuit: false,
    seek: false, repeat: false, shuffle: false, artist: false, cover: false, album: false, queue: false,
  };
  THIN_TIERS.slice(0, tier + 1).forEach((t) => t.adds.forEach((key) => (parts[key] = true)));
  return parts;
}

/** The height of one queue row, and of the panel's header and tools above the rows (logical pixels). */
const PANEL_ROW = 28;
const PANEL_CHROME = 72;

/** The panel height that shows the whole queue (an empty queue still shows its message). */
export function panelWantedHeight(rows: number): number {
  return PANEL_CHROME + Math.max(rows, 1) * PANEL_ROW;
}
