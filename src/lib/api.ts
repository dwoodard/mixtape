import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { CachedLibrary, PlayerSnapshot, PlayerState, PlaylistSummary, Repeat, ScanProgress, Track, WindowMode } from "./types";

type Unlisten = () => void;

/** Everything the UI needs from the Rust side. Faked in tests. */
export interface Api {
  snapshot(): Promise<PlayerSnapshot>;
  windowMode(): Promise<WindowMode>;
  pickFolder(): Promise<string | null>;
  scanFolder(path: string): Promise<Track[]>;
  musicFolder(): Promise<string | null>;
  importLibrary(): Promise<Track[]>;
  cancelScan(): Promise<void>;
  cachedLibrary(): Promise<CachedLibrary | null>;
  removeFromLibrary(paths: string[]): Promise<void>;
  removedCount(): Promise<number>;
  restoreRemoved(): Promise<void>;
  playTracks(tracks: Track[], start: number): Promise<void>;
  enqueue(tracks: Track[]): Promise<void>;
  enqueueNext(tracks: Track[]): Promise<void>;
  stop(): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(repeat: Repeat): Promise<void>;
  listPlaylists(): Promise<PlaylistSummary[]>;
  loadPlaylist(id: string): Promise<Track[]>;
  savePlaylist(name: string, tracks: Track[]): Promise<PlaylistSummary>;
  deletePlaylist(id: string): Promise<void>;
  playIndex(index: number): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  removeFromQueue(index: number): Promise<void>;
  clearQueue(): Promise<void>;
  toggleWindowMode(): Promise<WindowMode>;
  quit(): Promise<void>;
  onState(cb: (state: PlayerState) => void): Promise<Unlisten>;
  onQueue(cb: (queue: Track[]) => void): Promise<Unlisten>;
  onPosition(cb: (positionMs: number) => void): Promise<Unlisten>;
  onWindowMode(cb: (mode: WindowMode) => void): Promise<Unlisten>;
  onScanProgress(cb: (progress: ScanProgress) => void): Promise<Unlisten>;
}

export const tauriApi: Api = {
  snapshot: () => invoke("player_snapshot"),
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
  removedCount: () => invoke("removed_count"),
  restoreRemoved: () => invoke("restore_removed"),
  playTracks: (tracks, start) => invoke("play_tracks", { tracks, start }),
  enqueue: (tracks) => invoke("enqueue", { tracks }),
  enqueueNext: (tracks) => invoke("enqueue_next", { tracks }),
  stop: () => invoke("stop_playback"),
  setShuffle: (on) => invoke("set_shuffle", { on }),
  setRepeat: (repeat) => invoke("set_repeat", { repeat }),
  listPlaylists: () => invoke("list_playlists"),
  loadPlaylist: (id) => invoke("load_playlist", { id }),
  savePlaylist: (name, tracks) => invoke("save_playlist", { name, tracks }),
  deletePlaylist: (id) => invoke("delete_playlist", { id }),
  playIndex: (index) => invoke("play_index", { index }),
  toggle: () => invoke("toggle_playback"),
  next: () => invoke("next_track"),
  prev: () => invoke("prev_track"),
  seek: (positionMs) => invoke("seek", { positionMs }),
  setVolume: (volume) => invoke("set_volume", { volume }),
  removeFromQueue: (index) => invoke("remove_from_queue", { index }),
  clearQueue: () => invoke("clear_queue"),
  toggleWindowMode: () => invoke("toggle_window_mode"),
  quit: () => invoke("quit_app"),
  onState: (cb) => listen<PlayerState>("player-state", (e) => cb(e.payload)),
  onQueue: (cb) => listen<Track[]>("player-queue", (e) => cb(e.payload)),
  onPosition: (cb) => listen<number>("player-position", (e) => cb(e.payload)),
  onWindowMode: (cb) => listen<WindowMode>("window-mode", (e) => cb(e.payload)),
  onScanProgress: (cb) => listen<ScanProgress>("scan-progress", (e) => cb(e.payload)),
};
