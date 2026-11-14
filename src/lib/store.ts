import { computed, ref } from "vue";
import { tauriApi, type Api } from "./api";
import { findDuplicates, newDuplicateGroups, withoutIgnored } from "./duplicates";
import { persistedSet, type FlagStorage } from "./ui";
import type { CleanupReport, DuplicatePair, PlayerState, PlaylistSummary, Repeat, ScanProgress, Track, WindowMode } from "./types";

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
  errorPath: null,
});

/** UI state plus the actions that talk to the Rust player. */
export function createStore(api: Api, storage?: FlagStorage) {
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
  /** Songs hidden from the library by the user (their files are untouched). */
  const removedCount = ref(0);
  const libraryError = ref<string | null>(null);
  /** Duplicate groups the user marked "Not a duplicate", and ones already announced. */
  const ignoredDuplicates = persistedSet("mixtape.ignoredDuplicates", storage);
  const seenDuplicates = persistedSet("mixtape.seenDuplicates", storage);
  /** How many new duplicate songs the last scan found (0 when nothing to announce). */
  const duplicateNotice = ref(0);
  /** Songs in the library more than once, minus the ones the user dismissed. */
  const duplicateGroups = computed(() =>
    withoutIgnored(findDuplicates(library.value), ignoredDuplicates.items.value),
  );

  /** What the last "move extra copies to Trash" did, for the Duplicates tab to show. */
  const cleanupReport = ref<CleanupReport | null>(null);
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
      api.removedCount().then((n) => (removedCount.value = n)),
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

  /** After a scan: tell the user about duplicates they have not seen yet, once. */
  function announceDuplicates() {
    const fresh = newDuplicateGroups(
      findDuplicates(library.value),
      seenDuplicates.items.value,
      ignoredDuplicates.items.value,
    );
    if (fresh.length === 0) return;
    duplicateNotice.value = fresh.length;
    seenDuplicates.add(...fresh.map((g) => g.key));
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
      announceDuplicates();
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

  /** Takes songs out of the library. Their files stay on disk and are not re-added by a refresh. */
  async function removeFromLibrary(tracks: Pick<Track, "path">[]) {
    if (tracks.length === 0) return;
    libraryError.value = null;
    try {
      await api.removeFromLibrary(tracks.map((t) => t.path));
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    const gone = new Set(tracks.map((t) => t.path));
    library.value = library.value.filter((t) => !gone.has(t.path));
    removedCount.value = await api.removedCount();
  }

  /**
   * Fixes a song that cannot be played because its file is gone: takes it out
   * of the library and the queue. (A refresh instead would re-add it if the
   * file turns up somewhere else.)
   */
  async function removeUnplayable(path: string) {
    libraryError.value = null;
    try {
      await api.removeFromLibrary([path]);
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    library.value = library.value.filter((t) => t.path !== path);
    removedCount.value = await api.removedCount();
    // Highest index first so earlier removals do not shift the later ones.
    const indexes = queue.value.flatMap((t, i) => (t.path === path ? [i] : [])).reverse();
    for (const i of indexes) await api.removeFromQueue(i);
    await api.dismissError();
  }

  /**
   * Moves duplicate extras to the Trash, or to a holding folder on drives
   * without one (the backend checks each first), then takes whatever was
   * moved or already gone out of the library and
   * the queue. Anything left alone stays in the library and is reported.
   */
  async function trashDuplicates(pairs: DuplicatePair[]) {
    if (pairs.length === 0) return;
    libraryError.value = null;
    cleanupReport.value = null;
    let report: CleanupReport;
    try {
      report = await api.trashDuplicates(pairs);
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    cleanupReport.value = report;
    const gone = [...report.trashed, ...report.held, ...report.missing];
    if (gone.length === 0) return;
    await removeFromLibrary(gone.map((path) => ({ path })));
    const goneSet = new Set(gone);
    // Highest index first so earlier removals do not shift the later ones.
    const indexes = queue.value.flatMap((t, i) => (goneSet.has(t.path) ? [i] : [])).reverse();
    for (const i of indexes) await api.removeFromQueue(i);
  }

  /** Shows the songs' files in Finder. */
  async function revealInFinder(tracks: Pick<Track, "path">[]) {
    if (tracks.length === 0) return;
    libraryError.value = null;
    try {
      await api.revealInFinder(tracks.map((t) => t.path));
    } catch (e) {
      libraryError.value = String(e);
    }
  }

  /** Forgets every removal and rescans so those songs come back. */
  async function restoreRemoved() {
    libraryError.value = null;
    try {
      await api.restoreRemoved();
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    removedCount.value = 0;
    await refresh();
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
    removedCount,
    libraryError,
    duplicateGroups,
    duplicateNotice,
    ignoredDuplicates: ignoredDuplicates.items,
    ignoreDuplicate: (key: string) => ignoredDuplicates.add(key),
    resetIgnoredDuplicates: () => ignoredDuplicates.clear(),
    dismissDuplicateNotice: () => (duplicateNotice.value = 0),
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
    removeFromLibrary,
    trashDuplicates,
    cleanupReport,
    removeUnplayable,
    dismissError: () => api.dismissError(),
    revealInFinder,
    restoreRemoved,
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
