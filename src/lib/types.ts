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

export interface PlayerState {
  status: PlaybackStatus;
  currentIndex: number | null;
  currentTrack: Track | null;
  positionMs: number;
  durationMs: number;
  volume: number;
  error: string | null;
}

export interface PlayerSnapshot {
  state: PlayerState;
  queue: Track[];
}

export type WindowMode = "thin" | "large";
