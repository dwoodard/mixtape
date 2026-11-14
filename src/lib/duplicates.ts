import { fileName } from "./format";
import type { Track } from "./types";

export interface DuplicateGroup {
  key: string;
  /** The copy to keep: the one that does not look like a numbered duplicate of another. */
  keep: Track;
  extras: Track[];
}

/** " 1", " (2)", " copy", "-copy 3" at the end of a file name (before the extension). */
const COPY_MARKER = /(?:\s\(\d+\)|\s\d+|[-_ ]copy(?:\s\d+)?)$/i;

const stem = (path: string) => fileName(path).replace(/\.[^.]+$/, "");

/** Same title, artist, album and length (to the second) means the same recording. */
function keyOf(t: Track): string {
  const norm = (s: string) => s.trim().toLowerCase();
  return [norm(t.title), norm(t.artist), norm(t.album), Math.round(t.durationMs / 1000)].join("\u0000");
}

/**
 * Finds songs that are in the library more than once. A file counts as a
 * copy only if removing its marker gives another member's name, so a real
 * title ending in a number ("Song 2") is not mistaken for a copy of "Song".
 * Groups come out ordered by artist, album, then title.
 */
export function findDuplicates(tracks: Track[]): DuplicateGroup[] {
  const byKey = new Map<string, Track[]>();
  for (const t of tracks) {
    const list = byKey.get(keyOf(t));
    if (list) list.push(t);
    else byKey.set(keyOf(t), [t]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const stems = new Set(members.map((m) => stem(m.path)));
    const isCopy = (m: Track) => {
      const s = stem(m.path);
      const original = s.replace(COPY_MARKER, "");
      return original !== s && stems.has(original);
    };
    const ranked = [...members].sort(
      (a, b) =>
        Number(isCopy(a)) - Number(isCopy(b)) ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
    groups.push({ key, keep: ranked[0], extras: ranked.slice(1) });
  }
  const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return groups.sort(
    (a, b) =>
      text(a.keep.artist, b.keep.artist) || text(a.keep.album, b.keep.album) || text(a.keep.title, b.keep.title),
  );
}

/** Every extra copy across all groups. */
export const extraCopies = (groups: DuplicateGroup[]): Track[] => groups.flatMap((g) => g.extras);

/** Groups the user has not dismissed ("Not a duplicate"). */
export const withoutIgnored = (groups: DuplicateGroup[], ignored: ReadonlySet<string>): DuplicateGroup[] =>
  groups.filter((g) => !ignored.has(g.key));

/** Groups that have not been announced before and are not dismissed. */
export function newDuplicateGroups(
  groups: DuplicateGroup[],
  seen: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
): DuplicateGroup[] {
  return groups.filter((g) => !seen.has(g.key) && !ignored.has(g.key));
}
