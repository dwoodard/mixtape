import { ref } from "vue";
import { tauriApi, type Api } from "./api";
import type { PlayerState, ScanProgress, Track, WindowMode } from "./types";

/** What the backend returns when a scan was cancelled. */
const SCAN_CANCELLED = "cancelled";

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
  /** When the library was last scanned (ms since epoch), or null if never. */
  const scannedAt = ref<number | null>(null);
  const scanning = ref(false);
  const scanError = ref<string | null>(null);
  const scanProgress = ref<ScanProgress | null>(null);
  /** Identifies the latest scan so a cancelled older one cannot clobber its state. */
  let scanId = 0;
  const mode = ref<WindowMode>("large");

  /** Loads current state and subscribes to updates. Returns a cleanup function. */
  async function init(): Promise<() => void> {
    const unlisten = await Promise.all([
      api.onState((state) => (player.value = state)),
      api.onQueue((tracks) => (queue.value = tracks)),
      api.onPosition((ms) => (player.value = { ...player.value, positionMs: ms })),
      api.onWindowMode((m) => (mode.value = m)),
      api.onScanProgress((p) => (scanProgress.value = p)),
    ]);
    // Subscribe first, then read the snapshot, so no update is missed in between.
    const snapshot = await api.snapshot();
    player.value = snapshot.state;
    queue.value = snapshot.queue;
    mode.value = await api.windowMode();
    configuredFolder.value = await api.musicFolder();
    // Show the saved library right away; a refresh is up to the user.
    const cached = await api.cachedLibrary();
    if (cached && library.value.length === 0) {
      library.value = cached.tracks;
      folder.value = cached.folder;
      scannedAt.value = cached.scannedAtMs;
    }
    return () => unlisten.forEach((fn) => fn());
  }

  async function scan(path: string, load: () => Promise<Track[]>) {
    const id = ++scanId;
    scanning.value = true;
    scanError.value = null;
    scanProgress.value = null;
    try {
      const tracks = await load();
      if (id !== scanId) return;
      library.value = tracks;
      folder.value = path;
      scannedAt.value = Date.now();
    } catch (e) {
      // A cancelled scan keeps the previous library and is not an error.
      if (id === scanId && String(e) !== SCAN_CANCELLED) scanError.value = String(e);
    } finally {
      if (id === scanId) {
        scanning.value = false;
        scanProgress.value = null;
      }
    }
  }

  /** Rescans the current folder. Only new or changed files are re-read. */
  async function refresh() {
    if (!folder.value) return;
    const path = folder.value;
    await scan(path, () => api.scanFolder(path));
  }

  async function cancelScan() {
    await api.cancelScan();
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
    scannedAt,
    scanning,
    scanError,
    scanProgress,
    mode,
    init,
    openFolder,
    importLibrary,
    refresh,
    cancelScan,
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
