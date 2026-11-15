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
  /** When the file arrived in the library (ms since the epoch), 0 if unknown. */
  addedMs: number;
}

/** What the app found when it compared a song's file with the library's record of it. */
export interface FileCheck {
  path: string;
  sizeBytes: number;
  /** The length the library holds. */
  storedMs: number;
  /** The length the file really plays for, when ffprobe is installed. */
  realMs: number | null;
  codec: string | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  /** The bitrate the stored length would mean. Absurd values give a wrong length away. */
  impliedKbps: number | null;
  verdict: "ok" | "lengthWrong" | "looksWrong" | "cannotCheck";
  notes: string[];
}

/** How often a song was played and when it was last played (ms since the epoch). */
export interface PlayStat {
  count: number;
  lastPlayedMs: number;
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

export interface DuplicatePair {
  keep: string;
  extra: string;
}

export interface CleanupReport {
  /** Moved to the Trash. */
  trashed: string[];
  /** Moved to a holding folder on the same drive instead (the drive has no Trash). */
  held: { path: string; movedTo: string }[];
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

export type ImportStage = "queued" | "probing" | "fetching" | "converting" | "ready" | "added" | "failed";

export type ImportField = "title" | "artist" | "album" | "albumArtist" | "year" | "track" | "genre";

export interface ImportProposal {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: string;
  track: string;
  genre: string;
  /** Disc of a multi-disc release and how many there are (from Picard); they only shape the file name. */
  disc: string;
  discTotal: string;
}

export interface ImportItem {
  id: number;
  url: string;
  stage: ImportStage;
  /** 0 to 1 while fetching. */
  progress: number;
  error: string | null;
  videoTitle: string;
  channel: string;
  durationSecs: number | null;
  proposal: ImportProposal;
  /** Field -> where its value came from, in words. */
  sources: Record<string, string>;
  /** Field -> other values worth offering. */
  alternatives: Record<string, string[]>;
  notes: string[];
  /** 0 to 1: how sure we are of the artist and title. */
  confidence: number;
  format: string;
  /** Where it will go, relative to the library folder. */
  destination: string | null;
  addedPath: string | null;
  /** none: not sent to Picard. waiting: open there. saved: tags are Picard's (read-only here). */
  picard: "none" | "waiting" | "saved";
}

export type ImportEvent = { kind: "item"; value: ImportItem } | { kind: "removed"; value: number };

export interface ToolStatus {
  ytDlp: string | null;
  ffmpeg: string | null;
  /** Where MusicBrainz Picard is installed, if it is. */
  picard: string | null;
}

export type TagsPatch = Partial<Omit<ImportProposal, "disc" | "discTotal">>;

/** A folder of the library as it is now, after it was re-checked. */
export interface FolderRefresh {
  dir: string;
  tracks: Track[];
}
