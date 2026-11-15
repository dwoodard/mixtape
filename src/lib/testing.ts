import type { PlayerState, Track } from "./types";

export function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    path: "/music/song.mp3",
    title: "Song",
    artist: "Artist",
    album: "Album",
    albumArtist: "",
    trackNumber: null,
    discNumber: null,
    year: null,
    genre: "",
    durationMs: 180_000,
    addedMs: 0,
    ...overrides,
  };
}

export function makePlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
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
    ...overrides,
  };
}
