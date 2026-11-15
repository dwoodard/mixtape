import { ref } from "vue";
import type { Track } from "./types";
import { VISUAL_MODES, type VisualMode } from "./visualizer";

export type LibraryView = "tracks" | "albums" | "artists" | "random" | "duplicates";

/** Which library view is showing. */
export const libraryView = ref<LibraryView>("tracks");

/** The few storage methods we need, so tests can pass a fake. */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A boolean that survives restarts. Unreadable or unavailable storage falls back to `fallback`. */
export function persistedFlag(key: string, fallback: boolean, storage?: FlagStorage) {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  let initial = fallback;
  try {
    const saved = store?.getItem(key);
    if (saved === "1") initial = true;
    else if (saved === "0") initial = false;
  } catch {
    // Storage can throw (privacy modes); keep the fallback.
  }
  const flag = ref(initial);
  const set = (value: boolean) => {
    flag.value = value;
    try {
      store?.setItem(key, value ? "1" : "0");
    } catch {
      // Not being able to remember is fine.
    }
  };
  return { flag, set, toggle: () => set(!flag.value) };
}

/** Keeps a popup of `width` x `height` opened at (x, y) fully inside the window. */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): { x: number; y: number } {
  const fit = (pos: number, size: number, limit: number) =>
    Math.max(margin, Math.min(pos, limit - size - margin));
  return { x: fit(x, width, viewportWidth), y: fit(y, height, viewportHeight) };
}

/** A remembered choice among `allowed` values. Unknown or unreadable saved values fall back to `fallback`. */
export function persistedChoice<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
  storage?: FlagStorage,
) {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  let initial = fallback;
  try {
    const saved = store?.getItem(key);
    if (saved && (allowed as readonly string[]).includes(saved)) initial = saved as T;
  } catch {
    // Storage can throw; keep the fallback.
  }
  const choice = ref(initial) as import("vue").Ref<T>;
  const set = (value: T) => {
    choice.value = value;
    try {
      store?.setItem(key, value);
    } catch {
      // Not being able to remember is fine.
    }
  };
  return { choice, set };
}

/** A remembered set of strings (for example, things the user has dismissed). */
export function persistedSet(key: string, storage?: FlagStorage) {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  let initial: string[] = [];
  try {
    const parsed = JSON.parse(store?.getItem(key) ?? "[]");
    if (Array.isArray(parsed)) initial = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Missing, corrupt, or unavailable storage: start empty.
  }
  const items = ref<ReadonlySet<string>>(new Set(initial));
  const replace = (next: Set<string>) => {
    items.value = next;
    try {
      store?.setItem(key, JSON.stringify([...next]));
    } catch {
      // Not being able to remember is fine.
    }
  };
  return {
    items,
    add: (...values: string[]) => replace(new Set([...items.value, ...values])),
    remove: (value: string) => replace(new Set([...items.value].filter((v) => v !== value))),
    clear: () => replace(new Set()),
  };
}

const visualChoice = persistedChoice<VisualMode>("mixtape.visual", "dots", VISUAL_MODES);
/** Which visual the player deck draws beside the song info. */
export const visualMode = visualChoice.choice;
export const setVisualMode = visualChoice.set;

const djPanel = persistedFlag("mixtape.djPanelOpen", false);
/** Whether the DJ chat panel is slid out on the right of the large window. */
export const djPanelOpen = djPanel.flag;
export const toggleDjPanel = djPanel.toggle;

export type AppMode = "player" | "discovery" | "settings";
const appModeChoice = persistedChoice<AppMode>("mixtape.appMode", "player", ["player", "discovery", "settings"]);
/** Which workspace the large window shows: playing music, discovering and fixing it, or settings. */
export const appMode = appModeChoice.choice;
export const setAppMode = appModeChoice.set;

/** Paths of the library songs whose tags are being edited in the dialog (empty: closed). */
export const tagEditPaths = ref<string[]>([]);

/** The library filter box, shared so other parts of the app can set it ("Show in library"). */
export const libraryQuery = ref("");

/** A song to select and scroll to the next time the song list shows. */
export const revealPath = ref<string | null>(null);

/** Switches to Player mode's Tracks view filtered to the song, and selects it. */
export function showInLibrary(track: { path: string; title: string }) {
  setAppMode("player");
  libraryView.value = "tracks";
  libraryQuery.value = track.title;
  revealPath.value = track.path;
}

/** Switches to Player mode's Tracks view filtered to `query` (an artist, an album, a genre): the songs that go with it. */
export function searchLibrary(query: string) {
  setAppMode("player");
  libraryView.value = "tracks";
  libraryQuery.value = query;
}

/** The songs ticked in the Discovery inbox, by import id. Shared so the Cmd+A shortcut can fill it. */
export const inboxPicked = ref<Set<number>>(new Set());

/** Songs picked in the song list that is showing, so shortcuts and the command palette can act on them. */
export const selectedSongs = ref<Track[]>([]);
let selectionOwner: symbol | null = null;
/** A song list publishes its selection. The last list to publish owns it. */
export function publishSelection(owner: symbol, songs: Track[]) {
  selectionOwner = owner;
  selectedSongs.value = songs;
}
/** A song list going away withdraws its selection, unless another list has taken over. */
export function withdrawSelection(owner: symbol) {
  if (selectionOwner !== owner) return;
  selectionOwner = null;
  selectedSongs.value = [];
}

export const paletteOpen = ref(false);
export const helpOpen = ref(false);
