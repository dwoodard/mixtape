import type { Track } from "./types";

export type TagField =
  | "title"
  | "artist"
  | "album"
  | "albumArtist"
  | "trackNumber"
  | "discNumber"
  | "year"
  | "genre";

/** Whether text names a cover picture the app can load: an http(s) link, or an absolute path, `~/…` or `file://` link. */
export const isCoverSource = (text: string): boolean => {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) || /^(\/|~\/|file:\/\/)\S/.test(t);
};
export const COVER_SOURCE_ERROR = "The cover art must be an http(s) link or the path of a picture on this computer.";

export const MULTIPLE = "(multiple values)";

export const TAG_FIELDS: { key: TagField; label: string; numeric?: boolean }[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "albumArtist", label: "Album artist" },
  { key: "trackNumber", label: "Track", numeric: true },
  { key: "discNumber", label: "Disc", numeric: true },
  { key: "year", label: "Year", numeric: true },
  { key: "genre", label: "Genre" },
];

export type TagDraft = Record<TagField, string>;
/** What the backend takes: only the fields that change; an empty string clears. */
export type TagEditPayload = Partial<Record<TagField, string>> & {
  /** The words of the song, kept in the file's lyrics tag. Line breaks are kept; an empty string removes them. */
  lyrics?: string;
  /** Where to get the picture to embed as the front cover: an http(s) link or a file path. It is converted to JPEG. */
  coverUrl?: string;
};

export interface TagChange {
  field: TagField | "coverUrl" | "lyrics";
  label: string;
  /** The current value, or MULTIPLE when the selected songs differ. */
  from: string;
  /** The new value; empty means the field will be cleared. */
  to: string;
}

const read = (t: Track, field: TagField): string => {
  const v = t[field];
  return v === null || v === undefined ? "" : String(v);
};

/** The value all `tracks` share for `field`, or "" when they differ (or there are none). */
export function commonValue(tracks: Track[], field: TagField): string {
  if (tracks.length === 0) return "";
  const first = read(tracks[0], field);
  return tracks.every((t) => read(t, field) === first) ? first : "";
}

/** True when the selected songs do not all have the same value for `field`. */
export function isMixed(tracks: Track[], field: TagField): boolean {
  return tracks.length > 1 && !tracks.every((t) => read(t, field) === read(tracks[0], field));
}

/** The form's starting values for a selection. */
export function draftFor(tracks: Track[]): TagDraft {
  return Object.fromEntries(TAG_FIELDS.map(({ key }) => [key, commonValue(tracks, key)])) as TagDraft;
}

/**
 * Compares the form with the selection and returns just what changed, both as
 * the payload to send and as a readable list for the review step. A field
 * left alone is never sent, so editing one field cannot disturb the others.
 * Numeric fields are checked: `error` explains the first bad one.
 */
export function buildEdit(
  tracks: Track[],
  draft: TagDraft,
  /** A link to a picture to embed as the cover art; empty leaves the art alone. */
  coverUrl = "",
  /** The lyrics saved in a single song's tags, and what the form now holds. Only for one song. */
  lyrics?: { before: string; after: string },
): { edit: TagEditPayload; changes: TagChange[]; error: string | null } {
  const edit: TagEditPayload = {};
  const changes: TagChange[] = [];
  let error: string | null = null;

  for (const { key, label, numeric } of TAG_FIELDS) {
    const before = commonValue(tracks, key);
    const after = draft[key].trim();
    if (after === before.trim()) continue;
    if (numeric && after !== "" && !/^\d+$/.test(after)) {
      error ??= `${label} must be a whole number.`;
      continue;
    }
    if (key === "year" && after !== "" && Number(after) > 9999) {
      error ??= "Year must be between 0 and 9999.";
      continue;
    }
    edit[key] = after;
    changes.push({ field: key, label, from: isMixed(tracks, key) ? MULTIPLE : before, to: after });
  }
  const cover = coverUrl.trim();
  if (cover !== "") {
    if (!isCoverSource(cover)) error ??= COVER_SOURCE_ERROR;
    else {
      edit.coverUrl = cover;
      changes.push({ field: "coverUrl", label: "Cover art", from: "(current art)", to: cover });
    }
  }
  if (lyrics && tidyLyrics(lyrics.after) !== tidyLyrics(lyrics.before)) {
    const after = tidyLyrics(lyrics.after);
    const lines = (text: string) => `${text.split("\n").length} lines`;
    edit.lyrics = after;
    changes.push({ field: "lyrics", label: "Lyrics", from: lyrics.before.trim() ? lines(tidyLyrics(lyrics.before)) : "(empty)", to: after ? lines(after) : "" });
  }
  return { edit, changes, error };
}

/** Lyrics with one kind of line ending and no blank space at the ends, as the file keeps them. */
export const tidyLyrics = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

/** `edit` without the fields every one of `tracks` already has: writing those again changes nothing. */
export function changedFields(edit: TagEditPayload, tracks: Track[]): TagEditPayload {
  return Object.fromEntries(
    Object.entries(edit).filter(([field, value]) => !tracks.every((t) => read(t, field as TagField) === value)),
  );
}

