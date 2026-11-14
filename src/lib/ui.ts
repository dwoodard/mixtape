import { ref } from "vue";

export type LibraryView = "tracks" | "albums" | "artists" | "playlists" | "duplicates";

/** Which library view is showing. Shared so the queue panel's "Load" can open playlists. */
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
