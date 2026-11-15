import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import type { Fetch } from "./lm";
import type { Track } from "./types";

const ENDPOINT = "https://lrclib.net/api";
/** LRCLIB asks clients to say what they are. Nothing about the person goes in it. */
const HEADERS = { "User-Agent": "Mixtape/0.1", "Lrclib-Client": "Mixtape/0.1" };
/** The model gets this much; a very long text only fills its memory. */
export const MAX_LYRICS_CHARS = 6000;

export interface Lyrics {
  /** The words, without timestamps. Empty for an instrumental. */
  text: string;
  instrumental: boolean;
  /** The match LRCLIB found, so the person can tell if it was the right song. */
  matched: { title: string; artist: string; album: string };
}

interface LrclibEntry {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/** "[01:23.45] words" lines become "words". */
export function stripTimestamps(synced: string): string {
  return synced
    .split("\n")
    .map((line) => line.replace(/^\s*(\[\d+:\d+(?:[.:]\d+)?\]\s*)+/, "").trimEnd())
    .join("\n")
    .trim();
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function toLyrics(entry: LrclibEntry, track: Track): Lyrics | null {
  const text = entry.plainLyrics?.trim() || (entry.syncedLyrics ? stripTimestamps(entry.syncedLyrics) : "");
  if (!text && !entry.instrumental) return null;
  return {
    text,
    instrumental: !!entry.instrumental,
    matched: { title: entry.trackName ?? track.title, artist: entry.artistName ?? track.artist, album: entry.albumName ?? track.album },
  };
}

/**
 * Lyrics for a song from LRCLIB: an exact match on title, artist, album and length first, then the closest search result.
 * Returns null when it has none. Throws a readable message when the service cannot be reached.
 */
export async function fetchLyrics(track: Track, doFetch: Fetch = httpFetch as Fetch): Promise<Lyrics | null> {
  const get = async (path: string, params: Record<string, string>) => {
    const query = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
    let response;
    try {
      response = await doFetch(`${ENDPOINT}${path}?${query}`, { method: "GET", headers: HEADERS });
    } catch {
      throw new Error("Can't reach the lyrics service (lrclib.net). Check the internet connection.");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The lyrics service answered ${response.status}.`);
    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw new Error("The lyrics service sent an answer that is not JSON.");
    }
  };

  const exact = (await get("/get", {
    track_name: track.title,
    artist_name: track.artist,
    album_name: track.album,
    duration: track.durationMs ? String(Math.round(track.durationMs / 1000)) : "",
  })) as LrclibEntry | null;
  const direct = exact && toLyrics(exact, track);
  if (direct) return direct;

  const found = (await get("/search", { track_name: track.title, artist_name: track.artist })) as LrclibEntry[] | null;
  const wantedSeconds = track.durationMs / 1000;
  const candidates = (Array.isArray(found) ? found : [])
    .filter((e) => norm(e.trackName ?? "") === norm(track.title))
    // A different length is probably a different recording (live, remix).
    .filter((e) => !wantedSeconds || !e.duration || Math.abs(e.duration - wantedSeconds) <= 8)
    .sort((a, b) => Number(!!b.plainLyrics || !!b.syncedLyrics) - Number(!!a.plainLyrics || !!a.syncedLyrics));
  for (const entry of candidates) {
    const lyrics = toLyrics(entry, track);
    if (lyrics) return lyrics;
  }
  return null;
}
