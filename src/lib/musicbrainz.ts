import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import type { Fetch } from "./lm";
import type { Track } from "./types";

const ENDPOINT = "https://musicbrainz.org/ws/2/recording";
/** MusicBrainz wants the client named. Nothing about the person goes in it. */
const HEADERS = { "User-Agent": "Mixtape/0.1", Accept: "application/json" };
/** MusicBrainz allows one request a second per client. */
const MIN_GAP_MS = 1100;
const RETRY_AFTER_MS = 2500;
const SEARCH_LIMIT = 25;
const SHOWN = 5;

/** One way a song could be tagged, from MusicBrainz (the database Picard uses). */
export interface TagMatch {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: string;
  trackNumber: string;
  discNumber: string;
  /** The most voted tag. Only a hint: genre tags there are loose. */
  genreHint: string;
  /** What kind of release: "Album", "Single", "Live", "Compilation"... */
  releaseKind: string;
  /** Our own ranking, 0 to 100. */
  confidence: number;
  /** Why it ranked as it did, in words. */
  reasons: string[];
}

interface Release {
  title?: string;
  status?: string;
  date?: string;
  "artist-credit"?: { name?: string }[];
  "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
  media?: { position?: number; track?: { number?: string }[] }[];
}
interface Recording {
  score?: number;
  title?: string;
  length?: number;
  disambiguation?: string;
  "artist-credit"?: { name?: string }[];
  "first-release-date"?: string;
  releases?: Release[];
  tags?: { name: string; count?: number }[];
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const credit = (list?: { name?: string }[]) => (list ?? []).map((c) => c.name ?? "").join("").trim();
const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

const isLive = (r: Recording, release?: Release) =>
  /\blive\b/i.test(r.disambiguation ?? "") || !!release?.["release-group"]?.["secondary-types"]?.includes("Live");
const isCompilation = (release?: Release) => !!release?.["release-group"]?.["secondary-types"]?.includes("Compilation");

/** The release of a recording that best fits the file: its own album first, then an official studio album, the earliest. */
function bestRelease(releases: Release[], album: string): Release | undefined {
  const rank = (r: Release) =>
    (album && norm(r.title ?? "") === norm(album) ? 100 : 0) +
    (r.status === "Official" ? 10 : 0) +
    (r["release-group"]?.["primary-type"] === "Album" ? 5 : 0) -
    ((r["release-group"]?.["secondary-types"]?.length ?? 0) > 0 ? 20 : 0);
  return [...releases].sort((a, b) => rank(b) - rank(a) || (a.date || "9999").localeCompare(b.date || "9999"))[0];
}

function toMatch(r: Recording, track: Track): TagMatch {
  const release = bestRelease(r.releases ?? [], track.album);
  const media = release?.media?.[0];
  const number = media?.track?.[0]?.number ?? "";
  const reasons: string[] = [];
  let confidence = r.score ?? 0;

  if (track.durationMs && r.length && Math.abs(r.length - track.durationMs) <= 6000) {
    confidence += 40;
    reasons.push("same length");
  } else if (track.durationMs && r.length) {
    confidence -= 10;
    reasons.push("different length");
  }
  if (track.album && release && norm(release.title ?? "") === norm(track.album)) {
    confidence += 40;
    reasons.push("same album");
  }
  if (isLive(r, release)) {
    confidence -= 30;
    reasons.push("live recording");
  }
  if (isCompilation(release)) {
    confidence -= 15;
    reasons.push("compilation");
  }
  if (release?.status === "Official") confidence += 5;

  const tag = [...(r.tags ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]?.name ?? "";
  const kind = release?.["release-group"]?.["secondary-types"]?.[0] ?? release?.["release-group"]?.["primary-type"] ?? "";
  return {
    title: r.title ?? track.title,
    artist: credit(r["artist-credit"]) || track.artist,
    album: release?.title ?? "",
    albumArtist: credit(release?.["artist-credit"]),
    year: (release?.date || r["first-release-date"] || "").slice(0, 4),
    trackNumber: /^\d+$/.test(number) ? number : "",
    discNumber: media?.position ? String(media.position) : "",
    genreHint: tag,
    releaseKind: kind,
    confidence: Math.max(0, Math.min(100, Math.round(confidence / 1.85))),
    reasons,
  };
}

let lastCall = 0;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Looks a song up on MusicBrainz by title and artist (Picard's own database) and ranks the matches by how well they fit
 * the file: its length, its album, and not a live version or compilation. Best first. Empty when nothing fits.
 * Throws a readable message when the service cannot be reached.
 */
export async function lookupTags(track: Track, doFetch: Fetch = httpFetch as Fetch, sleep: (ms: number) => Promise<void> = wait): Promise<TagMatch[]> {
  if (!track.title.trim()) throw new Error("The song has no title to look up.");
  const terms = [`recording:${quote(track.title)}`];
  if (track.artist.trim()) terms.push(`artist:${quote(track.artist)}`);
  const url = `${ENDPOINT}?${new URLSearchParams({ query: terms.join(" AND "), limit: String(SEARCH_LIMIT), fmt: "json" })}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const gap = lastCall + MIN_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    let response;
    try {
      response = await doFetch(url, { method: "GET", headers: HEADERS });
    } catch {
      throw new Error("Can't reach MusicBrainz (musicbrainz.org). Check the internet connection.");
    }
    // Busy: it sheds load now and then. One more try after a pause.
    if ((response.status === 503 || response.status === 429) && attempt === 0) {
      await sleep(RETRY_AFTER_MS);
      continue;
    }
    if (!response.ok) throw new Error(response.status === 503 || response.status === 429 ? "MusicBrainz is busy. Try again in a minute." : `MusicBrainz answered ${response.status}.`);
    let data: { recordings?: Recording[] };
    try {
      data = JSON.parse(await response.text());
    } catch {
      throw new Error("MusicBrainz sent an answer that is not JSON.");
    }
    const seen = new Set<string>();
    return (data.recordings ?? [])
      .filter((r) => r.title && norm(r.title) === norm(track.title))
      .map((r) => toMatch(r, track))
      .sort((a, b) => b.confidence - a.confidence)
      .filter((m) => {
        const key = `${norm(m.artist)}|${norm(m.title)}|${norm(m.album)}`;
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .slice(0, SHOWN);
  }
  throw new Error("MusicBrainz is busy. Try again in a minute.");
}

/** Only for tests: lets each test start without waiting out the previous one's one-second gap. */
export function resetMusicBrainzClock() {
  lastCall = 0;
}
