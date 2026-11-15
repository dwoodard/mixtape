import { findOriginal, keyOf } from "./duplicates";
import { formatTime, fileName } from "./format";
import type { RemovedSong, Track } from "./types";

export type Advice = "spare-copy" | "other-version" | "not-in-library" | "gone-copy" | "gone";

export interface Assessment {
  advice: Advice;
  /** What this means and what to do, in a sentence. */
  text: string;
  /** The library song it was compared with, if any. */
  match: Track | null;
}

const norm = (s: string) => s.trim().toLowerCase();
const named = (t: Track) => `“${t.title}”${t.artist ? ` by ${t.artist}` : ""}`;

/** Works out whether a removed song is still wanted: is the same song in the library, and is the file still there? */
export function assess(song: RemovedSong, library: Track[]): Assessment {
  if (song.missing) {
    const original = findOriginal(song.path, library);
    return original
      ? { advice: "gone-copy", match: original, text: `The file is gone. It was a copy of ${named(original)}, which is still in the library. Forget this entry.` }
      : { advice: "gone", match: null, text: "The file is gone from disk, so there is nothing to restore. Forget this entry." };
  }
  const tags = song.track;
  if (!tags) {
    return { advice: "not-in-library", match: null, text: "The file is there but can't be read as a song. Delete it, or restore it to try again." };
  }
  const key = keyOf(tags);
  const same = library.find((t) => keyOf(t) === key);
  if (same) {
    return { advice: "spare-copy", match: same, text: `The library already has this exact song (${fileName(same.path)}). This file is a spare copy: safe to delete.` };
  }
  const near = library.find(
    (t) => norm(t.title) === norm(tags.title) && norm(t.artist) === norm(tags.artist) && Math.abs(t.durationMs - tags.durationMs) <= 2000,
  );
  if (near) {
    return {
      advice: "spare-copy",
      match: near,
      text: `The library has ${named(near)} with the same length (${formatTime(near.durationMs)}), so this is almost certainly the same recording with different tags (album: ${tags.album || "none"} vs ${near.album || "none"}). Safe to delete.`,
    };
  }
  const other = library.find((t) => norm(t.title) === norm(tags.title) && norm(t.artist) === norm(tags.artist));
  if (other) {
    return {
      advice: "other-version",
      match: other,
      text: `The library has ${named(other)} from ${other.album || "no album"} (${formatTime(other.durationMs)}). This file is a different version (${tags.album || "no album"}, ${formatTime(tags.durationMs)}). Restore it if you want both.`,
    };
  }
  return { advice: "not-in-library", match: null, text: "Not in your library. Restore it to listen to it again, or delete the file if you don't want it." };
}
