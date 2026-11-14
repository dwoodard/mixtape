import type { Track } from "./types";

export type SortKey = "default" | "title" | "artist" | "album" | "durationMs" | "year";
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
    const aMissing = av === null || av === "";
    const bMissing = bv === null || bv === "";
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * sign;
  });
}
