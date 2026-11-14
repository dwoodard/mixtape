// PROTOTYPE (discovery-import): fake import pipeline. No network, no files, nothing real is written.
import { computed, ref } from "vue";
import type { Track } from "../lib/types";

export type Source = "youtube-video" | "youtube-playlist" | "spotify-track" | "spotify-playlist" | "spotify-album" | "unknown";

/** What kind of link was pasted. Real logic, worth keeping if this direction is chosen. */
export function classifyLink(raw: string): { source: Source; id: string | null } {
  const url = raw.trim();
  let m = url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{6,})/i);
  if (m) return { source: "youtube-video", id: m[1] };
  m = url.match(/youtube\.com\/playlist\?(?:.*&)?list=([\w-]+)/i);
  if (m) return { source: "youtube-playlist", id: m[1] };
  m = url.match(/open\.spotify\.com\/(track|playlist|album)\/(\w+)/i);
  if (m) return { source: `spotify-${m[1].toLowerCase()}` as Source, id: m[2] };
  return { source: "unknown", id: null };
}

/** What a user typically copies from YouTube: the video title, then the link. */
export const EXAMPLE = `The Dead South - People Are Strange [Official Music Video]
https://www.youtube.com/watch?v=v4YQJ6KuWvQ`;

/** Splits pasted text into the link and whatever else came with it (usually the video title). */
export function extractLink(text: string): { url: string; hint: string } {
  const m = text.match(/https?:\/\/\S+/i);
  if (!m) return { url: text.trim(), hint: "" };
  return { url: m[0], hint: text.replace(m[0], "").replace(/\s+/g, " ").trim() };
}

const NOISE =
  /\s*[\[(][^\])]*\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|hd|4k|remaster(?:ed)?|music|live|clip)\b[^\])]*[\])]/gi;

/** "The Dead South - People Are Strange [Official Music Video]" -> artist + title. */
export function parseVideoTitle(raw: string): { artist: string; title: string } {
  const cleaned = raw.replace(NOISE, "").replace(/\s*[|｜]\s*.*$/, "").replace(/\s+/g, " ").trim();
  const split = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return split ? { artist: split[1].trim(), title: split[2].trim() } : { artist: "", title: cleaned };
}

/**
 * What YouTube says about a video (the fields yt-dlp reports). The one entry
 * below is the real data fetched for the example video; a real build would
 * fetch this for any link.
 */
export interface VideoMeta {
  channel?: string;
  /** YYYYMMDD. YouTube Music releases carry a true release date. */
  releaseDate?: string;
  /** YYYYMMDD. When the video went up; can be later than the song's release. */
  uploadDate?: string;
  durationSec?: number;
}

export const KNOWN_VIDEOS: Record<string, VideoMeta> = {
  v4YQJ6KuWvQ: { channel: "The Dead South", releaseDate: "20211111", uploadDate: "20211111", durationSec: 193 },
};

const prettyDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Fills in what the YouTube data can tell us, and records where each value came from. */
export function applyVideoMeta(
  parsed: { artist: string; title: string },
  meta: VideoMeta | undefined,
): { year: string; confidence: number; notes: string[]; from: ImportItem["from"] } {
  const notes: string[] = [];
  let confidence = parsed.artist ? 0.5 : 0.3;
  let year = "";
  if (!meta) return { year, confidence, notes, from: "Guessed from the video title" };

  if (meta.channel && parsed.artist && sameName(meta.channel, parsed.artist)) {
    confidence = 0.7;
    notes.push(`Artist matches the channel (${meta.channel}).`);
  } else if (meta.channel && !parsed.artist) {
    notes.push(`Channel is “${meta.channel}”; the title didn't name an artist.`);
  }
  const date = meta.releaseDate ?? meta.uploadDate;
  if (date) {
    year = date.slice(0, 4);
    notes.push(
      meta.releaseDate
        ? `Year ${year} from YouTube's release date (${prettyDate(meta.releaseDate)}).`
        : `Year ${year} is only the upload date (${prettyDate(date)}). The song may be older. Please check.`,
    );
  }
  if (meta.durationSec) {
    notes.push(`Length ${Math.floor(meta.durationSec / 60)}:${String(meta.durationSec % 60).padStart(2, "0")}, usable to check a MusicBrainz match.`);
  }
  return { year, confidence, notes, from: "Video title + YouTube data" };
}

export const SOURCE_LABEL: Record<Source, string> = {
  "youtube-video": "YouTube video",
  "youtube-playlist": "YouTube playlist",
  "spotify-track": "Spotify track",
  "spotify-playlist": "Spotify playlist",
  "spotify-album": "Spotify album",
  unknown: "Unrecognized link",
};

