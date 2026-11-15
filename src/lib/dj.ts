import type { ChatMessage, LmClient, ToolCall, ToolSpec } from "./lm";
import type { DuplicateGroup } from "./duplicates";
import type { TagEditPayload } from "./tagEdit";
import { TOOLS_TABLE } from "./djTools";
import type { CleanupReport, ImportItem, PlayerState, Repeat, TagsPatch, Track, WindowMode } from "./types";

/** An error message when the app could not do it, or null when it did. */
export type Problem = string | null;

/** Everything the DJ may do to the app: the same things a person can do with the mouse and keyboard. */
export interface DjHost {
  // What is there.
  library(): Track[];
  queue(): Track[];
  player(): PlayerState;
  imports(): ImportItem[];
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
  trashDuplicates(extras: Track[]): Promise<{ report: CleanupReport | null; problem: Problem }>;
  writeTags(tracks: Track[], edit: TagEditPayload): Promise<{ saved: number; failed: string[]; problem: Problem }>;
  reveal(tracks: Track[]): Promise<Problem>;
  openInPicard(tracks: Track[]): Promise<Problem>;
  // Discovery.
  importLink(url: string, format?: string): Promise<Problem>;
  importFiles(paths: string[]): Promise<{ added: number; problem: Problem }>;
  setImportTags(id: number, patch: TagsPatch): Promise<Problem>;
  addImport(id: number): Promise<Problem>;
  undoImport(id: number): Promise<Problem>;
  removeImport(id: number): Promise<Problem>;
  setImportOptions(options: { format?: string; autoAdd?: boolean; threshold?: string }): void;
  // The app itself.
  setTheme(theme: string): void;
  setAccent(accent: string): void;
  showTab(tab: string, view?: string): void;
  showInLibrary(track: Track): void;
  setWindowMode(mode: WindowMode): Promise<void>;
  quit(): Promise<void>;
}

/** A tool's answer for the model, and a short line for the person watching. */
export interface ToolOutcome {
  result: unknown;
  note: string;
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

export const TOOLS: ToolSpec[] = TOOLS_TABLE.map((t) => t.spec);

const countBy = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/** The instructions for the model, with a short sketch of the library so it knows what to search for. */
export function systemPrompt(library: Track[]): string {
  const genres = countBy(library.map((t) => t.genre)).slice(0, 15).map(([g, n]) => `${g} (${n})`);
  const artists = countBy(library.map((t) => t.albumArtist || t.artist)).slice(0, 30).map(([a, n]) => `${a} (${n})`);
  return [
    "You are the DJ of Mixtape, a music player. You can do everything the user can do in the app: build and run the queue, control playback, search and manage the library, fix tags, find duplicates, bring in new songs from links (Discovery), and change the look of the app.",
    "You cannot see the library. Always call search_library to find songs, then use the ids it returns. Never invent ids, titles or artists. Queue positions are numbered from 1 as get_queue shows them.",
    "To build a set, search a few times (different genres, artists or years), pick songs that flow well together, and call start_queue (new queue) or add_to_queue (keep the current queue).",
    "Some actions change or delete files. The app asks the user first, so just call the tool. If the user says no, do not retry.",
    "If a search finds nothing, try broader words. If the library has nothing that fits, say so plainly.",
    "After acting, answer in one or two short sentences: what you did and why. Do not list every song.",
    `The library has ${library.length} songs.`,
    genres.length ? `Most common genres: ${genres.join(", ")}.` : "",
    artists.length ? `Most common artists: ${artists.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

/** One chat's worth of state the tools need: the short ids the model uses for songs. */
export class DjSession {
  private byId = new Map<number, Track>();
  private byPath = new Map<string, number>();

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
      if (track) tracks.push(track);
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
  onNote: (note: string) => void,
  approve?: (question: string) => Promise<boolean>,
): Promise<string> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await client.complete(model, history, TOOLS);
    history.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined });
    if (reply.toolCalls.length === 0) return reply.content || "Done.";
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
      onNote(outcome.note);
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.result) });
    }
  }
  return "I stopped after too many steps. Check the queue and tell me what to change.";
}
