import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { QueueReplacement } from "./changes";
import type { TagEditPayload } from "./tagEdit";
import type { SpectrumFrame } from "./visualizer";
import type { FolderRefresh, ImportEvent, ImportItem, TagsPatch, ToolStatus } from "./types";
import type { CachedLibrary, CleanupReport, DuplicatePair, FileCheck, MoveSongsResult, PlayerSnapshot, PlayStat, PlayerState, Repeat, ScanProgress, TagWriteResult, Track, WindowMode } from "./types";

type Unlisten = () => void;

/** What the file picker offers. Formats the player cannot read directly are converted to mp3 on the way in. */
export const AUDIO_FILE_EXTENSIONS = [
  "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wma", "ape", "wv", "mka", "amr",
  "webm", "mkv", "mp4", "m4v", "mov", "avi", "3gp",
];

/** Everything the UI needs from the Rust side. Faked in tests. */
export interface Api {
  snapshot(): Promise<PlayerSnapshot>;
  /** How often each song has been played, by file path. */
  playStats(): Promise<Record<string, PlayStat>>;
  windowMode(): Promise<WindowMode>;
  pickFolder(): Promise<string | null>;
  scanFolder(path: string): Promise<Track[]>;
  musicFolder(): Promise<string | null>;
  importLibrary(): Promise<Track[]>;
  cancelScan(): Promise<void>;
  cachedLibrary(): Promise<CachedLibrary | null>;
  removeFromLibrary(paths: string[]): Promise<void>;
  /** Compares a song's file with the length the library holds for it. */
  /** The lyrics saved in a song's tags, or null when it has none. */
  readLyrics(path: string): Promise<string | null>;
  inspectFile(path: string, storedMs: number): Promise<FileCheck>;
  /** Corrects the length the library holds for a song (the file itself is untouched). Returns the updated song. */
  fixLength(path: string, lengthMs: number): Promise<Track>;
  revealInFinder(paths: string[]): Promise<void>;
  /** Opens a link in the browser. Only musicbrainz.org and lrclib.net are allowed. */
  openLink(url: string): Promise<void>;
  trashDuplicates(pairs: DuplicatePair[]): Promise<CleanupReport>;
  /** Moves song files into other library folders. Each song succeeds or fails on its own. */
  moveSongs(moves: { path: string; folder: string }[]): Promise<MoveSongsResult>;
  writeTags(paths: string[], edit: TagEditPayload): Promise<TagWriteResult[]>;
  /** Lets the person pick a picture file; its path, or null when they cancel. */
  pickImage(): Promise<string | null>;
  /** Which of these songs have no cover picture, in their tags or in their folder. */
  missingCovers(paths: string[]): Promise<string[]>;
  importTools(): Promise<ToolStatus>;
  picardOpenFiles(paths: string[]): Promise<void>;
  refreshFolders(dirs: string[]): Promise<FolderRefresh[]>;
  importList(): Promise<ImportItem[]>;
  importAddLink(text: string, format: string): Promise<void>;
  /** Asks for audio (or video) files on disk. Empty when the dialog is cancelled. */
  pickAudioFiles(): Promise<string[]>;
  /** Adds picked files to the import list. Returns how many were new. */
  importAddFiles(paths: string[]): Promise<number>;
  importSetTags(id: number, patch: TagsPatch): Promise<ImportItem>;
  /** Adds a ready song to the library. `allowCopy` keeps a second copy when the same song is already at that place. */
  importAdd(id: number, allowCopy?: boolean): Promise<Track>;
  importOpenInPicard(id: number): Promise<void>;
  /** Shows an imported song's file in Finder: the library copy once added, the fetched copy while it waits for review. */
  importReveal(id: number): Promise<void>;
  /** Stops songs that are still loading and takes them out of the list: these ids, or all of them when null. Returns how many. */
  importStop(ids: number[] | null): Promise<number>;
  /** Starts fetching songs held back from a playlist: these ids, or all of them when null. Returns how many. */
  importFetch(ids: number[] | null): Promise<number>;
  importCancelPicard(id: number): Promise<void>;
  importUndo(id: number): Promise<string>;
  importRemove(id: number): Promise<void>;
  onImportEvent(cb: (event: ImportEvent) => void): Promise<Unlisten>;
  removedCount(): Promise<number>;
  restoreRemoved(): Promise<void>;
  playTracks(tracks: Track[], start: number): Promise<void>;
  enqueue(tracks: Track[]): Promise<void>;
  enqueueNext(tracks: Track[]): Promise<void>;
  replaceQueueTracks(replacements: QueueReplacement[]): Promise<void>;
  moveQueueTrack(from: number, to: number): Promise<void>;
  stop(): Promise<void>;
  dismissError(): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(repeat: Repeat): Promise<void>;
  playIndex(index: number): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  removeFromQueue(index: number): Promise<void>;
  /** Removes the queue row at `index` and every row below it. */
  removeFromQueueDown(index: number): Promise<void>;
  clearQueue(): Promise<void>;
  toggleWindowMode(): Promise<WindowMode>;
  /** Sets the thin bar's width in logical pixels. The height never changes. */
  resizeThin(width: number): Promise<void>;
  /** Opens the thin bar's queue panel. `wanted` is the height that shows the whole queue. Null if it could not open. */
  openThinPanel(wanted: number): Promise<{ side: "down" | "up"; height: number } | null>;
  closeThinPanel(): Promise<void>;
  quit(): Promise<void>;
  onState(cb: (state: PlayerState) => void): Promise<Unlisten>;
  onQueue(cb: (queue: Track[]) => void): Promise<Unlisten>;
  onPosition(cb: (positionMs: number) => void): Promise<Unlisten>;
  onWindowMode(cb: (mode: WindowMode) => void): Promise<Unlisten>;
  /** Live spectrum of the playing song, about 30 times a second while it plays. */
  onSpectrum(cb: (frame: SpectrumFrame) => void): Promise<Unlisten>;
  onScanProgress(cb: (progress: ScanProgress) => void): Promise<Unlisten>;
  /** Songs the running scan has read so far, in batches and in no particular order. */
  onScanTracks(cb: (tracks: Track[]) => void): Promise<Unlisten>;
  /** A song has been listened to long enough to count as played. */
  onPlayed(cb: (played: { path: string } & PlayStat) => void): Promise<Unlisten>;
}

