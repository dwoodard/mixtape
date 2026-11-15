/** How wide the DJ panel may be, in logical pixels, and how wide it starts. */
export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 900;
export const PANEL_DEFAULT_WIDTH = 380;
/** Space always left between the panel and the window's other edge. */
const WINDOW_MARGIN = 16;

/** `width` kept inside the limits, and inside what the window has room for. Not a number gives the default. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  const room = Math.max(PANEL_MIN_WIDTH, windowWidth - WINDOW_MARGIN);
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), Math.min(PANEL_MAX_WIDTH, room)));
}

/** The panel is on the right, so dragging its left edge to the left makes it wider. */
export function widthFromDrag(startWidth: number, startX: number, x: number, windowWidth: number): number {
  return clampPanelWidth(startWidth + (startX - x), windowWidth);
}

/**
 * Whether a press at `target` should close the DJ panel: it landed outside the panel, and not on the DJ button
 * (which toggles it itself) or on a menu or dialog, which the chat may have opened.
 */
export function pressClosesPanel(
  target: { closest?: (selector: string) => unknown } | null,
  panel: { contains: (node: never) => boolean } | null,
): boolean {
  if (!target || typeof target.closest !== "function" || !panel) return false;
  if (panel.contains(target as never)) return false;
  return !target.closest('.dj-toggle, [role="menu"], [role="dialog"], .backdrop');
}
