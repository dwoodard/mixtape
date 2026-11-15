import type { Track } from "./types";

/** What Enter does in a track list, from how many songs are selected. */
export type EnterAction = "none" | "choose" | "play-selection";

/** One song is treated like a double-click; several play as a selection; none does nothing. */
export function enterAction(selectedCount: number): EnterAction {
  if (selectedCount === 0) return "none";
  return selectedCount === 1 ? "choose" : "play-selection";
}

export interface SongActions {
  playNow(track: Track): unknown;
  enqueueNext(tracks: Track[]): unknown;
  enqueue(tracks: Track[]): unknown;
}

/** The choices offered for one song while something is playing. Each acts on that song only. */
export function songChoiceItems(track: Track, actions: SongActions): { label: string; action: () => void }[] {
  return [
    { label: "Play now", action: () => void actions.playNow(track) },
    { label: "Play next", action: () => void actions.enqueueNext([track]) },
    { label: "Add to queue", action: () => void actions.enqueue([track]) },
  ];
}

/** Option+click adds songs to the queue. Shift, Cmd and Ctrl clicks select, so they never count. */
export function isAddClick(event: { altKey: boolean; metaKey: boolean; shiftKey: boolean; ctrlKey: boolean }): boolean {
  return event.altKey && !event.metaKey && !event.shiftKey && !event.ctrlKey;
}

/**
 * What Option+click on row `index` adds: the whole selection (in the order shown) when
 * that row is part of it, otherwise just that row. Never the rest of the view.
 */
export function optionClickTargets(rows: Track[], selectedPaths: ReadonlySet<string>, index: number): Track[] {
  const clicked = rows[index];
  if (!clicked) return [];
  return selectedPaths.has(clicked.path) ? rows.filter((t) => selectedPaths.has(t.path)) : [clicked];
}
