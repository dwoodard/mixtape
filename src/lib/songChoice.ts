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
