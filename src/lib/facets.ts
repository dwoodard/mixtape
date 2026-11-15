import type { Track } from "./types";

/** The `name:value` words the filter box understands, with what each one means (shown in the suggestion list). */
export const FACETS = [
  { name: "artist", hint: "Songs by an artist" },
  { name: "albumartist", hint: "Songs on albums by an artist" },
  { name: "album", hint: "Songs on an album" },
  { name: "title", hint: "Songs with this title" },
  { name: "genre", hint: "Songs in a genre" },
  { name: "year", hint: "A year, or a range like 2000..2009" },
  { name: "length", hint: "Minutes, or a range like 3..5" },
  { name: "added", hint: "Added within 7d, 2w, 3m or 1y" },
  { name: "has", hint: "Songs with a cover or lyrics" },
  { name: "no", hint: "Songs missing a cover or lyrics" },
] as const;

export type FacetName = (typeof FACETS)[number]["name"];

/** What `no:` and `has:` can be followed by. */
export const NO_VALUES = ["cover", "lyrics"] as const;
/** Time spans `added:` offers, as a count and a unit: d(ays), w(eeks), m(onths), y(ears). */
const ADDED_VALUES = ["7d", "30d", "3m", "1y"] as const;
const DAY_MS = 86_400_000;
const UNIT_DAYS = { d: 1, w: 7, m: 30, y: 365 } as const;

const FACET_NAMES: ReadonlySet<string> = new Set(FACETS.map((f) => f.name));

/** One word of the filter box: free text, or `facet:value` (the value may be quoted to hold spaces). */
export interface FilterToken {
  /** Where the word sits in the query text. */
  start: number;
  end: number;
  facet: FacetName | null;
  /** The text to match, without the facet name or quotes, in lower case. */
  value: string;
}