export type Stage = "queued" | "fetching" | "converting" | "ready" | "added";
export const STAGES: Stage[] = ["fetching", "converting", "ready", "added"];
export const STAGE_LABEL: Record<Stage, string> = {
  queued: "Queued",
  fetching: "Fetching audio",
  converting: "Converting (ffmpeg)",
  ready: "Ready to review",
  added: "Added",
};

export interface Proposal {
  title: string;
  artist: string;
  album: string;
  year: string;
  track: string;
  genre: string;
}

export interface ImportBatch {
  id: number;
  /** What was pasted, in words. */
  label: string;
  source: Source;
}

/** A release the (fake) lookup thinks this recording is on. ILLUSTRATIVE demo data, not real MusicBrainz results. */
export interface Candidate {
  id: number;
  album: string;
  year: string;
  track: string;
  kind: "Album" | "Single" | "Compilation" | "Live";
  score: number;
}

export interface ImportItem {
  id: number;
  batchId: number;
  source: Source;
  url: string;
  stage: Stage;
  progress: number;
  proposal: Proposal;
  /** 0-1: how sure the (fake) lookup is. */
  confidence: number;
  from: "MusicBrainz" | "Guessed from the video title" | "Video title + YouTube data";
  duplicateOf: string | null;
  /** The video's own title, when we were given it. */
  videoTitle: string;
  /** Plain-language notes on where tag values came from (and how far to trust them). */
  notes: string[];
  candidates: Candidate[];
  /** The candidate whose album/year/track were applied, if any. */
  chosen: number | null;
  /** Set when the auto-add rule added it (so it can be undone). */
  autoAdded: boolean;
}

export type Format = "mp3 320k" | "m4a (aac)" | "flac";
export const FORMATS: Format[] = ["mp3 320k", "m4a (aac)", "flac"];

const CANNED: Proposal[] = [
  { title: "Without Me", artist: "Eminem", album: "The Eminem Show", year: "2002", track: "9", genre: "Hip-Hop" },
  { title: "Spiderwebs", artist: "No Doubt", album: "Tragic Kingdom", year: "1995", track: "1", genre: "Ska" },
  { title: "Back in Black", artist: "AC/DC", album: "Back in Black", year: "1980", track: "6", genre: "Rock" },
  { title: "My Calling", artist: "AJR", album: "Living Room", year: "2015", track: "5", genre: "Pop" },
  { title: "Houdini", artist: "Eminem", album: "The Death of Slim Shady", year: "2024", track: "1", genre: "Hip-Hop" },
  { title: "Take On Me", artist: "a-ha", album: "Hunting High and Low", year: "1985", track: "2", genre: "Synth-pop" },
];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Mimics a lookup: some links resolve confidently, some only get a guess from the title. */
function fakeProposal(seed: string, index = 0): { proposal: Proposal; confidence: number; from: ImportItem["from"] } {
  const base = CANNED[(hash(seed) + index) % CANNED.length];
  const sure = (hash(seed) + index) % 3 !== 0;
  return sure
    ? { proposal: { ...base }, confidence: 0.92, from: "MusicBrainz" }
    : { proposal: { ...base, album: "", year: "", track: "", genre: "" }, confidence: 0.45, from: "Guessed from the video title" };
}

export interface SpotifyTrack {
  title: string;
  artist: string;
  album: string;
}

/** A fake Spotify playlist: a few real-looking tracks. Ownership is checked against the real library. */
export function fakeSpotifyTracks(id: string): SpotifyTrack[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const p = CANNED[(hash(id) + i) % CANNED.length];
    return { title: p.title, artist: p.artist, album: p.album };
  });
}

const norm = (s: string) => s.trim().toLowerCase();

/** Makes a few plausible releases for a recording: the best guess plus lesser ones. */
function makeCandidates(p: Proposal, year: string, base: number): Candidate[] {
  const y = Number(year) || 2010;
  const real = p.album
    ? { album: p.album, year: p.year || String(y), track: p.track || "1", kind: "Album" as const }
    : { album: `${p.title} (single)`, year: String(y), track: "1", kind: "Single" as const };
  return [
    { id: base + 1, ...real, score: 0.9 },
    { id: base + 2, album: "Greatest Hits Collection", year: String(y + 3), track: "7", kind: "Compilation", score: 0.6 },
    { id: base + 3, album: `Live Session: ${p.artist || "Various"}`, year: String(y + 1), track: "4", kind: "Live", score: 0.4 },
  ];
}

