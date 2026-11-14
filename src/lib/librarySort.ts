import type { Track } from "./types";

/** The order a scan produces: artist (album artist first), album, disc, track, path. */
const key = (t: Track): [string, string, number, number, string] => [
  (t.albumArtist || t.artist).toLowerCase(),
  t.album.toLowerCase(),
  t.discNumber ?? 0,
  t.trackNumber ?? 0,
  t.path.toLowerCase(),
];

function compare(a: Track, b: Track): number {
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

/** `tracks` with `track` added in scan order (or replacing the entry with the same path). */
export function insertSorted(tracks: Track[], track: Track): Track[] {
  const rest = tracks.filter((t) => t.path !== track.path);
  let at = rest.findIndex((t) => compare(track, t) < 0);
  if (at === -1) at = rest.length;
  return [...rest.slice(0, at), track, ...rest.slice(at)];
}
