import { dirName } from "./format";

/**
 * Which folders of the library to re-check, given the files that were touched. Small and targeted, never the whole
 * library: a full rescan of a network drive takes minutes, one album folder takes a second.
 *
 * - `widen` false: each file's own folder (the album). For after an add, which only puts a file in one place.
 * - `widen` true: the top folder the file sits under (the artist). For after something may have renamed or moved it, such
 *   as Picard: a song can end up in a different album folder, which only a look one level up will find.
 *
 * Only folders inside `root` count, and `root` itself never does (a file straight in the root has no smaller folder).
 * A folder inside another one in the result is left out, since looking at the outer one covers it.
 */
export function scopeFor(root: string | null, paths: string[], widen: boolean): string[] {
  if (!root) return [];
  const base = root.replace(/\/+$/, "");
  const dirs = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(`${base}/`)) continue;
    const below = path.slice(base.length + 1).split("/"); // folders under the root, then the file name
    if (below.length < 2) continue; // directly in the root
    dirs.add(widen && below.length >= 3 ? `${base}/${below[0]}` : dirName(path));
  }
  return [...dirs].filter((d) => ![...dirs].some((other) => other !== d && d.startsWith(`${other}/`))).sort();
}

/** The same for folders that are already known (the ones remembered after sending songs to Picard). */
export function scopeForDirs(root: string | null, dirs: string[], widen: boolean): string[] {
  // A folder stands for a file in it: that gives the same rule for both.
  return scopeFor(root, dirs.map((d) => `${d}/\u0000`), widen);
}
