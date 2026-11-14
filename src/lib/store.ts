import { ref } from "vue";
import { tauriApi, type Api } from "./api";
import type { PlayerState, Track, WindowMode } from "./types";

const emptyState = (): PlayerState => ({
  status: "stopped",
  currentIndex: null,
  currentTrack: null,
  positionMs: 0,
  durationMs: 0,
  volume: 1,
  error: null,
});

/** UI state plus the actions that talk to the Rust player. */
export function createStore(api: Api) {
  const player = ref<PlayerState>(emptyState());
  const queue = ref<Track[]>([]);
  const library = ref<Track[]>([]);
  const folder = ref<string | null>(null);
  /** Folder saved in config.json, or null when none is set. */
  const configuredFolder = ref<string | null>(null);
  const scanning = ref(false);
  const scanError = ref<string | null>(null);
  const mode = ref<WindowMode>("large");

  /** Loads current state and subscribes to updates. Returns a cleanup function. */
  async function init(): Promise<() => void> {
    const unlisten = await Promise.all([
      api.onState((state) => (player.value = state)),
      api.onQueue((tracks) => (queue.value = tracks)),
      api.onPosition((ms) => (player.value = { ...player.value, positionMs: ms })),
      api.onWindowMode((m) => (mode.value = m)),
    ]);
    // Subscribe first, then read the snapshot, so no update is missed in between.
    const snapshot = await api.snapshot();
    player.value = snapshot.state;
    queue.value = snapshot.queue;
    mode.value = await api.windowMode();
    configuredFolder.value = await api.musicFolder();
    return () => unlisten.forEach((fn) => fn());
  }

  async function scan(path: string, load: () => Promise<Track[]>) {
    scanning.value = true;
    scanError.value = null;
    try {
      library.value = await load();
      folder.value = path;
    } catch (e) {
      scanError.value = String(e);
    } finally {
      scanning.value = false;
    }
  }

  async function openFolder() {
    const path = await api.pickFolder();
    if (!path) return;
    await scan(path, () => api.scanFolder(path));
  }

  /** Imports the music folder saved in config.json. */
  async function importLibrary() {
    if (!configuredFolder.value) return;
    await scan(configuredFolder.value, () => api.importLibrary());
  }

  async function toggleMode() {
    mode.value = await api.toggleWindowMode();
  }

  return {
    player,
    queue,
    library,
    folder,
    configuredFolder,
    scanning,
    scanError,
    mode,
    init,
    openFolder,
    importLibrary,
    toggleMode,
    /** Replaces the queue with `tracks` and starts at `index`. */
    playTracks: (tracks: Track[], index: number) => api.playTracks(tracks, index),
    enqueue: (tracks: Track[]) => api.enqueue(tracks),
    playQueueIndex: (index: number) => api.playIndex(index),
    toggle: () => api.toggle(),
    next: () => api.next(),
    prev: () => api.prev(),
    seek: (ms: number) => api.seek(ms),
    setVolume: (v: number) => api.setVolume(v),
    removeFromQueue: (index: number) => api.removeFromQueue(index),
    clearQueue: () => api.clearQueue(),
    quit: () => api.quit(),
  };
}

export type Store = ReturnType<typeof createStore>;

export const store = createStore(tauriApi);
