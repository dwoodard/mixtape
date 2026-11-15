import { reactive } from "vue";
import type { TagMatch } from "./musicbrainz";
import type { Track } from "./types";

/** A match must be at least this sure (see TagMatch.confidence) before its genre is even suggested. */
export const MIN_CONFIDENCE = 70;
/** Give up when the service fails this many lookups in a row: it is down, and going on only wastes the person's time. */
const MAX_FAILURES_IN_A_ROW = 3;

const SPECIAL: Record<string, string> = { "r&b": "R&B", "hip hop": "Hip Hop", "hip-hop": "Hip-Hop", edm: "EDM", "k-pop": "K-Pop", "j-pop": "J-Pop", "uk garage": "UK Garage", "post-rock": "Post-Rock", "trip hop": "Trip Hop" };

/** MusicBrainz tags are lower case ("progressive rock"); the library writes genres as titles ("Progressive Rock"). */
export function normalizeGenre(tag: string): string {
  const t = tag.trim().toLowerCase();
  return SPECIAL[t] ?? t.replace(/(^|[\s\-/])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export interface GenreSuggestion {
  track: Track;
  genre: string;
  confidence: number;
  /** Whether it will be written. The person unticks the ones they do not want. */
  include: boolean;
  state: "pending" | "written" | "failed";
  error: string | null;
}

export interface GenreFillState {
  /** idle: not started. looking: asking MusicBrainz. review: suggestions to choose from. writing: saving the chosen ones. done: finished. */
  phase: "idle" | "looking" | "review" | "writing" | "done";
  total: number;
  looked: number;
  /** Songs with no confident match, or a match with no genre. */
  skipped: number;
  error: string | null;
  suggestions: GenreSuggestion[];
  written: number;
  failedWrites: number;
}

/** What the fill needs from the app. */
export interface GenreFillDeps {
  library(): Track[];
  lookup(track: Track): Promise<TagMatch[]>;
  /** Writes the genre into the song's file. Returns what went wrong, or null. */
  write(track: Track, genre: string): Promise<string | null>;
}

export interface GenreFill {
  state: GenreFillState;
  /** How many songs have no genre right now. */
  missingCount(): number;
  start(): Promise<void>;
  /** Stops looking or writing after the song in hand. What has been found stays for review. */
  cancel(): void;
  setInclude(path: string, on: boolean): void;
  setAll(on: boolean): void;
  write(): Promise<void>;
  reset(): void;
}

const fresh = (): GenreFillState => ({ phase: "idle", total: 0, looked: 0, skipped: 0, error: null, suggestions: [], written: 0, failedWrites: 0 });

/**
 * Finds a genre for every song that has none, from MusicBrainz, then lets the person review and write them. It does the
 * slow work one song at a time (the service allows one request a second and a write copies the file), reports as it
 * goes, and can be stopped. Nothing is written until the person asks.
 */
export function createGenreFill(deps: GenreFillDeps): GenreFill {
  const state = reactive<GenreFillState>(fresh());
  let stop = false;

  const missing = () => deps.library().filter((t) => !t.genre.trim() && t.title.trim());

  async function start() {
    if (state.phase === "looking" || state.phase === "writing") return;
    Object.assign(state, fresh());
    const songs = missing();
    state.total = songs.length;
    state.phase = "looking";
    stop = false;
    let failuresInARow = 0;

    for (const track of songs) {
      if (stop) break;
      try {
        const best = (await deps.lookup(track))[0];
        failuresInARow = 0;
        if (best && best.confidence >= MIN_CONFIDENCE && best.genreHint) {
          state.suggestions.push({ track, genre: normalizeGenre(best.genreHint), confidence: best.confidence, include: true, state: "pending", error: null });
        } else {
          state.skipped++;
        }
      } catch (e) {
        state.skipped++;
        if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          state.error = e instanceof Error ? e.message : String(e);
          state.looked++;
          break;
        }
      }
      state.looked++;
    }
    state.phase = "review";
  }

  async function write() {
    if (state.phase !== "review") return;
    state.phase = "writing";
    stop = false;
    for (const s of state.suggestions.filter((x) => x.include && x.state === "pending")) {
      if (stop) break;
      const problem = await deps.write(s.track, s.genre);
      if (problem) {
        s.state = "failed";
        s.error = problem;
        state.failedWrites++;
      } else {
        s.state = "written";
        state.written++;
      }
    }
    state.phase = "done";
  }

  return {
    state,
    missingCount: () => missing().length,
    start,
    cancel: () => {
      stop = true;
    },
    setInclude(path, on) {
      const s = state.suggestions.find((x) => x.track.path === path);
      if (s && s.state === "pending") s.include = on;
    },
    setAll(on) {
      for (const s of state.suggestions) if (s.state === "pending") s.include = on;
    },
    write,
    reset: () => {
      if (state.phase !== "looking" && state.phase !== "writing") Object.assign(state, fresh());
    },
  };
}