/** `name:"two words"`, `"two words"`, or a plain word. An unclosed quote runs to the end, so typing one works. */
const WORD = /(?:[^\s":]+:)?"[^"]*"?|\S+/g;

const unquote = (text: string) => text.replace(/^"/, "").replace(/"$/, "");

/** Splits the filter box text into words, with their positions. */
export function tokenize(query: string): FilterToken[] {
  return [...query.matchAll(WORD)].map((m) => {
    const raw = m[0];
    const start = m.index ?? 0;
    const colon = raw.indexOf(":");
    const name = colon > 0 ? raw.slice(0, colon).toLowerCase() : "";
    if (FACET_NAMES.has(name)) {
      return { start, end: start + raw.length, facet: name as FacetName, value: unquote(raw.slice(colon + 1)).toLowerCase() };
    }
    return { start, end: start + raw.length, facet: null, value: unquote(raw).toLowerCase() };
  });
}

/** A number facet value: `2019`, or `2000..2009` (either end may be left off). A single number matches `whole(n)` equal to it. */
function numberMatches(value: string, n: number | null, whole: (n: number) => number = (x) => x): boolean {
  if (n === null) return false;
  const range = /^(\d*)\.\.(\d*)$/.exec(value);
  if (range) {
    const [, from, to] = range;
    if (!from && !to) return false;
    return (!from || n >= Number(from)) && (!to || n <= Number(to));
  }
  return /^\d+$/.test(value) && whole(n) === Number(value);
}

/** `added:` value like `7d` or `3m`: whether the song arrived within that long before `now`. Songs of unknown date never match. */
function addedMatches(value: string, addedMs: number, now: number): boolean {
  const m = /^(\d+)([dwmy])$/.exec(value);
  if (!m || addedMs <= 0) return false;
  return now - addedMs <= Number(m[1]) * UNIT_DAYS[m[2] as keyof typeof UNIT_DAYS] * DAY_MS;
}

/** Whether `track` passes one facet word. Missing covers are not stored on the song, so they come from `coverless`. */
export function facetMatches(token: FilterToken, track: Track, coverless: ReadonlySet<string>, now: number = Date.now()): boolean {
  const { value } = token;
  switch (token.facet) {
    case "artist":
      return `${track.artist}\n${track.albumArtist}`.toLowerCase().includes(value);
    case "albumartist":
      return track.albumArtist.toLowerCase().includes(value);
    case "album":
      return track.album.toLowerCase().includes(value);
    case "title":
      return track.title.toLowerCase().includes(value);
    case "genre":
      return track.genre.toLowerCase().includes(value);
    case "year":
      return numberMatches(value, track.year);
    case "length":
      return numberMatches(value, track.durationMs / 60_000, Math.floor);
    case "added":
      return addedMatches(value, track.addedMs, now);
    case "has":
      if (value === "cover") return !coverless.has(track.path);
      if (value === "lyrics") return track.hasLyrics;
      return false;
    case "no":
      if (value === "cover") return coverless.has(track.path);
      if (value === "lyrics") return !track.hasLyrics;
      return false;
    default:
      return true;
  }
}

/** A choice in the suggestion list and the text it puts in the box. */
export interface Suggestion {
  label: string;
  hint?: string;
  /** What replaces the word being typed. A facet name ends in `:` so its values come up next. */
  insert: string;
  /** For a value: how many songs have it. */
  count?: number;
}

export interface Suggestions {
  items: Suggestion[];
  /** The facet whose values are listed, or null when the list is facet names. */
  facet: FacetName | null;
  /** The part of the query the chosen item replaces. */
  start: number;
  end: number;
}

const quoteIfNeeded = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * `query` with `facet:value` added, or taken out again when it is already there, so clicking an artist, album or year in
 * the list narrows the filter and clicking it a second time widens it. Matching ignores case.
 */
export function toggleFacetTerm(query: string, facet: FacetName, value: string): string {
  const clean = value.replace(/"/g, "").trim();
  if (clean === "") return query;
  const existing = tokenize(query).find((t) => t.facet === facet && t.value === clean.toLowerCase());
  if (existing) return `${query.slice(0, existing.start)} ${query.slice(existing.end)}`.replace(/\s+/g, " ").trim();
  return `${query.trim()} ${facet}:${quoteIfNeeded(clean)}`.trim();
}

/** A finished `facet:value` word of the filter box, shown as a pill with a close button. */
export interface FilterPill {
  facet: FacetName;
  /** The value as written, without quotes. */
  value: string;
  /** The word exactly as it appears in the query. */
  raw: string;
  start: number;
  end: number;
}

/**
 * Splits the filter box text into finished facet words (pills) and the rest (what the text field shows).
 * A facet word still being typed at the very end stays in the text while `typing`, so it only becomes a pill once it is finished.
 */
export function splitFilter(query: string, typing: boolean): { pills: FilterPill[]; text: string } {
  const pills: FilterPill[] = [];
  let text = "";
  let from = 0;
  for (const token of tokenize(query)) {
    if (token.facet === null || token.value === "" || (typing && token.end === query.length)) continue;
    const raw = query.slice(token.start, token.end);
    pills.push({ facet: token.facet, value: unquote(raw.slice(raw.indexOf(":") + 1)), raw, start: token.start, end: token.end });
    text += query.slice(from, token.start);
    from = token.end;
  }
  text += query.slice(from);
  const collapsed = text.replace(/\s+/g, " ").trimStart();
  // A space typed after a word stays, but one left behind by a pill does not.
  return { pills, text: /\s$/.test(query) ? collapsed : collapsed.trimEnd() };
}

/**
 * The query for these pills followed by `text`: the reverse of [`splitFilter`].
 * With `gap`, a space always separates them, so an empty text field counts as a new word after the last pill.
 */
export function joinFilter(pills: readonly FilterPill[], text: string, gap = false): string {
  if (pills.length === 0) return text;
  return pills.map((p) => p.raw).join(" ") + (text === "" && !gap ? "" : ` ${text}`);
}

/** `query` without the word the pill stands for. */
export function removePill(query: string, pill: FilterPill): string {
  return `${query.slice(0, pill.start)} ${query.slice(pill.end)}`.replace(/\s+/g, " ").trim();
}

/** How a facet's values are ordered in the suggestion list: most songs first, or by name (years: newest first). */
export type SuggestSort = "count" | "name";
/** How the year facet's values are grouped in the suggestion list: each year, or a decade as a range like `2010..2019`. */
export type SuggestGroup = "year" | "decade";

/** The distinct values of one facet in `tracks` that contain `typed`, with how many songs have each. */
function valuesFor(facet: FacetName, tracks: readonly Track[], typed: string, sort: SuggestSort, group: SuggestGroup): { value: string; count?: number; label?: string }[] {
  if (facet === "no" || facet === "has") return NO_VALUES.filter((v) => v.includes(typed)).map((value) => ({ value }));
  if (facet === "added") return ADDED_VALUES.filter((v) => v.includes(typed)).map((value) => ({ value }));
  if (facet === "length") return [];
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const raw = facet === "artist" ? t.artist : facet === "albumartist" ? t.albumArtist : facet === "album" ? t.album : facet === "title" ? t.title : facet === "genre" ? t.genre : t.year === null ? "" : String(t.year);
    if (raw && raw.toLowerCase().includes(typed)) counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  let entries: { value: string; count: number; label?: string }[] = [...counts].map(([value, count]) => ({ value, count }));
  if (facet === "year" && group === "decade") {
    const decades = new Map<number, number>();
    for (const e of entries) {
      const decade = Math.floor(Number(e.value) / 10) * 10;
      decades.set(decade, (decades.get(decade) ?? 0) + e.count);
    }
    entries = [...decades].map(([decade, count]) => ({ value: `${decade}..${decade + 9}`, label: `${decade}s`, count }));
  }
  const byName = (a: { value: string }, b: { value: string }) => a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true });
  if (sort === "count") return entries.sort((a, b) => b.count - a.count || byName(a, b));
  return entries.sort(facet === "year" ? (a, b) => parseInt(b.value) - parseInt(a.value) : byName);
}

/**
 * What to offer for the word under the caret, like GitHub's search box: the facet names while a word is being started,
 * then that facet's values once `name:` is typed. Empty when there is nothing to offer.
 */
export function suggest(query: string, caret: number, tracks: readonly Track[], sort: SuggestSort = "count", group: SuggestGroup = "year"): Suggestions {
  const token = tokenize(query).find((t) => caret >= t.start && caret <= t.end);
  const start = token?.start ?? caret;
  const end = token?.end ?? caret;
  const none = { items: [], facet: null, start, end };
  const raw = token ? query.slice(token.start, token.end) : "";

  if (token?.facet) {
    const typed = token.value;
    // Only offer values that exist among the songs the other facets already allow: `artist:X album:` lists X's albums.
    const others = tokenize(query).filter((t) => t !== token && t.facet !== null && t.facet !== "no" && t.facet !== "has" && t.value !== "");
    const narrowed = others.length === 0 ? tracks : tracks.filter((t) => others.every((o) => facetMatches(o, t, new Set())));
    const items = valuesFor(token.facet, narrowed, typed, sort, group)
      // The value already typed in full needs no suggestion.
      .filter((v) => v.value.toLowerCase() !== typed)
      .map((v) => ({ label: v.label ?? v.value, insert: `${token.facet}:${quoteIfNeeded(v.value)}`, count: v.count }));
    return { items, facet: token.facet, start, end };
  }

  // A word with no colon yet, or nothing typed: offer facet names that start with it. Free text that matches none gets nothing.
  if (raw.includes(":") || raw.startsWith('"')) return none;
  const typed = raw.toLowerCase();
  const items = FACETS.filter((f) => f.name.startsWith(typed) && f.name !== typed).map((f) => ({
    label: `${f.name}:`,
    hint: f.hint,
    insert: `${f.name}:`,
  }));
  return { items, facet: null, start, end };
}

/** `query` with the part `suggestions` points at replaced by the chosen item, and where the caret goes after. */
export function applySuggestion(query: string, suggestions: Suggestions, item: Suggestion): { query: string; caret: number } {
  const after = query.slice(suggestions.end);
  // A finished value gets a space after it so the next word can start. A facet name stays open for its value.
  const tail = item.insert.endsWith(":") ? after : after.startsWith(" ") ? after : ` ${after}`;
  const text = query.slice(0, suggestions.start) + item.insert + tail;
  const caret = suggestions.start + item.insert.length + (item.insert.endsWith(":") ? 0 : 1);
  return { query: text, caret };
}
