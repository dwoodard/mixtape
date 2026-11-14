import { ref } from "vue";
import type { Api } from "./api";
import { persistedChoice, persistedFlag, type FlagStorage } from "./ui";
import type { ImportEvent, ImportField, ImportItem, TagsPatch, ToolStatus, Track } from "./types";

/** The tags that must be filled in before a song can be added without a second look. */
export const KEY_FIELDS: ImportField[] = ["title", "artist", "album", "year"];

const norm = (s: string) => s.trim().toLowerCase();

/** The library song that is the same recording (same title and artist), if any. */
export function findOwned(library: Track[], title: string, artist: string): Track | null {
  if (!title.trim()) return null;
  return library.find((t) => norm(t.title) === norm(title) && norm(t.artist) === norm(artist)) ?? null;
}

export const missingKeyFields = (item: ImportItem): ImportField[] =>
  KEY_FIELDS.filter((f) => !item.proposal[f].trim());

/** Worth a human look before adding: unsure match, missing tags, or already in the library. */
export function needsAttention(item: ImportItem, library: Track[]): boolean {
  return (
    item.confidence < 0.8 ||
    missingKeyFields(item).length > 0 ||
    findOwned(library, item.proposal.title, item.proposal.artist) !== null
  );
}

/** May the auto-add rule add this song by itself? */
export function autoAddEligible(item: ImportItem, library: Track[], threshold: number): boolean {
  return (
    item.stage === "ready" &&
    item.confidence >= threshold &&
    missingKeyFields(item).length === 0 &&
    findOwned(library, item.proposal.title, item.proposal.artist) === null
  );
}

export const THRESHOLDS = ["0.6", "0.7", "0.8", "0.9", "1"] as const;
export const FORMATS = ["mp3", "m4a", "flac"] as const;
export type Format = (typeof FORMATS)[number];

export interface ImportHooks {
  library: () => Track[];
  onAdded: (track: Track) => void;
  onRemoved: (path: string) => void;
}

/** Everything the Discovery workspace needs: the inbox, tools, settings, and the actions on songs. */
export function createImports(api: Api, hooks: ImportHooks, storage?: FlagStorage) {
  const items = ref<ImportItem[]>([]);
  const tools = ref<ToolStatus | null>(null);
  const error = ref<string | null>(null);
  /** Why the last add or undo failed, by song. */
  const itemErrors = ref<Record<number, string>>({});
  /** Songs the auto-add rule added this session, so they can be listed with Undo. */
  const autoAdded = ref<number[]>([]);

  const { choice: format, set: setFormat } = persistedChoice<Format>("mixtape.importFormat", "mp3", FORMATS, storage);
  const { choice: threshold, set: setThreshold } = persistedChoice("mixtape.autoAddThreshold", "0.7", THRESHOLDS, storage);
  const { flag: autoAdd, set: setAutoAdd } = persistedFlag("mixtape.autoAdd", false, storage);
  const { flag: noticeSeen, set: setNoticeSeen } = persistedFlag("mixtape.fetchNoticeSeen", false, storage);

  const setItemError = (id: number, message: string | null) => {
    const next = { ...itemErrors.value };
    if (message) next[id] = message;
    else delete next[id];
    itemErrors.value = next;
  };

  function apply(event: ImportEvent) {
    if (event.kind === "removed") {
      items.value = items.value.filter((i) => i.id !== event.value);
      autoAdded.value = autoAdded.value.filter((id) => id !== event.value);
      return;
    }
    const fresh = event.value;
    const before = items.value.find((i) => i.id === fresh.id);
    items.value = before ? items.value.map((i) => (i.id === fresh.id ? fresh : i)) : [...items.value, fresh];
    if (fresh.stage === "ready" && before?.stage !== "ready") void maybeAutoAdd(fresh);
  }

  async function init(): Promise<() => void> {
    const unlisten = await api.onImportEvent(apply);
    try {
      tools.value = await api.importTools();
      items.value = await api.importList();
    } catch (e) {
      console.error("import startup failed:", e);
    }
    return unlisten;
  }

  async function addLink(text: string): Promise<boolean> {
    error.value = null;
    try {
      await api.importAddLink(text, format.value);
      return true;
    } catch (e) {
      error.value = String(e);
      return false;
    }
  }

  async function setTags(id: number, patch: TagsPatch) {
    try {
      const updated = await api.importSetTags(id, patch);
      items.value = items.value.map((i) => (i.id === id ? updated : i));
    } catch (e) {
      setItemError(id, String(e));
    }
  }

  async function add(id: number): Promise<boolean> {
    setItemError(id, null);
    try {
      hooks.onAdded(await api.importAdd(id));
      return true;
    } catch (e) {
      setItemError(id, String(e));
      return false;
    }
  }

  /** Opens the song in MusicBrainz Picard; its tags come back here once it is saved there. */
  async function openInPicard(id: number) {
    setItemError(id, null);
    try {
      await api.importOpenInPicard(id);
    } catch (e) {
      setItemError(id, String(e));
    }
  }

  async function undo(id: number) {
    setItemError(id, null);
    try {
      hooks.onRemoved(await api.importUndo(id));
      autoAdded.value = autoAdded.value.filter((a) => a !== id);
    } catch (e) {
      setItemError(id, String(e));
    }
  }

  async function remove(id: number) {
    await api.importRemove(id);
  }

  /** Adds each of `list` that is ready, one at a time. */
  async function addMany(list: ImportItem[]) {
    for (const item of list.filter((i) => i.stage === "ready")) await add(item.id);
  }

  async function maybeAutoAdd(item: ImportItem) {
    if (!autoAdd.value || !autoAddEligible(item, hooks.library(), Number(threshold.value))) return;
    if (await add(item.id)) autoAdded.value = [...autoAdded.value, item.id];
  }

  return {
    items,
    tools,
    error,
    itemErrors,
    autoAdded,
    format,
    setFormat,
    threshold,
    setThreshold,
    autoAdd,
    setAutoAdd,
    noticeSeen,
    setNoticeSeen,
    init,
    addLink,
    setTags,
    add,
    openInPicard,
    undo,
    remove,
    addMany,
  };
}

export type Imports = ReturnType<typeof createImports>;
