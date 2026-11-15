import { computed, ref } from "vue";
import { tauriApi, type Api } from "./api";
import { refreshCovers } from "./cover";
import type { TagEditPayload } from "./tagEdit";
import { changedTracks, queueReplacements } from "./changes";
import { DJ_PANEL_HEIGHT, DJ_PANEL_MIN_WIDTH, panelWantedHeight } from "./thinBar";
import { applyFolderRefresh, inScanOrder, insertSorted } from "./librarySort";
import { dirName } from "./format";
import { scopeFor, scopeForDirs } from "./refreshScope";
import { createImports } from "./imports";
import { findDuplicates, newDuplicateGroups, withoutIgnored } from "./duplicates";
import { persistedSet, type FlagStorage } from "./ui";
import type { CleanupReport, MoveSongsResult, DuplicatePair, FileCheck, PlayerState, PlayStat, TagWriteResult, Repeat, ScanProgress, Track, WindowMode } from "./types";

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
  /** How often each song has been played, by file path. Songs never played are not in it. */
  const plays = ref<Record<string, PlayStat>>({});
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

  /** The latest change to a song in the library, for a notice with a "Show" button. */
  const lastChange = ref<{ message: string; track: Track } | null>(null);

  /** Folders of songs sent to Picard, with when: re-checked when the user comes back to the app. */
  const picardFolders = ref<Record<string, number>>({});
  /** How long after sending a song to Picard its folder is still re-checked. */
  const PICARD_WINDOW_MS = 30 * 60 * 1000;

  /** What the last tag write did, per file, for the editor to show. */
  const tagResults = ref<TagWriteResult[] | null>(null);
  const writingTags = ref(false);
  /** Songs found to have no cover picture, and which songs have been checked so far (checking reads every file's tags). */
  const coverless = ref<Set<string>>(new Set());
  const coverChecked = new Set<string>();
  const checkingCovers = ref(false);
  /** True while a duplicate clean-up is running (it must not be started twice). */
  const cleaningUp = ref(false);

  /** What the last "move extra copies to Trash" did, for the Duplicates tab to show. */
  const cleanupReport = ref<CleanupReport | null>(null);
  const scanProgress = ref<ScanProgress | null>(null);
  /** The thin bar's queue panel: closed, or open on a side at a height (from the window). Not saved. */
  const thinPanel = ref<{ side: "down" | "up"; height: number } | null>(null);
  const thinPanelOpen = computed(() => thinPanel.value !== null);
  /** What the open panel shows: the queue, or the DJ chat. */
  const thinPanelView = ref<"queue" | "dj">("queue");
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
      api.onWindowMode((m) => {
        mode.value = m;
        // The window closes the panel itself when the mode changes.
        thinPanel.value = null;
      }),
      api.onScanProgress((p) => (scanProgress.value = p)),
      api.onScanTracks(receiveScanned),
      api.onPlayed(({ path, count, lastPlayedMs }) => (plays.value = { ...plays.value, [path]: { count, lastPlayedMs } })),
    ]);
    // Subscribe first, then read the snapshot, so no update is missed in between.
    const snapshot = await api.snapshot();
    player.value = snapshot.state;
    queue.value = snapshot.queue;
    // Nice-to-have data: a failure here is logged and must not break startup.
    await Promise.all([
      api.musicFolder().then((f) => (configuredFolder.value = f)),
      api.playStats().then((stats) => (plays.value = { ...stats, ...plays.value })),
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

  /** While a scan of another folder runs: the songs it has read so far, shown in the list as they arrive. */
  let streamed: Track[] | null = null;
  let streamedWaiting: Track[] = [];
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let scanBefore: { library: Track[]; folder: string | null } | null = null;
  /** How often the list catches up with what the scan has read (sorting a big list on every batch would stall). */
  const STREAM_EVERY_MS = 200;

  function showStreamed() {
    streamTimer = null;
    if (!streamed) return;
    streamed = inScanOrder([...streamed, ...streamedWaiting]);
    streamedWaiting = [];
    library.value = streamed;
  }

  function receiveScanned(tracks: Track[]) {
    if (!streamed) return;
    streamedWaiting.push(...tracks);
    streamTimer ??= setTimeout(showStreamed, STREAM_EVERY_MS);
  }

  function stopStreaming() {
    if (streamTimer) clearTimeout(streamTimer);
    streamTimer = null;
    streamed = null;
    streamedWaiting = [];
  }

  async function scan(path: string, load: () => Promise<Track[]>) {
    const id = ++scanId;
    // What to put back if this scan ends without a result. A scan that replaces a running one inherits its "before".
    const before = scanning.value && scanBefore ? scanBefore : { library: library.value, folder: folder.value };
    scanBefore = before;
    scanning.value = true;
    scanError.value = null;
    scanProgress.value = null;
    // A rescan of the folder on screen keeps its list until the new one is ready. Another folder,
    // or an empty list, fills in as the songs are read.
    stopStreaming();
    if (path !== folder.value || library.value.length === 0) {
      streamed = [];
      library.value = [];
      folder.value = path;
    }
    try {
      const tracks = await load();
      if (id !== scanId) return;
      stopStreaming();
      library.value = tracks;
      folder.value = path;
      scannedAt.value = Date.now();
      announceDuplicates();
    } catch (e) {
      // A cancelled or failed scan puts the previous library back; only a failure is an error.
      if (id === scanId) {
        stopStreaming();
        library.value = before.library;
        folder.value = before.folder;
        if (String(e) !== SCAN_CANCELLED) scanError.value = String(e);
      }
    } finally {
      if (id === scanId) {
        scanning.value = false;
        scanBefore = null;
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

  /**
   * Plays one song when nothing is playing. An empty queue becomes just that song;
   * otherwise the song goes on the end of the queue and starts, and the queue stays.
   */
  async function playSong(track: Track) {
    const at = queue.value.length;
    if (at === 0) return api.playTracks([track], 0);
    await api.enqueue([track]);
    return api.playIndex(at);
  }

  /**
   * Starts one song now. While one is loaded it goes right after the current song, which stays directly
   * above it in the queue, and the rest of the queue is untouched.
   */
  async function playNow(track: Track) {
    // With nothing loaded there is no current song to go after.
    if (player.value.status === "stopped") return playSong(track);
    const current = player.value.currentIndex;
    const at = current === null ? queue.value.length : current + 1;
    await api.enqueueNext([track]);
    return api.playIndex(at);
  }

  /**
   * Takes every other song out of the queue and keeps the one at `index`. The songs below go in one step, then the
   * ones above from the bottom up so each removal leaves the next index where it was. If a different song was playing,
   * it goes too, and the queue carries on with the one that is left.
   */
  async function clearOtherQueueSongs(index: number) {
    const total = queue.value.length;
    if (index < 0 || index >= total || total < 2) return;
    if (index < total - 1) await api.removeFromQueueDown(index + 1);
    for (let i = index - 1; i >= 0; i--) await api.removeFromQueue(i);
  }

  /**
   * Opens the thin bar's panel on `view`, or closes it if that view is already showing. The other view needs another
   * height, so switching closes the panel and opens it again at the right size. The chat needs room to be usable, so a
   * bar narrower than that is widened first (`barWidth` is how wide it is now).
   */
  async function toggleThinView(view: "queue" | "dj", barWidth?: number) {
    if (thinPanel.value && thinPanelView.value === view) return closeThinPanel();
    if (thinPanel.value) await closeThinPanel();
    if (view === "dj" && barWidth !== undefined && barWidth < DJ_PANEL_MIN_WIDTH) await api.resizeThin(DJ_PANEL_MIN_WIDTH);
    thinPanelView.value = view;
    thinPanel.value = await api.openThinPanel(view === "dj" ? DJ_PANEL_HEIGHT : panelWantedHeight(queue.value.length));
  }

  /** Opens the thin bar's queue panel (the window grows to fit it), or closes it if it is open. */
  const toggleThinPanel = () => toggleThinView("queue");

  async function closeThinPanel() {
    if (!thinPanel.value) return;
    thinPanel.value = null;
    await api.closeThinPanel();
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

  /** Compares a song's file with the length the library holds for it. */
  const inspectFile = (track: Track): Promise<FileCheck> => api.inspectFile(track.path, track.durationMs);

  /** Corrects a song's length in the library and the queue (never the file). Returns what went wrong, if anything. */
  async function fixLength(track: Track, lengthMs: number): Promise<string | null> {
    let fresh: Track;
    try {
      fresh = await api.fixLength(track.path, lengthMs);
    } catch (e) {
      return String(e);
    }
    library.value = library.value.map((t) => (t.path === fresh.path ? fresh : t));
    noteChange(`Length corrected: ${fresh.title}`, fresh);
    // The queue's own copy has the old length too, and that is what the seek bar and the total use. (Only tags are
    // compared when the queue follows the library, so a length alone does not trigger that.)
    if (queue.value.some((t) => t.path === fresh.path)) {
      try {
        await api.replaceQueueTracks([{ oldPath: fresh.path, track: fresh }]);
      } catch (e) {
        console.error("could not update the queue:", e);
      }
    }
    return null;
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
    if (cleaningUp.value) return;
    libraryError.value = null;
    cleanupReport.value = null;
    cleaningUp.value = true;
    let report: CleanupReport;
    try {
      report = await api.trashDuplicates(pairs);
    } catch (e) {
      libraryError.value = String(e);
      return;
    } finally {
      cleaningUp.value = false;
    }
    cleanupReport.value = report;
    const gone = [...report.trashed, ...report.held.map((h) => h.path), ...report.missing];
    if (gone.length === 0) return;
    await removeFromLibrary(gone.map((path) => ({ path })));
    const goneSet = new Set(gone);
    // Highest index first so earlier removals do not shift the later ones.
    const indexes = queue.value.flatMap((t, i) => (goneSet.has(t.path) ? [i] : [])).reverse();
    for (const i of indexes) await api.removeFromQueue(i);
  }

  /**
   * Moves song files into other folders of the library. The songs that moved are swapped for the copies read at their
   * new place, in the list and in the queue (a song that is playing keeps playing). The rest stay and are reported.
   */
  async function moveSongs(moves: { path: string; folder: string }[]) {
    if (moves.length === 0) return { moved: 0, failed: [] as { path: string; error: string }[] };
    libraryError.value = null;
    let result: MoveSongsResult;
    try {
      result = await api.moveSongs(moves);
    } catch (e) {
      libraryError.value = String(e);
      return { moved: 0, failed: moves.map((m) => ({ path: m.path, error: String(e) })) };
    }
    if (result.moved.length > 0) {
      const gone = new Set(result.moved.map((m) => m.from));
      library.value = result.moved.reduce((list, m) => insertSorted(list, m.track), library.value.filter((t) => !gone.has(t.path)));
      const replacements = queue.value.flatMap((q) => {
        const hit = result.moved.find((m) => m.from === q.path);
        return hit ? [{ oldPath: q.path, track: hit.track }] : [];
      });
      if (replacements.length > 0) await api.replaceQueueTracks(replacements).catch((e) => console.error("could not update the queue:", e));
      const first = result.moved[0].track;
      noteChange(result.moved.length === 1 ? `Moved: ${first.title}` : `Moved ${result.moved.length} songs`, first);
    }
    return { moved: result.moved.length, failed: result.failed };
  }

  /**
   * Writes tag edits to the files of `tracks`. Each file succeeds or fails on
   * its own; the ones that succeeded are updated in the library with what was
   * re-read from disk. The per-file outcome is kept in `tagResults`.
   */
  async function writeTags(tracks: Pick<Track, "path">[], edit: TagEditPayload) {
    if (tracks.length === 0 || Object.keys(edit).length === 0) return;
    writingTags.value = true;
    tagResults.value = null;
    libraryError.value = null;
    try {
      const results = await api.writeTags(tracks.map((t) => t.path), edit);
      tagResults.value = results;
      const fresh = new Map(results.flatMap((r) => (r.track ? [[r.path, r.track] as const] : [])));
      if (fresh.size > 0) {
        if (edit.coverUrl) {
          refreshCovers([...fresh.keys()]);
          coverless.value = new Set([...coverless.value].filter((p) => !fresh.has(p)));
        }
        library.value = library.value.map((t) => fresh.get(t.path) ?? t);
        const first = [...fresh.values()][0];
        noteChange(fresh.size === 1 ? `Saved tags: ${first.title}` : `Saved tags for ${fresh.size} songs`, first);
        void reconcileQueue([...fresh.values()]);
      }
    } catch (e) {
      libraryError.value = String(e);
    } finally {
      writingTags.value = false;
    }
  }

  /** Checks the songs not checked yet for cover pictures. Songs added later are picked up by the next call. */
  async function checkCovers() {
    if (checkingCovers.value) return;
    const todo = library.value.map((t) => t.path).filter((p) => !coverChecked.has(p));
    if (todo.length === 0) return;
    checkingCovers.value = true;
    try {
      const missing = await api.missingCovers(todo);
      for (const p of todo) coverChecked.add(p);
      coverless.value = new Set([...coverless.value, ...missing]);
    } catch (e) {
      libraryError.value = String(e);
    } finally {
      checkingCovers.value = false;
    }
  }

  /** The songs of `tracks` that have no cover picture, checking them first. */
  async function withoutCover(tracks: Track[]): Promise<Track[]> {
    const wanted = tracks.filter((t) => !coverChecked.has(t.path)).map((t) => t.path);
    if (wanted.length > 0) {
      const missing = await api.missingCovers(wanted);
      for (const p of wanted) coverChecked.add(p);
      coverless.value = new Set([...coverless.value, ...missing]);
    }
    return tracks.filter((t) => coverless.value.has(t.path));
  }

  /**
   * Makes the play queue follow songs that were just added or retagged: entries
   * for them get the fresh tags, and entries for a file that is gone (undone,
   * renamed, re-added elsewhere) are pointed at the same recording. What is
   * playing keeps playing.
   */
  async function reconcileQueue(changed: Track[]) {
    const replacements = queueReplacements(queue.value, library.value, changed);
    if (replacements.length === 0) return;
    try {
      await api.replaceQueueTracks(replacements);
    } catch (e) {
      console.error("could not update the queue:", e);
    }
  }

  function noteChange(message: string, track: Track) {
    lastChange.value = { message, track };
  }

  /** A song that was just added to the library on disk (by an import): shows it in scan order. */
  function addToLibrary(track: Track) {
    library.value = insertSorted(library.value, track);
    noteChange(`Added: ${track.artist ? `${track.artist} – ` : ""}${track.title}`, track);
    void reconcileQueue([track]);
    // What is next to it in its folder may not match the saved library (a copy, a file Picard renamed): look at that folder.
    refreshAround([track.path], { widen: false });
  }

  /** A song whose file was removed (an undone import): drops it from the list. */
  function dropFromLibrary(path: string) {
    library.value = library.value.filter((t) => t.path !== path);
  }

  /**
   * Sends library songs to MusicBrainz Picard. Picard saves tags in place and
   * may rename the files, so their folders are re-checked each time the user
   * returns to the app (see refreshPicardFolders).
   */
  async function openInPicard(tracks: Pick<Track, "path">[]) {
    if (tracks.length === 0) return;
    libraryError.value = null;
    try {
      await api.picardOpenFiles(tracks.map((t) => t.path));
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    const now = Date.now();
    const next = { ...picardFolders.value };
    for (const t of tracks) next[dirName(t.path)] = now;
    picardFolders.value = next;
  }

  /**
   * Re-checks just these folders of the library (never the whole of it) and updates the list with what changed there:
   * songs that are new, renamed or gone. Cheap: only changed files are re-read. The words for the change come from `say`.
   */
  async function refreshDirs(dirs: string[], say: (changed: Track[]) => string) {
    if (dirs.length === 0) return;
    try {
      const results = await api.refreshFolders(dirs);
      const before = library.value;
      library.value = applyFolderRefresh(before, results);
      const changed = changedTracks(before, library.value);
      if (changed.length > 0) {
        noteChange(say(changed), changed[0]);
        void reconcileQueue(changed);
      }
      // A copy found next to the original is worth saying so, as it is after a full scan.
      announceDuplicates();
    } catch (e) {
      libraryError.value = String(e);
    }
  }

  /** Songs touched since the last targeted refresh, waiting a moment so adding many songs checks each folder once. */
  let pendingRefresh: { paths: Set<string>; widen: boolean } | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const REFRESH_DELAY_MS = 1200;

  /**
   * Re-checks the folders around these songs: just the album folder, or with `widen` the artist folder (for when
   * something may have renamed or moved them). Batched, so a bulk add refreshes each folder once.
   */
  function refreshAround(paths: string[], { widen }: { widen: boolean }) {
    pendingRefresh ??= { paths: new Set(), widen: false };
    for (const p of paths) pendingRefresh.paths.add(p);
    pendingRefresh.widen ||= widen;
    refreshTimer ??= setTimeout(() => {
      const job = pendingRefresh;
      pendingRefresh = null;
      refreshTimer = null;
      if (!job) return;
      const dirs = scopeFor(folder.value, [...job.paths], job.widen);
      void refreshDirs(dirs, (changed) => (changed.length === 1 ? `Updated from disk: ${changed[0].title}` : `Updated ${changed.length} songs from disk`));
    }, REFRESH_DELAY_MS);
  }

  /**
   * Re-checks the folders of songs sent to Picard and updates the library with what changed there. Picard saves tags in
   * place and may rename the files, and a rename can move a song to another album folder, so the artist folders are
   * checked, not just the albums. Forgets folders that were sent long ago.
   */
  async function refreshPicardFolders(now = Date.now()) {
    const fresh = Object.entries(picardFolders.value).filter(([, at]) => now - at <= PICARD_WINDOW_MS);
    picardFolders.value = Object.fromEntries(fresh);
    if (fresh.length === 0) return;
    await refreshDirs(scopeForDirs(folder.value, fresh.map(([dir]) => dir), true), (changed) =>
      changed.length === 1 ? `Updated from Picard: ${changed[0].title}` : `Updated ${changed.length} songs from Picard`,
    );
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

  /** Opens a web page in the browser (only the few sites the app allows). */
  async function openLink(url: string) {
    libraryError.value = null;
    try {
      await api.openLink(url);
    } catch (e) {
      libraryError.value = String(e);
    }
  }

  /** Opens a folder in Finder. */
  async function openInFinder(path: string) {
    libraryError.value = null;
    try {
      await api.openInFinder(path);
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

  /** The removed songs with whether each file is gone, or an empty list on failure. */
  async function loadRemovedSongs() {
    try {
      return await api.removedSongs();
    } catch (e) {
      libraryError.value = String(e);
      return [];
    }
  }

  /** Brings just these removed songs back and rescans so they show up. */
  async function restoreRemovedSongs(paths: string[]) {
    if (paths.length === 0) return;
    libraryError.value = null;
    try {
      await api.restoreRemovedPaths(paths);
    } catch (e) {
      libraryError.value = String(e);
      return;
    }
    removedCount.value = await api.removedCount();
    await refresh();
  }

  /**
   * Moves removed songs' files to the Trash, or to a holding folder on a drive with no Trash, and forgets them
   * (a file already gone is just forgotten). Carries on past a failure, shows the last error, and says how many
   * worked and where files that skipped the Trash went.
   */
  async function deleteRemovedSongs(paths: string[]): Promise<{ deleted: number; failed: number; held: string[] }> {
    libraryError.value = null;
    let deleted = 0;
    let failed = 0;
    const held: string[] = [];
    for (const path of paths) {
      try {
        const movedTo = await api.deleteRemovedSong(path);
        if (movedTo) held.push(movedTo);
        deleted++;
      } catch (e) {
        libraryError.value = String(e);
        failed++;
      }
    }
    removedCount.value = await api.removedCount();
    return { deleted, failed, held };
  }

  /** Forgets removals whose files are gone from disk. Returns how many, or null on failure. */
  async function pruneRemoved(): Promise<number | null> {
    libraryError.value = null;
    try {
      const dropped = await api.pruneRemoved();
      removedCount.value = await api.removedCount();
      return dropped;
    } catch (e) {
      libraryError.value = String(e);
      return null;
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
    plays,
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
    scanning,
    scanError,
    scanProgress,
    mode,
    init,
    openFolder,
    importLibrary,
    refresh,
    removeFromLibrary,
    inspectFile,
    fixLength,
    addToLibrary,
    dropFromLibrary,
    writeTags,
    tagResults,
    writingTags,
    coverless,
    checkingCovers,
    checkCovers,
    withoutCover,
    trashDuplicates,
    moveSongs,
    cleanupReport,
    cleaningUp,
    removeUnplayable,
    dismissError: () => api.dismissError(),
    revealInFinder,
    openInFinder,
    openLink,
    lastChange,
    dismissChange: () => (lastChange.value = null),
    openInPicard,
    refreshPicardFolders,
    refreshAround,
    picardFolders,
    restoreRemoved,
    pruneRemoved,
    loadRemovedSongs,
    deleteRemovedSongs,
    restoreRemovedSongs,
    cancelScan,
    toggleMode,
    /** Replaces the queue with `tracks` and starts at `index`. */
    playTracks: (tracks: Track[], index: number) => api.playTracks(tracks, index),
    playSong,
    playNow,
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
    /** Removes a queue row and every row below it (the play order). Stops playback if the playing song goes. */
    removeFromQueueDown: (index: number) => api.removeFromQueueDown(index),
    /** Moves a queue entry so it ends up at `to`. */
    moveQueueTrack: (from: number, to: number) => api.moveQueueTrack(from, to),
    clearQueue: () => api.clearQueue(),
    clearOtherQueueSongs,
    quit: () => api.quit(),
    resizeThin: (width: number) => api.resizeThin(width),
    /** The thin bar's drop-down queue panel. */
    thinPanel,
    thinPanelOpen,
    thinPanelView,
    toggleThinView,
    toggleThinPanel,
    closeThinPanel,
  };
}

export type Store = ReturnType<typeof createStore>;

export const store = createStore(tauriApi);

export const imports = createImports(tauriApi, {
  library: () => store.library.value,
  onAdded: store.addToLibrary,
  onRemoved: store.dropFromLibrary,
});
