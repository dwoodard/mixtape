import type { Track } from "./types";

export type SortKey = "default" | "title" | "artist" | "album" | "durationMs" | "year" | "addedMs";
export type SortDirection = "asc" | "desc";

/** Case-insensitive match of every word in `query` against title, artist, album, or genre. */
export function filterTracks(tracks: Track[], query: string): Track[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tracks;
  return tracks.filter((t) => {
    const haystack = `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** A copy of `tracks` in a random order that is the same every time for the same `seed`. */
export function shuffleTracks(tracks: Track[], seed: number): Track[] {
  let state = seed >>> 0;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...tracks];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sorts a copy of `tracks`. "default" keeps the order given (the scanner
 * already sorts by artist, album, disc, track).
 */
export function sortTracks(tracks: Track[], key: SortKey, direction: SortDirection): Track[] {
  if (key === "default") return tracks;
  const sign = direction === "asc" ? 1 : -1;
  return [...tracks].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    // Missing values (null year, empty text) sort last in either direction.
    const aMissing = av === null || av === "" || (key === "addedMs" && av === 0);
    const bMissing = bv === null || bv === "" || (key === "addedMs" && bv === 0);
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * sign;
  });
}
