import { ref } from "vue";
import { tauriApi, type Api } from "./api";
import { contextNote, DjSession, type DjView, runTurn, systemPrompt, type DjHost, type Problem } from "./dj";
import { createLmClient, DEFAULT_LM_ENDPOINT, type ChatMessage, type LmClient } from "./lm";
import { fetchLyrics } from "./lyrics";
import { createGenreFill } from "./genreFill";
import { fetchRelease, lookupTags } from "./musicbrainz";
import { THRESHOLDS, type Imports } from "./imports";
import type { Track } from "./types";
import { imports as appImports, store as appStore, type Store } from "./store";
import { setAccent, setTheme } from "./themes";
import type { TagWriteResult } from "./types";
import { appMode, libraryQuery, libraryView, openDjPanel, persistedFlag, selectedSongs, setAppMode, showInLibrary, type AppMode, type LibraryView } from "./ui";

/** What the chat window shows: the person's words, the DJ's words, and each thing the DJ did. */
export interface ChatLine {
  kind: "user" | "dj" | "action" | "error";
  text: string;
  /** Something drawn under an action, with controls. */
  view?: DjView;
}

interface TextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ENDPOINT_KEY = "mixtape.dj.endpoint";
const MODEL_KEY = "mixtape.dj.model";

function persistedText(key: string, fallback: string, storage?: TextStorage) {
  const backing = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  let initial = fallback;
  try {
    initial = backing?.getItem(key) ?? fallback;
  } catch {
    // Storage can throw; keep the fallback.
  }
  const text = ref(initial);
  const set = (next: string) => {
    text.value = next;
    try {
      backing?.setItem(key, next);
    } catch {
      // Not being able to remember is fine.
    }
  };
  return { text, set };
}