/** An item the user should look at before adding: unsure match, missing tags, or already owned. */
export function needsAttention(item: ImportItem): boolean {
  const p = item.proposal;
  return item.confidence < 0.8 || !p.album || !p.year || item.duplicateOf !== null;
}

/** The library song that is the same recording, if any (read-only use of real data). */
export function findOwned(library: Track[], title: string, artist: string): Track | null {
  return library.find((t) => norm(t.title) === norm(title) && norm(t.artist) === norm(artist)) ?? null;
}

let nextId = 1;

/** The fake pipeline: add links, watch items advance through the stages, add them to the (pretend) library. */
export function createImports(getLibrary: () => Track[]) {
  const items = ref<ImportItem[]>([]);
  const batches = ref<ImportBatch[]>([]);
  const format = ref<Format>("mp3 320k");
  const notice = ref<string | null>(null);
  /** Commit-flow options: auto-add rule, commit tray, and pick-before-fetch. */
  const autoAdd = ref(false);
  const autoThreshold = ref(0.7);
  const tray = ref<number[]>([]);
  const pickFirst = ref(false);
  const pending = ref<{ label: string; tracks: { title: string; artist: string; checked: boolean; url: string; seed: string }[] } | null>(null);
  const spotify = ref<{ source: Source; id: string; tracks: SpotifyTrack[] } | null>(null);

  function advance(item: ImportItem) {
    const timer = setInterval(() => {
      item.progress += 18 + Math.random() * 14;
      if (item.progress >= 100) {
        item.progress = 0;
        if (item.stage === "fetching") item.stage = "converting";
        else if (item.stage === "converting") {
          item.stage = "ready";
          item.progress = 100;
          clearInterval(timer);
          // Auto-add rule (only while that option is on): confident, complete, not already owned.
          if (autoAdd.value && item.confidence >= autoThreshold.value && !needsAttention(item)) {
            item.stage = "added";
            item.autoAdded = true;
          }
        }
      }
    }, 280);
  }

  function newBatch(label: string, source: Source): number {
    const id = nextId++;
    batches.value.push({ id, label, source });
    return id;
  }

  function enqueue(
    source: Source,
    url: string,
    seed: string,
    index = 0,
    batchId = 0,
    given?: { proposal: Proposal; confidence: number; from: ImportItem["from"]; videoTitle: string; notes: string[] },
  ) {
    const { proposal, confidence, from } = given ?? fakeProposal(seed, index);
    const owned = findOwned(getLibrary(), proposal.title, proposal.artist);
    const item: ImportItem = {
      id: nextId++,
      batchId,
      source,
      url,
      stage: "fetching",
      progress: 0,
      proposal,
      confidence,
      from,
      duplicateOf: owned ? owned.path : null,
      videoTitle: given?.videoTitle ?? "",
      notes: given?.notes ?? [],
      candidates: [],
      chosen: null,
      autoAdded: false,
    };
    item.candidates = makeCandidates(item.proposal, item.proposal.year, item.id * 10);
    items.value.push(item);
    advance(items.value[items.value.length - 1]);
    return item;
  }

  /** Returns a message when the link can't be used. */
  function addLink(text: string): string | null {
    const { url: raw, hint } = extractLink(text);
    const { source, id } = classifyLink(raw);
    notice.value = null;
    if (source === "unknown" || !id) return "That doesn't look like a YouTube or Spotify link.";
    if (source === "youtube-video") {
      // With the video title we can make a real guess; without it, fall back to the fake lookup.
      const parsed = hint ? parseVideoTitle(hint) : null;
      const given = parsed
        ? (() => {
            const meta = applyVideoMeta(parsed, KNOWN_VIDEOS[id]);
            return {
              proposal: { title: parsed.title, artist: parsed.artist, album: "", year: meta.year, track: "", genre: "" },
              confidence: meta.confidence,
              from: meta.from,
              videoTitle: hint,
              notes: meta.notes,
            };
          })()
        : undefined;
      enqueue(source, raw, id, 0, newBatch(hint || `YouTube video ${id}`, source), given);
    }
    else if (source === "youtube-playlist") {
      if (pickFirst.value) {
        // Choose before fetching: show the playlist's entries as a checklist.
        pending.value = {
          label: `YouTube playlist ${id.slice(0, 8)}…`,
          tracks: [0, 1, 2, 3].map((i) => {
            const p = fakeProposal(id, i).proposal;
            return { title: p.title, artist: p.artist, checked: true, url: raw, seed: id + i };
          }),
        };
      } else {
        const batch = newBatch(`YouTube playlist ${id.slice(0, 8)}…`, source);
        [0, 1, 2, 3].forEach((i) => enqueue("youtube-video", raw, id, i, batch));
      }
    }
    else if (source === "spotify-track") spotify.value = { source, id, tracks: fakeSpotifyTracks(id).slice(0, 1) };
    else spotify.value = { source, id, tracks: fakeSpotifyTracks(id) };
    return null;
  }

  /** Spotify has no audio to take: find the missing songs elsewhere (here: pretend YouTube). */
  function fetchMissing() {
    if (!spotify.value) return;
    const batch = newBatch(`Missing from ${SOURCE_LABEL[spotify.value.source].toLowerCase()}`, spotify.value.source);
    spotify.value.tracks
      .filter((t) => !findOwned(getLibrary(), t.title, t.artist))
      .forEach((t, i) => enqueue("youtube-video", `https://youtu.be/${t.title}`, t.title + t.artist, i, batch));
  }

  /** Fetch only the ticked entries of a pending playlist. */
  function fetchPending() {
    if (!pending.value) return;
    const batch = newBatch(pending.value.label, "youtube-playlist");
    pending.value.tracks.forEach((t, i) => t.checked && enqueue("youtube-video", t.url, t.seed, i, batch));
    pending.value = null;
  }

  /** Choose a release: applies its album, year and track to the tags. */
  function chooseCandidate(item: ImportItem, c: Candidate) {
    item.chosen = c.id;
    item.proposal.album = c.album;
    item.proposal.year = c.year;
    item.proposal.track = c.track;
    item.confidence = Math.max(item.confidence, c.score >= 0.9 ? 0.9 : item.confidence);
  }

  /** Tray: stage items, then commit them together. */
  const stage = (item: ImportItem) => item.stage === "ready" && !tray.value.includes(item.id) && tray.value.push(item.id);
  const unstage = (item: ImportItem) => (tray.value = tray.value.filter((i) => i !== item.id));
  const staged = computed(() => items.value.filter((i) => tray.value.includes(i.id) && i.stage === "ready"));
  function commitTray() {
    staged.value.forEach((i) => (i.stage = "added"));
    tray.value = [];
  }
  const undoAuto = (item: ImportItem) => {
    if (item.autoAdded) {
      item.stage = "ready";
      item.autoAdded = false;
    }
  };
  const autoAddedList = computed(() => items.value.filter((i) => i.autoAdded && i.stage === "added"));

  const missing = computed(() =>
    spotify.value ? spotify.value.tracks.filter((t) => !findOwned(getLibrary(), t.title, t.artist)) : [],
  );
  const ready = computed(() => items.value.filter((i) => i.stage === "ready"));
  const added = computed(() => items.value.filter((i) => i.stage === "added"));

  function addToLibrary(item: ImportItem) {
    if (item.stage === "ready") item.stage = "added";
  }
  const addAllReady = () => ready.value.forEach(addToLibrary);
  const remove = (item: ImportItem) => (items.value = items.value.filter((i) => i !== item));
  const reset = () => {
    items.value = [];
    tray.value = [];
    pending.value = null;
    batches.value = [];
    spotify.value = null;
    notice.value = null;
  };

  /** Where the file would land, to show the structure the library keeps. */
  const destination = (item: ImportItem) => {
    const p = item.proposal;
    const ext = format.value.startsWith("mp3") ? "mp3" : format.value.startsWith("m4a") ? "m4a" : "flac";
    const track = p.track ? `${p.track.padStart(2, "0")} ` : "";
    return `${p.artist || "Unknown Artist"}/${p.album || "Unknown Album"}/${track}${p.title || "Untitled"}.${ext}`;
  };

  /** Does the library already have this artist / this album? (read-only use of real data) */
  const library = {
    hasArtist: (artist: string) => getLibrary().some((t) => norm(t.artist) === norm(artist) || norm(t.albumArtist) === norm(artist)),
    hasAlbum: (artist: string, album: string) =>
      getLibrary().some((t) => (norm(t.artist) === norm(artist) || norm(t.albumArtist) === norm(artist)) && norm(t.album) === norm(album)),
  };

  return { items, batches, library, format, autoAdd, autoThreshold, tray, staged, stage, unstage, commitTray, undoAuto, autoAddedList, pickFirst, pending, fetchPending, chooseCandidate, notice, spotify, missing, ready, added, addLink, fetchMissing, addToLibrary, addAllReady, remove, reset, destination };
}

export type Imports = ReturnType<typeof createImports>;
