import { ref } from "vue";
import { tauriApi, type Api } from "./api";
import type { PlayerState, PlaylistSummary, Repeat, ScanProgress, Track, WindowMode } from "./types";

/** What the backend returns when a scan was cancelled. */
const SCAN_CANCELLED = "cancelled";

const emptyState = (): PlayerState => ({
  status: "stopped",
  currentIndex: null,
  currentTrack: null,
  positionMs: 0,
  durationMs: 0,
  volume: 1,
  shuffle: false,
  repeat: "off",
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
  const playlists = ref<PlaylistSummary[]>([]);
  /** Why the last playlist action failed, if it did. */
  const playlistError = ref<string | null>(null);
  /** Identifies the latest scan so a cancelled older one cannot clobber its state. */
  let scanId = 0;
  /** Unknown (null) until the backend says which window mode this launch is in. */
  const mode = ref<WindowMode | null>(null);

  /**
   * Loads current state and subscribes to updates. Returns a cleanup function.
   * The window mode is read first so the right layout shows immediately, and
   * the optional loads cannot stop it from being set.
   */
  async function init(): Promise<() => void> {
    mode.value = await api.windowMode();
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
    // Nice-to-have data: a failure here is logged and must not break startup.
    await Promise.all([
      api.musicFolder().then((f) => (configuredFolder.value = f)),
      api.listPlaylists().then((p) => (playlists.value = p)),
      api.cachedLibrary().then((cached) => {
        // Show the saved library right away; a refresh is up to the user.
        if (cached && library.value.length === 0) {
          library.value = cached.tracks;
          folder.value = cached.folder;
          scannedAt.value = cached.scannedAtMs;
        }
      }),
    ].map((load) => load.catch((e) => console.error("startup load failed:", e))));
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

  async function refreshPlaylists() {
    playlists.value = await api.listPlaylists();
  }

  /** Saves the current queue under `name` (replacing a playlist of the same name). */
  async function saveQueueAsPlaylist(name: string): Promise<boolean> {
    playlistError.value = null;
    try {
      await api.savePlaylist(name, queue.value);
      await refreshPlaylists();
      return true;
    } catch (e) {
      playlistError.value = String(e);
      return false;
    }
  }

  async function deletePlaylist(id: string) {
    playlistError.value = null;
    try {
      await api.deletePlaylist(id);
      await refreshPlaylists();
    } catch (e) {
      playlistError.value = String(e);
    }
  }

  /** The tracks of a saved playlist, or an empty list (with playlistError set) if it is gone. */
  async function playlistTracks(id: string): Promise<Track[]> {
    playlistError.value = null;
    try {
      return await api.loadPlaylist(id);
    } catch (e) {
      playlistError.value = String(e);
      await refreshPlaylists();
      return [];
    }
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
    playlists,
    playlistError,
    scanning,
    scanError,
    scanProgress,
    mode,
    init,
    openFolder,
    importLibrary,
    refresh,
    refreshPlaylists,
    saveQueueAsPlaylist,
    deletePlaylist,
    playlistTracks,
    cancelScan,
    toggleMode,
    /** Replaces the queue with `tracks` and starts at `index`. */
    playTracks: (tracks: Track[], index: number) => api.playTracks(tracks, index),
    enqueue: (tracks: Track[]) => api.enqueue(tracks),
    enqueueNext: (tracks: Track[]) => api.enqueueNext(tracks),
    stop: () => api.stop(),
    toggleShuffle: () => api.setShuffle(!player.value.shuffle),
    /** off -> all -> one -> off */
    cycleRepeat: () => {
      const order: Repeat[] = ["off", "all", "one"];
      const next = order[(order.indexOf(player.value.repeat) + 1) % order.length];
      return api.setRepeat(next);
    },
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