/** Wires the DJ to the real app: the same store, import list and settings the buttons use. */
export function hostFor(store: Store, api: Api, imports: Imports): DjHost {
  /** Runs a store action that reports trouble through `libraryError` and returns that trouble. */
  const soft = async (action: () => Promise<unknown>): Promise<Problem> => {
    store.libraryError.value = null;
    try {
      await action();
    } catch (e) {
      return String(e);
    }
    return store.libraryError.value;
  };
  const guard = async (action: () => Promise<unknown>): Promise<Problem> => {
    try {
      await action();
      return null;
    } catch (e) {
      return String(e);
    }
  };
  const importProblem = async (id: number, action: () => Promise<unknown>): Promise<Problem> => {
    const problem = await guard(action);
    return problem ?? imports.itemErrors.value[id] ?? null;
  };

  const writeTags: DjHost["writeTags"] = async (tracks, edit) => {
    store.tagResults.value = null;
    const problem = await soft(() => store.writeTags(tracks, edit));
    const results = (store.tagResults.value as TagWriteResult[] | null) ?? [];
    return {
      saved: results.filter((r) => r.track).length,
      failed: results.filter((r) => r.error).map((r) => `${r.path}: ${r.error}`),
      problem,
    };
  };

  // One job for the whole chat, so closing a card or the panel does not lose its progress.
  const genreFill = createGenreFill({
    library: () => store.library.value,
    lookup: (track) => lookupTags(track),
    write: async (track, genre) => {
      const out = await writeTags([track], { genre });
      return out.problem ?? out.failed[0] ?? null;
    },
  });

  return {
    library: () => store.library.value,
    queue: () => store.queue.value,
    player: () => store.player.value,
    imports: () => imports.items.value,
    plays: () => store.plays.value,
    selection: () => selectedSongs.value,
    screen: () => ({ tab: appMode.value, libraryView: libraryView.value, filter: libraryQuery.value, windowMode: store.mode.value ?? "large" }),
    duplicateGroups: () => store.duplicateGroups.value,
    startQueue: (tracks) => api.playTracks(tracks, 0),
    addToQueue: (tracks, where) => (where === "next" ? api.enqueueNext(tracks) : api.enqueue(tracks)),
    playNow: (track) => store.playNow(track),
    clearQueue: () => api.clearQueue(),
    removeFromQueue: (index) => api.removeFromQueue(index),
    removeFromQueueDown: (index) => api.removeFromQueueDown(index),
    moveInQueue: (from, to) => api.moveQueueTrack(from, to),
    playQueueIndex: (index) => api.playIndex(index),
    setShuffle: (on) => api.setShuffle(on),
    setRepeat: (repeat) => api.setRepeat(repeat),
    toggle: () => api.toggle(),
    stop: () => api.stop(),
    next: () => api.next(),
    prev: () => api.prev(),
    seek: (ms) => api.seek(ms),
    setVolume: (volume) => api.setVolume(volume),
    refreshLibrary: () => soft(() => (store.folder.value ? store.refresh() : store.importLibrary())).then((p) => p ?? store.scanError.value),
    loadSavedFolder: async () => {
      if (!store.configuredFolder.value) return "No music folder is saved in Settings.";
      store.scanError.value = null;
      return (await soft(() => store.importLibrary())) ?? store.scanError.value;
    },
    restoreRemoved: () => soft(() => store.restoreRemoved()),
    removeFromLibrary: (tracks) => soft(() => store.removeFromLibrary(tracks)),
    withoutCover: (tracks) => store.withoutCover(tracks),
    inspectFile: (track) => store.inspectFile(track),
    readLyrics: (track) => api.readLyrics(track.path),
    fixLength: (track, lengthMs) => store.fixLength(track, lengthMs),
    trashDuplicates: async (extras) => {
      const keepers = new Map(store.duplicateGroups.value.flatMap((g) => g.extras.map((t) => [t.path, g.keep.path] as const)));
      const pairs = extras.flatMap((t) => (keepers.has(t.path) ? [{ keep: keepers.get(t.path)!, extra: t.path }] : []));
      store.cleanupReport.value = null;
      const problem = await soft(() => store.trashDuplicates(pairs));
      return { report: store.cleanupReport.value, problem };
    },
    writeTags,
    reveal: (tracks) => soft(() => store.revealInFinder(tracks)),
    openLink: (url) => guard(() => api.openLink(url)),
    openInPicard: (tracks) => soft(() => store.openInPicard(tracks)),
    fetchLyrics: (track) => fetchLyrics(track),
    lookupTags: (track) => lookupTags(track),
    genreFill: () => genreFill,
    fetchRelease: (releaseId) => fetchRelease(releaseId),
    refreshPicardChanges: () => soft(() => store.refreshPicardFolders()),
    importLink: async (url, format) => {
      if (format === "mp3" || format === "m4a" || format === "flac") imports.setFormat(format);
      imports.error.value = null;
      return (await imports.addLink(url)) ? null : (imports.error.value ?? "Could not add the link.");
    },
    importFiles: async (paths) => {
      try {
        return { added: await api.importAddFiles(paths), problem: null };
      } catch (e) {
        return { added: 0, problem: String(e) };
      }
    },
    setImportTags: (id, patch) => importProblem(id, () => imports.setTags(id, patch)),
    addImport: (id) => importProblem(id, () => imports.add(id)),
    undoImport: (id) => importProblem(id, () => imports.undo(id)),
    openImportInPicard: (id) => importProblem(id, () => imports.openInPicard(id)),
    cancelImportPicard: (id) => importProblem(id, () => imports.cancelPicard(id)),
    removeImport: (id) => guard(() => imports.remove(id)),
    fetchImports: async (ids) => {
      imports.error.value = null;
      const started = await imports.fetchHeld(ids ?? undefined);
      return { started, problem: imports.error.value };
    },
    setImportOptions: ({ format, autoAdd, threshold }) => {
      if (format === "mp3" || format === "m4a" || format === "flac") imports.setFormat(format);
      if (autoAdd !== undefined) imports.setAutoAdd(autoAdd);
      if (threshold !== undefined && (THRESHOLDS as readonly string[]).includes(threshold)) imports.setThreshold(threshold as (typeof THRESHOLDS)[number]);
    },
    setTheme,
    setAccent,
    showTab: (tab, view) => {
      setAppMode(tab as AppMode);
      if (view) libraryView.value = view as LibraryView;
    },
    showInLibrary: (track) => showInLibrary(track),
    setWindowMode: async (mode) => {
      if (store.mode.value !== mode) await store.toggleMode();
    },
    quit: () => api.quit(),
  };
}

