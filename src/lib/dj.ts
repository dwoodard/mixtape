import type { ChatMessage, LmClient, ToolCall, ToolSpec } from "./lm";
import type { DuplicateGroup } from "./duplicates";
import type { Lyrics } from "./lyrics";
import type { GenreFill } from "./genreFill";
import type { ReleaseInfo, TagMatch } from "./musicbrainz";
import type { TagEditPayload } from "./tagEdit";
import { TOOLS_TABLE } from "./djTools";
import type { CleanupReport, FileCheck, ImportItem, PlayerState, PlayStat, Repeat, TagsPatch, Track, WindowMode } from "./types";

/** An error message when the app could not do it, or null when it did. */
export type Problem = string | null;

/** Everything the DJ may do to the app: the same things a person can do with the mouse and keyboard. */
export interface DjHost {
  // What is there.
  library(): Track[];
  queue(): Track[];
  player(): PlayerState;
  imports(): ImportItem[];
  /** How often each song was played, by file path. Songs never played are missing. */
  plays(): Record<string, PlayStat>;
  /** The songs picked in the song list on screen. */
  selection(): Track[];
  /** What the window is showing now. */
  screen(): { tab: string; libraryView: string; filter: string; windowMode: string };
  duplicateGroups(): DuplicateGroup[];
  // Queue and playback.
  startQueue(tracks: Track[]): Promise<void>;
  addToQueue(tracks: Track[], where: "end" | "next"): Promise<void>;
  playNow(track: Track): Promise<void>;
  clearQueue(): Promise<void>;
  removeFromQueue(index: number): Promise<void>;
  removeFromQueueDown(index: number): Promise<void>;
  moveInQueue(from: number, to: number): Promise<void>;
  playQueueIndex(index: number): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(repeat: Repeat): Promise<void>;
  toggle(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  // Library.
  refreshLibrary(): Promise<Problem>;
  /** Loads the music folder saved in Settings, replacing the library on screen. */
  loadSavedFolder(): Promise<Problem>;
  restoreRemoved(): Promise<Problem>;
  removeFromLibrary(tracks: Track[]): Promise<Problem>;
  /** The songs of `tracks` that have no cover picture, in their tags or in their folder. */
  withoutCover(tracks: Track[]): Promise<Track[]>;
  /** Compares a song's file with the length the library holds for it. */
  inspectFile(track: Track): Promise<FileCheck>;
  /** The lyrics saved in the song's own tags, or null when it has none. */
  readLyrics(track: Track): Promise<string | null>;
  /** Corrects the length the library holds for a song. */
  fixLength(track: Track, lengthMs: number): Promise<Problem>;
  trashDuplicates(extras: Track[]): Promise<{ report: CleanupReport | null; problem: Problem }>;
  writeTags(tracks: Track[], edit: TagEditPayload): Promise<{ saved: number; failed: string[]; problem: Problem }>;
  reveal(tracks: Track[]): Promise<Problem>;
  /** Opens a web page in the browser (MusicBrainz or LRCLIB only). */
  openLink(url: string): Promise<Problem>;
  openInPicard(tracks: Track[]): Promise<Problem>;
  /** Re-reads the folders of songs sent to Picard, so the library shows what Picard saved. */
  refreshPicardChanges(): Promise<Problem>;
  /** Lyrics for a song from the web (LRCLIB). Null when none were found. */
  fetchLyrics(track: Track): Promise<Lyrics | null>;
  /** Ways to tag a song, from MusicBrainz (Picard's database), best first. */
  lookupTags(track: Track): Promise<TagMatch[]>;
  /** The job that fills in missing genres. One for the whole chat, so closing a card does not lose its progress. */
  genreFill(): GenreFill;
  /** The details of one MusicBrainz release, to show beside a tag match. */
  fetchRelease(releaseId: string): Promise<ReleaseInfo>;
  // Discovery.
  importLink(url: string, format?: string): Promise<Problem>;
  importFiles(paths: string[]): Promise<{ added: number; problem: Problem }>;
  setImportTags(id: number, patch: TagsPatch): Promise<Problem>;
  addImport(id: number): Promise<Problem>;
  undoImport(id: number): Promise<Problem>;
  openImportInPicard(id: number): Promise<Problem>;
  cancelImportPicard(id: number): Promise<Problem>;
  removeImport(id: number): Promise<Problem>;
  /** Starts fetching songs held back from a playlist: these ids, or all of them when null. */
  fetchImports(ids: number[] | null): Promise<{ started: number; problem: Problem }>;
  setImportOptions(options: { format?: string; autoAdd?: boolean; threshold?: string }): void;
  // Events: rules that have the DJ act when something happens to the queue.
  eventRules(): { attached: boolean; rules: { event: string; prompt: string; enabled: boolean }[] };
  /** Opens the DJ panel on its Events view. */
  showEvents(): void;
  addEventRule(event: string, prompt: string): void;
  /** `index` counts from 0. */
  setEventRuleEnabled(index: number, enabled: boolean): void;
  removeEventRule(index: number): void;
  setEventsAttached(on: boolean): void;
  // The app itself.
  setTheme(theme: string): void;
  setAccent(accent: string): void;
  showTab(tab: string, view?: string): void;
  showInLibrary(track: Track): void;
  setWindowMode(mode: WindowMode): Promise<void>;
  quit(): Promise<void>;
}

/** What the chat can draw for the person, with controls, for the kind of thing being talked about. */
export type DjView =
  | { kind: "songs"; title: string; songs: Track[]; total: number; note?: string; /** The song playing now, marked in the list. */ currentPath?: string }
  | { kind: "tags"; song: Track; matches: TagMatch[] }
  | { kind: "filecheck"; song: Track; check: FileCheck }
  | { kind: "genres"; job: GenreFill }
  | { kind: "lyrics"; song: Track; text: string; instrumental: boolean; /** The song the lyrics service matched, which may not be exactly yours. */ matched?: { title: string; artist: string; album: string }; /** Where the lyrics came from. */ source?: string; /** Whether they are saved in the song's own tags. */ saved?: boolean }
  | { kind: "duplicates"; groups: { keep: Track; extras: Track[] }[] }
  | { kind: "imports"; ids: number[] };

/** A tool's answer for the model, a short line for the person watching, and optionally something to show them. */
export interface ToolOutcome {
  result: unknown;
  note: string;
  view?: DjView;
}

export interface ToolContext {
  host: DjHost;
  session: DjSession;
}

export interface DjTool {
  spec: ToolSpec;
  /** What to ask the person before running this call, or null when it can run freely. */
  risky?: (args: Record<string, unknown>, ctx: ToolContext) => string | null;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

const MAX_ROUNDS = 10;

const CARD_NOTE = "The user is already looking at a card with these results and its controls. Do not list, repeat or describe them. Reply with nothing, or one short sentence about something the card does not show.";
/** After a card, only a short plain word is kept: a list or a paragraph is the card read back. */
const MAX_AFTER_CARD = 160;
const isReadBack = (text: string) => text.length > MAX_AFTER_CARD || /\n/.test(text.trim());

export const TOOLS: ToolSpec[] = TOOLS_TABLE.map((t) => t.spec);

const countBy = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/** The instructions for the model, with a short sketch of the library so it knows what to search for. */
export function systemPrompt(library: Track[]): string {
  const tagged = library.filter((t) => t.genre).length;
  const dated = library.filter((t) => t.year).length;
  const genres = countBy(library.map((t) => t.genre)).slice(0, 15).map(([g, n]) => `${g} (${n})`);
  const artists = countBy(library.map((t) => t.albumArtist || t.artist)).slice(0, 30).map(([a, n]) => `${a} (${n})`);
  return [
    "You are the DJ of Mixtape, a Mac music player, and you work the app for the user. You can do everything they can do by hand:",
    "- Queue and playback: build a queue, add songs, play one now, reorder, remove, clear, play/pause/skip, seek, volume, shuffle, repeat.",
    "- Library: search it, rescan or load the saved music folder, hide songs, find and trash duplicate copies, show a song in Finder or in the list.",
    "- Tags and info: look up the right tags on MusicBrainz (the database Picard uses) and write them, edit tags by hand, open songs in Picard, fetch lyrics.",
    "- Discovery: bring in new songs from a YouTube link or audio files, fix their tags, add them to the library, undo.",
    "- The app: change theme and accent, switch screens, switch between the large window and thin bar, quit.",
    "If asked what you can do, answer in plain words grouped like this, with an example or two. Do not list tool names.",
    "Every message ends with a Context block: what is playing, what is selected, what is on screen, the queue and Discovery. Read it before you answer.",
    "'this song', 'it' or 'the current song' means the song playing now. 'these' or 'the selected songs' means the selection. If the message refers to a song and both are empty, ask which song, once.",
    "Never show the user the Context block, ids or tool names: they are for you. Speak about songs by title and artist.",
    "Play counts are kept by the app. Use the History line in Context or get_play_count to answer how often a song was played. Counting began when the feature was added, so older listening is not in it. 'Most played' and 'never played' searches use search_library.",
    "To fill in missing genres for many songs, call suggest_genres. It runs in the background and the user reviews and writes the results on the card, so do not list the songs or promise it is done.",
    "Lyrics: get_lyrics shows them (from the song's own tags if saved there, else from LRCLIB). The user can save them into the song's tags (ID3 and the other formats) with the card's button, or you can with save_lyrics. Never say you cannot store lyrics in a song's tags: you can.",
    "If a song's length looks wrong to you or the user, call check_file: it compares the library's length with what the file really plays for. If it says the length is wrong, call fix_length. Say what you found in plain words.",
    "Never describe a MusicBrainz match or its genre suggestion as the song's own tags. A genre suggestion is only a suggestion: say 'MusicBrainz suggests …' and that it is not in the file. When you show a song's tags, give what Context says it has now, and mark anything empty as empty.",
    "The Context block gives the tags the playing song has now. To show or check a song's current tags, read them from there. Use lookup_tags only to find what the tags should be.",
    "Songs in the Context block already have ids: use them directly. For any other song, call search_library first and use the ids it returns. Never invent ids, titles or artists. Queue positions are numbered from 1.",
    "Most songs have no genre tag, and none has a mood. For a style, era or mood ('80s synth-pop', 'chill', 'workout'), do not search by genre words. Search the era with year_from and year_to (or '80s' in the query) and a limit of 50 to 100, then choose the songs that fit by what you know of the artists and titles. Also try artists you know fit. Never answer 'none found' after one genre search.",
    "When asked to queue 'some' songs without a number, queue 10 to 15 if the library has that many that fit.",
    "To build a set, search a few times (different genres, artists or years), pick songs that flow well together, and call start_queue (new queue) or add_to_queue (keep the current queue).",
    "Some actions change or delete files. The app asks the user first, so just call the tool. If the user says no, do not retry.",
    "If a search finds nothing, try broader words. If the library has nothing that fits, say so plainly.",
    "Searches, the queue, play counts, tag matches, lyrics, duplicates, Discovery items and file checks are shown to the user as cards under your action. The card already has the songs, numbers and controls, so never repeat or list what a card shows, and never describe the card. After a card, say nothing at all unless you have something the card does not show (why you picked these songs, what you suggest next), and then one short sentence.",
    "When you act without a card, answer in one short sentence: what you did and why. Do not list every song.",
    `The library has ${library.length} songs. ${tagged} have a genre tag and ${dated} have a year.`,
    genres.length ? `Most common genres: ${genres.join(", ")}.` : "",
    artists.length ? `Most common artists: ${artists.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const brief = (t: Track, id: number) => `[${id}] "${t.title}" by ${t.artist || "unknown artist"}${t.album ? ` (${t.album}${t.year ? `, ${t.year}` : ""})` : ""}`;
const SHOWN_SELECTED = 10;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "played 3 times, last on 2026-11-14" or "never played". */
export const playsText = (stat?: PlayStat) =>
  stat && stat.count > 0 ? `played ${stat.count} time${stat.count === 1 ? "" : "s"}, last on ${day(stat.lastPlayedMs)}` : "never played";
const blank = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "(empty)" : String(v));
/** Every tag the editor can change, as the file has it now. */
const tagsOf = (t: Track) =>
  `title ${blank(t.title)}, artist ${blank(t.artist)}, album ${blank(t.album)}, album artist ${blank(t.albumArtist)}, track ${blank(t.trackNumber)}, disc ${blank(t.discNumber)}, year ${blank(t.year)}, genre ${blank(t.genre)}`;

/** What is going on in the app right now, for the end of each message. Songs in it get ids the model can use directly. */
export function contextNote(host: DjHost, session: DjSession): string {
  const player = host.player();
  const lines: string[] = ["Context (the app as it is now, not part of the user's message):"];

  lines.push(
    player.currentTrack
      ? `- Playing: ${brief(player.currentTrack, session.idFor(player.currentTrack))}, ${player.status}, at ${clock(player.positionMs)} of ${clock(player.durationMs)}\n  History: ${playsText(host.plays()[player.currentTrack.path])}\n  Its tags now: ${tagsOf(player.currentTrack)}`
      : "- Playing: nothing",
  );

  const selected = host.selection();
  lines.push(
    selected.length === 0
      ? "- Selected in the song list: nothing"
      : `- Selected in the song list (${selected.length}): ${selected.slice(0, SHOWN_SELECTED).map((t) => brief(t, session.idFor(t))).join("; ")}${selected.length > SHOWN_SELECTED ? `; and ${selected.length - SHOWN_SELECTED} more` : ""}`,
  );

  const queue = host.queue();
  lines.push(
    `- Queue: ${queue.length} song${queue.length === 1 ? "" : "s"}${player.currentIndex === null ? "" : `, playing number ${player.currentIndex + 1}`}; shuffle ${player.shuffle ? "on" : "off"}, repeat ${player.repeat}, volume ${Math.round(player.volume * 100)}%`,
  );

  const screen = host.screen();
  lines.push(
    `- Screen: ${screen.windowMode} window, ${screen.tab} tab${screen.tab === "player" ? `, library view ${screen.libraryView}${screen.filter ? `, filter "${screen.filter}"` : ""}` : ""}`,
  );

  const imports = host.imports();
  if (imports.length) {
    const byStage = new Map<string, number>();
    for (const i of imports) byStage.set(i.stage, (byStage.get(i.stage) ?? 0) + 1);
    lines.push(`- Discovery: ${[...byStage].map(([s, n]) => `${n} ${s}`).join(", ")}`);
  }
  lines.push(`- Library: ${host.library().length} songs`);
  return lines.join("\n");
}

/** One chat's worth of state the tools need: the short ids the model uses for songs. */
export class DjSession {
  private byId = new Map<number, Track>();
  private byPath = new Map<string, number>();

  /**
   * `live` gives a song as the library has it now. Songs are remembered from earlier in the chat, and their tags may
   * have been edited since (by hand, in Picard, by an Apply): working from the old ones would skip or repeat changes.
   */
  constructor(private live: (track: Track) => Track = (t) => t) {}

  idFor(track: Track): number {
    let id = this.byPath.get(track.path);
    if (id === undefined) {
      id = this.byPath.size + 1;
      this.byPath.set(track.path, id);
      this.byId.set(id, track);
    }
    return id;
  }

  resolve(ids: unknown): { tracks: Track[]; unknown: number[] } {
    const list = Array.isArray(ids) ? ids : [];
    const tracks: Track[] = [];
    const unknown: number[] = [];
    for (const raw of list) {
      const track = this.byId.get(Number(raw));
      if (track) tracks.push(this.live(track));
      else unknown.push(Number(raw));
    }
    return { tracks, unknown };
  }
}

/** Runs one tool call. Problems come back as a result the model can read and fix, never as a throw. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  host: DjHost,
  session: DjSession,
  approve: (question: string) => Promise<boolean> = async () => false,
): Promise<ToolOutcome> {
  const tool = TOOLS_TABLE.find((t) => t.spec.function.name === name);
  if (!tool) {
    const error = `There is no tool called ${name}.`;
    return { result: { error }, note: error };
  }
  const ctx = { host, session };
  const question = tool.risky?.(args, ctx) ?? null;
  if (question !== null && !(await approve(question))) {
    return { result: { error: "The user said no. Do not try again unless they ask." }, note: `Declined: ${question}` };
  }
  return tool.run(args, ctx);
}

function parseArguments(call: ToolCall): Record<string, unknown> | null {
  if (!call.function.arguments.trim()) return {};
  try {
    const parsed = JSON.parse(call.function.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Sends the conversation to the model and carries out the tools it asks for, until it answers in words.
 * `history` is extended in place with every message of the turn. `onNote` hears each action as it happens.
 */
export async function runTurn(
  client: LmClient,
  model: string,
  history: ChatMessage[],
  host: DjHost,
  session: DjSession,
  onNote: (note: string, view?: DjView) => void,
  approve?: (question: string) => Promise<boolean>,
): Promise<string> {
  /** Whether the person has been shown a card this turn: then an empty answer is fine, they already have what they asked for. */
  let shown = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await client.complete(model, history, TOOLS);
    history.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined });
    if (reply.toolCalls.length === 0) {
      if (shown) return isReadBack(reply.content) ? "" : reply.content;
      return reply.content || "Done.";
    }
    for (const call of reply.toolCalls) {
      const args = parseArguments(call);
      let outcome: ToolOutcome;
      if (args === null) outcome = { result: { error: "The arguments were not a JSON object." }, note: `Bad arguments for ${call.function.name}` };
      else {
        try {
          outcome = await runTool(call.function.name, args, host, session, approve);
        } catch (e) {
          outcome = { result: { error: String(e) }, note: `${call.function.name} failed: ${String(e)}` };
        }
      }
      if (outcome.view) shown = true;
      onNote(outcome.note, outcome.view);
      // A model follows what a result says: tell it the person already has the card, so it does not read it back.
      const result = outcome.view && outcome.result && typeof outcome.result === "object" ? { ...outcome.result, shown_to_user: CARD_NOTE } : outcome.result;
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "I stopped after too many steps. Check the queue and tell me what to change.";
}
