import type { Track } from "./types";

/** A song whose artist folder is not the one its artist's songs live in, and where it should go instead. */
export interface Misplaced {
  track: Track;
  /** The artist folder it is in now. */
  from: string;
  /** The artist folder it probably belongs in. */
  to: string;
  /** The full folder to move the file into: the target artist folder, with the song's own album folder kept. */
  toFolder: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const CREDIT_SPLIT = /\s*(?:,|;|&|\/|\band\b|\bx\b|\bfeat\.?|\bfeaturing\b|\bft\.?|\bwith\b)\s*/i;
const COMPILATION = new Set(["variousartists", "various", "va"]);

/** Every artist named on a song, folded so "Forrest." and "Forrest_" compare equal. */
function credits(t: Track): string[] {
  return [...new Set([t.artist, t.albumArtist].flatMap((s) => s.split(CREDIT_SPLIT)).map(fold).filter(Boolean))];
}

/** The path under the library folder, split in parts, or null when the song is outside it or loose in it. */
function parts(path: string, root: string): string[] | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(base)) return null;
  const rest = path.slice(base.length).split("/");
  return rest.length >= 2 ? rest : null;
}

/**
 * Songs filed under the wrong artist folder. A song's home is the folder named after one of its credited artists
 * that holds the most songs, so "Forrest. & Forrest Frank" in `Forrest_` (1 song) belongs in `Forrest Frank` (many).
 * A song is only flagged when such a folder exists and is not the one it is in. Compilations are left alone.
 */
export function findMisplaced(tracks: Track[], root: string | null): Misplaced[] {
  if (!root) return [];
  const placed = tracks.flatMap((track) => {
    const p = parts(track.path, root);
    return p ? [{ track, parts: p }] : [];
  });
  const size = new Map<string, number>();
  for (const { parts: p } of placed) size.set(p[0], (size.get(p[0]) ?? 0) + 1);
  const byName = new Map<string, string[]>();
  for (const folder of size.keys()) byName.set(fold(folder), [...(byName.get(fold(folder)) ?? []), folder]);

  const out: Misplaced[] = [];
  for (const { track, parts: p } of placed) {
    if (COMPILATION.has(fold(track.albumArtist))) continue;
    const named = credits(track).flatMap((c) => byName.get(c) ?? []);
    if (named.length === 0) continue;
    // Most songs wins; on a tie the folder it is already in stays.
    const home = named.reduce((best, f) => ((size.get(f) ?? 0) > (size.get(best) ?? 0) || (size.get(f) === size.get(best) && f === p[0]) ? f : best));
    if (home === p[0]) continue;
    out.push({ track, from: p[0], to: home, toFolder: [root.replace(/\/$/, ""), home, ...p.slice(1, -1)].join("/") });
  }
  return out;
}
