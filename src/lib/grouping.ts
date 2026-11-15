import type { Track } from "./types";

export interface Album {
  key: string;
  title: string;
  artist: string;
  year: number | null;
  tracks: Track[];
  durationMs: number;
}

export interface Artist {
  name: string;
  albumCount: number;
  trackCount: number;
}

const text = (a: string, b: string, numeric = false) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric });

/** The artist an album is filed under: album artist, else track artist. */
export function artistOf(track: Track): string {
  return track.albumArtist || track.artist || "Unknown artist";
}

function albumTitleOf(track: Track): string {
  return track.album || "Unknown album";
}

/** Disc, then track number, then title. Tracks without numbers go last. */
export function sortAlbumTracks(tracks: Track[]): Track[] {
  const n = (v: number | null) => v ?? Number.MAX_SAFE_INTEGER;
  return [...tracks].sort(
    (a, b) =>
      n(a.discNumber) - n(b.discNumber) ||
      n(a.trackNumber) - n(b.trackNumber) ||
      text(a.title, b.title),
  );
}

/** Groups tracks into albums (same artist and album title), sorted by artist then year then title. */
export function groupAlbums(tracks: Track[]): Album[] {
  const byKey = new Map<string, Track[]>();
  for (const t of tracks) {
    const key = `${artistOf(t)}\u0000${albumTitleOf(t)}`;
    const list = byKey.get(key);
    if (list) list.push(t);
    else byKey.set(key, [t]);
  }
  const albums: Album[] = [];
  for (const [key, list] of byKey) {
    const years = list.map((t) => t.year).filter((y): y is number => y !== null);
    albums.push({
      key,
      title: albumTitleOf(list[0]),
      artist: artistOf(list[0]),
      year: years.length > 0 ? Math.min(...years) : null,
      tracks: sortAlbumTracks(list),
      durationMs: list.reduce((sum, t) => sum + t.durationMs, 0),
    });
  }
  const year = (a: Album) => a.year ?? Number.MAX_SAFE_INTEGER;
  return albums.sort(
    (a, b) => text(a.artist, b.artist) || year(a) - year(b) || text(a.title, b.title),
  );
}

/** Artists with how many albums and tracks they have, sorted by name. */
export function groupArtists(tracks: Track[]): Artist[] {
  const albumsByArtist = new Map<string, Set<string>>();
  const countByArtist = new Map<string, number>();
  for (const t of tracks) {
    const name = artistOf(t);
    if (!albumsByArtist.has(name)) albumsByArtist.set(name, new Set());
    albumsByArtist.get(name)!.add(albumTitleOf(t));
    countByArtist.set(name, (countByArtist.get(name) ?? 0) + 1);
  }
  return [...albumsByArtist.entries()]
    .map(([name, albums]) => ({
      name,
      albumCount: albums.size,
      trackCount: countByArtist.get(name)!,
    }))
    .sort((a, b) => text(a.name, b.name));
}

/** All of an artist's tracks in album order, so playing them reads like a discography. */
export function tracksForArtist(tracks: Track[], name: string): Track[] {
  return groupAlbums(tracks.filter((t) => artistOf(t) === name)).flatMap((a) => a.tracks);
}

/** A stable 0-359 hue for an album, used to color its cover placeholder. */
export function albumHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export type GroupMode = "artist" | "genre" | "year" | "decade" | "folder";
export type GroupSort = "name" | "albums" | "tracks";
export type SortDirection = "asc" | "desc";

export interface Group {
  name: string;
  albumCount: number;
  trackCount: number;
}

const UNKNOWN = "Unknown";

/** The folder a song's file sits in, as "parent/folder" so same-named folders under different parents stay apart. */
export function folderOf(track: Track): string {
  const parts = track.path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.slice(-2).join("/") || `${UNKNOWN} folder`;
}

/** Which group a track belongs to under `mode`. Tracks missing the tag land in an "Unknown …" group. */
export function groupName(track: Track, mode: GroupMode): string {
  switch (mode) {
    case "artist":
      return artistOf(track);
    case "genre":
      return track.genre || `${UNKNOWN} genre`;
    case "year":
      return track.year !== null ? String(track.year) : `${UNKNOWN} year`;
    case "decade":
      return track.year !== null ? `${Math.floor(track.year / 10) * 10}s` : `${UNKNOWN} decade`;
    case "folder":
      return folderOf(track);
  }
}

/**
 * Groups tracks by `mode`, with how many distinct albums and tracks each has,
 * sorted by `sort` in `direction`. "Unknown …" groups always come last, and
 * ties fall back to the name so the order is stable.
 */
export function groupTracks(
  tracks: Track[],
  mode: GroupMode,
  sort: GroupSort,
  direction: SortDirection,
): Group[] {
  const albums = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const name = groupName(t, mode);
    if (!albums.has(name)) albums.set(name, new Set());
    albums.get(name)!.add(`${artistOf(t)}\u0000${albumTitleOf(t)}`);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const groups = [...albums.entries()].map(([name, set]) => ({
    name,
    albumCount: set.size,
    trackCount: counts.get(name)!,
  }));

  const sign = direction === "asc" ? 1 : -1;
  const byName = (a: Group, b: Group) => text(a.name, b.name, true);
  return groups.sort((a, b) => {
    const aUnknown = a.name.startsWith(UNKNOWN);
    const bUnknown = b.name.startsWith(UNKNOWN);
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    const primary = sort === "name" ? byName(a, b) : (a[sort === "albums" ? "albumCount" : "trackCount"] - b[sort === "albums" ? "albumCount" : "trackCount"]);
    return primary * sign || byName(a, b);
  });
}

/** A group's tracks in album order. */
export function tracksInGroup(tracks: Track[], mode: GroupMode, name: string): Track[] {
  return groupAlbums(tracks.filter((t) => groupName(t, mode) === name)).flatMap((a) => a.tracks);
}