export const tauriApi: Api = {
  snapshot: () => invoke("player_snapshot"),
  playStats: () => invoke("play_stats"),
  windowMode: () => invoke("window_mode"),
  pickFolder: async () => {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  scanFolder: (path) => invoke("scan_folder", { path }),
  musicFolder: () => invoke("music_folder"),
  importLibrary: () => invoke("import_library"),
  cancelScan: () => invoke("cancel_scan"),
  cachedLibrary: () => invoke("cached_library"),
  removeFromLibrary: (paths) => invoke("remove_from_library", { paths }),
  readLyrics: (path) => invoke("read_lyrics", { path }),
  inspectFile: (path, storedMs) => invoke("inspect_file", { path, storedMs }),
  fixLength: (path, lengthMs) => invoke("fix_length", { path, lengthMs }),
  revealInFinder: (paths) => invoke("reveal_in_finder", { paths }),
  openLink: (url) => invoke("open_link", { url }),
  trashDuplicates: (pairs) => invoke("trash_duplicates", { pairs }),
  moveSongs: (moves) => invoke("move_songs", { moves }),
  writeTags: (paths, edit) => invoke("write_tags", { paths, edit }),
  pickImage: async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "webp"] }] });
    return typeof picked === "string" ? picked : null;
  },
  missingCovers: (paths) => invoke("missing_covers", { paths }),
  importTools: () => invoke("import_tools"),
  picardOpenFiles: (paths) => invoke("picard_open_files", { paths }),
  refreshFolders: (dirs) => invoke("refresh_folders", { dirs }),
  importList: () => invoke("import_list"),
  importAddLink: (text, format) => invoke("import_add_link", { text, format }),
  pickAudioFiles: async () => {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [
        { name: "Audio and video files", extensions: AUDIO_FILE_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  },
  importAddFiles: (paths) => invoke("import_add_files", { paths }),
  importSetTags: (id, patch) => invoke("import_set_tags", { id, patch }),
  importAdd: (id, allowCopy) => invoke("import_add", { id, allowCopy }),
  importOpenInPicard: (id) => invoke("import_open_in_picard", { id }),
  importReveal: (id) => invoke("import_reveal", { id }),
  importStop: (ids) => invoke("import_stop", { ids }),
  importFetch: (ids) => invoke("import_fetch", { ids }),
  importCancelPicard: (id) => invoke("import_cancel_picard", { id }),
  importUndo: (id) => invoke("import_undo", { id }),
  importRemove: (id) => invoke("import_remove", { id }),
  onImportEvent: (cb) => listen<ImportEvent>("import-event", (e) => cb(e.payload)),
  removedCount: () => invoke("removed_count"),
  restoreRemoved: () => invoke("restore_removed"),
  playTracks: (tracks, start) => invoke("play_tracks", { tracks, start }),
  enqueue: (tracks) => invoke("enqueue", { tracks }),
  enqueueNext: (tracks) => invoke("enqueue_next", { tracks }),
  replaceQueueTracks: (replacements) => invoke("replace_queue_tracks", { replacements }),
  moveQueueTrack: (from, to) => invoke("move_queue_track", { from, to }),
  stop: () => invoke("stop_playback"),
  dismissError: () => invoke("dismiss_error"),
  setShuffle: (on) => invoke("set_shuffle", { on }),
  setRepeat: (repeat) => invoke("set_repeat", { repeat }),
  playIndex: (index) => invoke("play_index", { index }),
  toggle: () => invoke("toggle_playback"),
  next: () => invoke("next_track"),
  prev: () => invoke("prev_track"),
  seek: (positionMs) => invoke("seek", { positionMs }),
  setVolume: (volume) => invoke("set_volume", { volume }),
  removeFromQueue: (index) => invoke("remove_from_queue", { index }),
  removeFromQueueDown: (index) => invoke("remove_from_queue_down", { index }),
  clearQueue: () => invoke("clear_queue"),
  toggleWindowMode: () => invoke("toggle_window_mode"),
  resizeThin: (width) => invoke("resize_thin", { width }),
  openThinPanel: (wanted) => invoke("open_thin_panel", { wanted }),
  closeThinPanel: () => invoke("close_thin_panel"),
  quit: () => invoke("quit_app"),
  onState: (cb) => listen<PlayerState>("player-state", (e) => cb(e.payload)),
  onQueue: (cb) => listen<Track[]>("player-queue", (e) => cb(e.payload)),
  onPosition: (cb) => listen<number>("player-position", (e) => cb(e.payload)),
  onWindowMode: (cb) => listen<WindowMode>("window-mode", (e) => cb(e.payload)),
  onSpectrum: (cb) => listen<SpectrumFrame>("spectrum", (e) => cb(e.payload)),
  onScanProgress: (cb) => listen<ScanProgress>("scan-progress", (e) => cb(e.payload)),
  onScanTracks: (cb) => listen<Track[]>("scan-tracks", (e) => cb(e.payload)),
  onPlayed: (cb) => listen<{ path: string } & PlayStat>("song-played", (e) => cb(e.payload)),
};
