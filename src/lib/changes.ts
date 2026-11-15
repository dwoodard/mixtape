import type { Track } from "./types";

export interface QueueReplacement {
  oldPath: string;
  track: Track;
}

/** Letters and digits only, lowercase: "Got The Life!" and "got the life" compare equal. */
const fold = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

const TAG_FIELDS = ["title", "artist", "album", "albumArtist", "trackNumber", "discNumber", "year", "genre"] as const;
const sameTags = (a: Track, b: Track) => TAG_FIELDS.every((f) => a[f] === b[f]);

/** The same recording: same title and a length within a third of a second. */
export function sameRecording(a: Track, b: Track): boolean {
  return fold(a.title) !== "" && fold(a.title) === fold(b.title) && Math.abs(a.durationMs - b.durationMs) <= 300;
}

/**
 * Songs in `after` that are new or whose tags differ from the same file in
 * `before`: what a re-check of a folder actually changed.
 */
export function changedTracks(before: Track[], after: Track[]): Track[] {
  const old = new Map(before.map((t) => [t.path, t]));
  return after.filter((t) => {
    const was = old.get(t.path);
    return !was || !sameTags(was, t);
  });
}

/**
 * How the play queue should follow `changed` songs (just added or retagged):
 * - an entry for the same file whose tags are out of date gets the fresh song;
 * - an entry whose file is no longer in the `library` (undone, renamed, moved) but
 *   which is the same recording as a changed song is pointed at that song.
 * One replacement per file in the queue.
 */
export function queueReplacements(queue: Track[], library: Track[], changed: Track[]): QueueReplacement[] {
  if (queue.length === 0 || changed.length === 0) return [];
  const inLibrary = new Set(library.map((t) => t.path));
  const out = new Map<string, QueueReplacement>();
  for (const q of queue) {
    if (out.has(q.path)) continue;
    const fresh = changed.find((c) => c.path === q.path);
    if (fresh) {
      if (!sameTags(fresh, q)) out.set(q.path, { oldPath: q.path, track: fresh });
      continue;
    }
    if (library.length > 0 && !inLibrary.has(q.path)) {
      const candidates = changed.filter((c) => sameRecording(q, c));
      const best = candidates.find((c) => fold(c.artist) === fold(q.artist)) ?? candidates[0];
      if (best) out.set(q.path, { oldPath: q.path, track: best });
    }
  }
  return [...out.values()];
}
