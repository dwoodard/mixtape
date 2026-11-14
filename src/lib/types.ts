export interface Track {
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  genre: string;
  durationMs: number;
}

export type PlaybackStatus = "stopped" | "playing" | "paused";

export type Repeat = "off" | "all" | "one";

export interface PlayerState {
  status: PlaybackStatus;
  currentIndex: number | null;
  currentTrack: Track | null;
  positionMs: number;
  durationMs: number;
  volume: number;
  shuffle: boolean;
  repeat: Repeat;
  error: string | null;
  /** The file that could not be played, when `error` is set. */
  errorPath: string | null;
}

export interface PlayerSnapshot {
  state: PlayerState;
  queue: Track[];
}

export type WindowMode = "thin" | "large";

export interface ScanProgress {
  phase: "discovering" | "reading";
  done: number;
  /** 0 while discovering (unknown). */
  total: number;
}

export interface CachedLibrary {
  folder: string;
  tracks: Track[];
  scannedAtMs: number;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  durationMs: number;
  updatedAtMs: number;
}

export interface DuplicatePair {
  keep: string;
  extra: string;
}

export interface CleanupReport {
  /** Moved to the Trash. */
  trashed: string[];
  /** Moved to a holding folder on the same drive instead (the drive has no Trash). */
  held: string[];
  /** That holding folder, when anything was held. */
  holdingFolder: string | null;
  /** Were already gone from disk. */
  missing: string[];
  /** Left alone, with why. */
  skipped: { path: string; reason: string }[];
}

export interface TagWriteResult {
  path: string;
  /** The track as re-read from disk after a successful write. */
  track: Track | null;
  error: string | null;
}
