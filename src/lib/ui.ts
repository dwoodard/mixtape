import { ref } from "vue";

export type LibraryView = "tracks" | "albums" | "artists" | "playlists";

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