/** The DJ chat: one conversation with a local model that can search the library and drive the queue. */
export function createDjChat(host: DjHost, makeClient: (endpoint: () => string) => LmClient, storage?: TextStorage) {
  const endpoint = persistedText(ENDPOINT_KEY, DEFAULT_LM_ENDPOINT, storage);
  const model = persistedText(MODEL_KEY, "", storage);
  const client = makeClient(() => endpoint.text.value);

  /** Ask before anything that changes or deletes files, quits, or hides the chat. On unless the person turns it off. */
  const { flag: confirmRisky, set: setConfirmRisky } = persistedFlag("mixtape.dj.confirm", true, storage);
  /** The question waiting for Allow or Deny, if any. */
  const pending = ref<string | null>(null);
  let answer: ((allowed: boolean) => void) | null = null;
  const approve = (question: string) => {
    if (!confirmRisky.value) return Promise.resolve(true);
    pending.value = question;
    return new Promise<boolean>((resolve) => {
      answer = resolve;
    });
  };
  function respond(allowed: boolean) {
    answer?.(allowed);
    answer = null;
    pending.value = null;
  }

  const lines = ref<ChatLine[]>([]);
  const models = ref<string[]>([]);
  const busy = ref(false);
  /** Why the models could not be listed, shown instead of the model picker. */
  const modelsError = ref<string | null>(null);

  /** A song as the library has it now. */
  const liveSong = (track: Track) => host.library().find((t) => t.path === track.path) ?? track;

  let history: ChatMessage[] = [];
  let session = new DjSession(liveSong);

  async function loadModels() {
    try {
      models.value = await client.models();
      modelsError.value = models.value.length ? null : "LM Studio has no chat model loaded. Load one, then reload this list.";
      if (!models.value.includes(model.text.value)) model.set(models.value[0] ?? "");
    } catch (e) {
      models.value = [];
      modelsError.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy.value) return;
    if (!model.text.value) {
      await loadModels();
      if (!model.text.value) {
        lines.value.push({ kind: "error", text: modelsError.value ?? "Pick a model first." });
        return;
      }
    }
    if (history.length === 0) history = [{ role: "system", content: systemPrompt(host.library()) }];
    // The model sees what the app shows right now; the person only sees what they typed.
    history.push({ role: "user", content: `${message}\n\n${contextNote(host, session)}` });
    lines.value.push({ kind: "user", text: message });
    busy.value = true;
    try {
      const answer = await runTurn(client, model.text.value, history, host, session, (note, view) => lines.value.push({ kind: "action", text: note, view }), approve);
      if (answer.trim()) lines.value.push({ kind: "dj", text: answer });
    } catch (e) {
      lines.value.push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.value = false;
    }
  }

  function reset() {
    respond(false);
    history = [];
    session = new DjSession(liveSong);
    lines.value = [];
  }

  return { host, lines, pending, respond, confirmRisky, setConfirmRisky, models, modelsError, busy, model: model.text, endpoint: endpoint.text, loadModels, send, reset, setModel: model.set, setEndpoint: endpoint.set };
}

export const djChat = createDjChat(hostFor(appStore, tauriApi, appImports), (endpoint) => createLmClient(endpoint));

/** Opens the DJ panel and puts a request to the DJ in the chat, as if it had been typed there. */
export function askDj(prompt: string) {
  openDjPanel();
  return djChat.send(prompt);
}

/** The request that has the DJ look up the right tags for one song. It names the song, so it is not read as "the playing one". */
export const lookUpTagsPrompt = (song: Pick<Track, "title" | "artist">) =>
  `Look up the right tags for the selected song, “${song.title}”${song.artist ? ` by ${song.artist}` : ""}`;
