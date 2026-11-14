import type { Track } from "./types";

export interface Selection {
  paths: ReadonlySet<string>;
  /** Where a shift-click range starts. */
  anchor: string | null;
}

export const emptySelection = (): Selection => ({ paths: new Set(), anchor: null });

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
    return { paths, anchor: path };
  }
  if (mods.shift && current.anchor !== null) {
    const from = ordered.indexOf(current.anchor);
    const to = ordered.indexOf(path);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      return { paths: new Set(ordered.slice(start, end + 1)), anchor: current.anchor };
    }
  }
  return { paths: new Set([path]), anchor: path };
}

export function selectAll(ordered: readonly string[]): Selection {
  return { paths: new Set(ordered), anchor: ordered[0] ?? null };
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
  return { paths, anchor: selection.anchor && visible.has(selection.anchor) ? selection.anchor : null };
}
