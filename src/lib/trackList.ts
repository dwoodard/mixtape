import type { PlayStat, Track } from "./types";

export type SortKey = "default" | "title" | "artist" | "album" | "durationMs" | "year" | "addedMs" | "plays";
export type SortDirection = "asc" | "desc";

/** Words in the filter box that mean "songs with no cover picture" instead of matching text. */
const NO_COVER_WORDS = new Set(["nocover", "no:cover"]);

/** Whether the filter asks for songs with no cover art, so the caller knows to check the files. */
export const wantsNoCover = (query: string): boolean => query.toLowerCase().split(/\s+/).some((w) => NO_COVER_WORDS.has(w));

/**
 * Case-insensitive match of every word in `query` against title, artist, album, genre, or year.
 * `nocover` (or `no:cover`) keeps only the songs in `coverless`, so it combines with other words.
 */
export function filterTracks(tracks: Track[], query: string, coverless: ReadonlySet<string> = new Set()): Track[] {
  const all = query.toLowerCase().split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !NO_COVER_WORDS.has(w));
  const noCover = words.length !== all.length;
  if (words.length === 0 && !noCover) return tracks;
  return tracks.filter((t) => {
    if (noCover && !coverless.has(t.path)) return false;
    const haystack = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.year ?? ""}`.toLowerCase();
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
export function sortTracks(
  tracks: Track[],
  key: SortKey,
  direction: SortDirection,
  plays: Record<string, PlayStat> = {},
): Track[] {
  if (key === "default") return tracks;
  const sign = direction === "asc" ? 1 : -1;
  // Songs never played count as 0 plays, and sort with the others, not last.
  if (key === "plays") {
    return [...tracks].sort((a, b) => ((plays[a.path]?.count ?? 0) - (plays[b.path]?.count ?? 0)) * sign);
  }
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
