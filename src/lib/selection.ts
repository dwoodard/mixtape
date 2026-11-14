import type { Track } from "./types";

export interface Selection {
  paths: ReadonlySet<string>;
  /** Where a shift-click or shift-arrow range starts. */
  anchor: string | null;
  /** The row the keyboard moves from: the one last clicked or arrowed to. */
  focus: string | null;
}

export const emptySelection = (): Selection => ({ paths: new Set(), anchor: null, focus: null });

export interface ClickModifiers {
  shift: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  toggle: boolean;
}

/**
 * Applies a click on `path` the way Finder does: plain click selects only
 * that row, Cmd/Ctrl-click toggles it, Shift-click selects the range from the anchor.
 * `ordered` is the visible row order.
 */
export function clickRow(
  current: Selection,
  ordered: readonly string[],
  path: string,
  mods: ClickModifiers,
): Selection {
  if (mods.toggle) {
    const paths = new Set(current.paths);
    if (!paths.delete(path)) paths.add(path);
    return { paths, anchor: path, focus: path };
  }
  if (mods.shift && current.anchor !== null) {
    const from = ordered.indexOf(current.anchor);
    const to = ordered.indexOf(path);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      return { paths: new Set(ordered.slice(start, end + 1)), anchor: current.anchor, focus: path };
    }
  }
  return { paths: new Set([path]), anchor: path, focus: path };
}

export function selectAll(ordered: readonly string[]): Selection {
  return { paths: new Set(ordered), anchor: ordered[0] ?? null, focus: ordered[ordered.length - 1] ?? null };
}

/** The selected tracks in the order they appear in `tracks`. */
export function selectedTracks(tracks: readonly Track[], selection: Selection): Track[] {
  return tracks.filter((t) => selection.paths.has(t.path));
}

/** Drops selected paths that are no longer visible (after a filter or view change). */
export function pruneSelection(selection: Selection, ordered: readonly string[]): Selection {
  const visible = new Set(ordered);
  const paths = new Set([...selection.paths].filter((p) => visible.has(p)));
  if (paths.size === selection.paths.size) return selection;
  const keep = (p: string | null) => (p && visible.has(p) ? p : null);
  return { paths, anchor: keep(selection.anchor), focus: keep(selection.focus) };
}

/**
 * Moves the selection up or down by `delta` rows (the arrow keys). With
 * `extend` (Shift) the selection grows from the anchor instead of moving.
 * Starting with nothing focused, Down goes to the first row and Up to the last.
 * Returns the new selection and the index of the row it landed on, or `null`
 * when there are no rows.
 */
export function moveSelection(
  current: Selection,
  ordered: readonly string[],
  delta: number,
  extend: boolean,
): { selection: Selection; index: number } | null {
  if (ordered.length === 0) return null;
  const from = current.focus === null ? -1 : ordered.indexOf(current.focus);
  const index =
    from === -1
      ? delta > 0
        ? 0
        : ordered.length - 1
      : Math.min(ordered.length - 1, Math.max(0, from + delta));
  const path = ordered[index];
  if (extend) {
    const anchor = current.anchor !== null && ordered.includes(current.anchor) ? current.anchor : path;
    const [start, end] = [ordered.indexOf(anchor), index].sort((a, b) => a - b);
    return { selection: { paths: new Set(ordered.slice(start, end + 1)), anchor, focus: path }, index };
  }
  return { selection: { paths: new Set([path]), anchor: path, focus: path }, index };
}
