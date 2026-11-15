import { ref } from "vue";
import type { Api } from "./api";
import { persistedChoice, persistedFlag, type FlagStorage } from "./ui";
import type { ImportEvent, ImportField, ImportItem, TagsPatch, ToolStatus, Track } from "./types";

/** The tags that must be filled in before a song can be added without a second look. */
export const KEY_FIELDS: ImportField[] = ["title", "artist", "album", "year"];

/** Letters and digits only, lower case: "Don’t Stop!" and "dont stop" are the same song, as are "Beyoncé" and "Beyonce". */
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/** The library song that is the same recording (same title and artist), if any. */
export function findOwned(library: Track[], title: string, artist: string): Track | null {
  // A title with no letters or digits in it would match every other such title.
  if (!norm(title)) return null;
  return library.find((t) => norm(t.title) === norm(title) && norm(t.artist) === norm(artist)) ?? null;
}

const NOISE_WORDS = new Set(["official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "4k", "remaster", "remastered", "music", "live", "clip"]);

/** "Primus - Tommy The Cat (Official Music Video)" -> { artist: "Primus", title: "Tommy The Cat" }. Mirrors the Rust title cleanup. */
export function parseVideoTitle(raw: string): { artist: string; title: string } {
  const noBrackets = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, (m) =>
    m.slice(1, -1).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => NOISE_WORDS.has(w)) ? "" : m,
  );
  const cleaned = noBrackets.split(/[|｜]/)[0].split(/\s+/).filter(Boolean).join(" ");
  const unquote = (s: string) => s.trim().replace(/^["“]|["”]$/g, "");
  for (const sep of [" - ", " – ", " — "]) {
    const at = cleaned.indexOf(sep);
    if (at !== -1) return { artist: cleaned.slice(0, at).trim(), title: unquote(cleaned.slice(at + sep.length)) };
  }
  return { artist: "", title: cleaned };
}

/**
 * Whether a held song is already in the library, judged from its video title, and which library song it is. "have": the
 * same artist and title. "maybe": the title alone matches (the video title named no artist, or spells the artist differently).
 */
export function heldOwnership(item: Pick<ImportItem, "videoTitle">, library: Track[]): { match: "have" | "maybe"; track: Track } | null {
  const { artist, title } = parseVideoTitle(item.videoTitle);
  if (!norm(title)) return null;
  const sameTitle = library.filter((t) => norm(t.title) === norm(title));
  const exact = artist ? sameTitle.find((t) => norm(t.artist) === norm(artist)) : undefined;
  if (exact) return { match: "have", track: exact };
  return sameTitle.length > 0 ? { match: "maybe", track: sameTitle[0] } : null;
}

/** Is this a YouTube link the app may open? Files added from disk have no link. */
export const isYoutubeLink = (url: string): boolean => /^https:\/\/(www\.youtube\.com|music\.youtube\.com|youtu\.be)\//.test(url);

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

/** Songs still being brought in: waiting their turn, looked up, downloaded or converted. Only these can be stopped. */
export const isLoading = (item: Pick<ImportItem, "stage">): boolean =>
  item.stage === "queued" || item.stage === "probing" || item.stage === "fetching" || item.stage === "converting";

/** Songs listed from a playlist but not fetched yet: nothing downloads until the person asks for it. */
export const isHeld = (item: Pick<ImportItem, "stage">): boolean => item.stage === "held";

/**
 * The ids from `anchor` to `target` in `order`, both included, for a shift-click. Without an anchor, or when the anchor is
 * no longer in the list, it is just the target.
 */
export function rangeBetween(order: number[], anchor: number | null, target: number): number[] {
  const to = order.indexOf(target);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (to === -1) return [];
  if (from === -1) return [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * What a click on a song does to the selection. A plain click flips that song. A shift-click flips the whole run from the
 * last song clicked to this one: all selected if this one was not, all cleared if it was. The song clicked becomes the
 * new starting point.
 */
export function selectWithClick(
  picked: ReadonlySet<number>,
  order: number[],
  anchor: number | null,
  target: number,
  shift: boolean,
): { picked: Set<number>; anchor: number } {
  const next = new Set(picked);
  const turnOn = !picked.has(target);
  const ids = shift ? rangeBetween(order, anchor, target) : [target];
  for (const id of ids.length ? ids : [target]) {
    if (turnOn) next.add(id);
    else next.delete(id);
  }
  return { picked: next, anchor: target };
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

  /** Asks for files and adds them to the list. Returns how many were added (0 if cancelled or none were new). */
  async function addFiles(): Promise<number> {
    error.value = null;
    try {
      const paths = await api.pickAudioFiles();
      if (paths.length === 0) return 0;
      return await api.importAddFiles(paths);
    } catch (e) {
      error.value = String(e);
      return 0;
    }
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

  /**
   * Adds a ready song to the library. The same song already in that folder is refused (it would become "Song (2)"),
   * unless `allowCopy` is set, which only a person choosing "Add anyway" does.
   */
  async function add(id: number, allowCopy = false): Promise<boolean> {
    setItemError(id, null);
    try {
      hooks.onAdded(await (allowCopy ? api.importAdd(id, true) : api.importAdd(id)));
      return true;
    } catch (e) {
      setItemError(id, String(e));
      return false;
    }
  }

  /** Starts fetching songs held back from a playlist. No ids means all of them. Returns how many were started. */
  async function fetchHeld(ids?: number[]): Promise<number> {
    error.value = null;
    try {
      return await api.importFetch(ids ?? null);
    } catch (e) {
      error.value = String(e);
      return 0;
    }
  }

  /** Takes held songs out of the list without fetching them. */
  async function clearHeld(ids: number[]) {
    for (const id of ids) await api.importRemove(id);
  }

  /** Stops songs that are still loading and takes them out of the list. No ids means all of them. Returns how many. */
  async function stopLoading(ids?: number[]): Promise<number> {
    error.value = null;
    try {
      return await api.importStop(ids ?? null);
    } catch (e) {
      error.value = String(e);
      return 0;
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

  /** Opens the song's YouTube page in the browser. */
  async function openSource(url: string) {
    try {
      await api.openLink(url);
    } catch (e) {
      error.value = String(e);
    }
  }

  /** Shows the song's file in Finder. */
  async function reveal(id: number) {
    setItemError(id, null);
    try {
      await api.importReveal(id);
    } catch (e) {
      setItemError(id, String(e));
    }
  }

  /** Stops waiting for Picard (and takes the song out of it); the song carries on as before. */
  async function cancelPicard(id: number) {
    setItemError(id, null);
    try {
      await api.importCancelPicard(id);
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

  /** What the last bulk add did, in words, for the inbox to show: what it skipped and why. Null when there is nothing to say. */
  const notice = ref<string | null>(null);

  /**
   * Adds each of `list` that is ready, one at a time. A song the library already has is skipped, not added a second time
   * (it would only become "Song (2).mp3"): the library is checked just before each one, so a song that appears twice in
   * a playlist is added once too. To keep a second copy on purpose, add that song by itself with "Add anyway".
   */
  async function addMany(list: ImportItem[]) {
    notice.value = null;
    const skipped: string[] = [];
    let added = 0;
    for (const item of list.filter((i) => i.stage === "ready")) {
      const have = findOwned(hooks.library(), item.proposal.title, item.proposal.artist);
      if (have) {
        skipped.push(item.proposal.title || item.videoTitle);
        continue;
      }
      if (await add(item.id)) added++;
    }
    if (skipped.length > 0) {
      const names = skipped.slice(0, 3).join(", ") + (skipped.length > 3 ? `, and ${skipped.length - 3} more` : "");
      notice.value = `Added ${added}. Skipped ${skipped.length} already in your library: ${names}. To keep a second copy, add it by itself with “Add anyway”.`;
    }
    return { added, skipped: skipped.length };
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
    addFiles,
    setTags,
    add,
    openInPicard,
    reveal,
    openSource,
    notice,
    stopLoading,
    fetchHeld,
    clearHeld,
    cancelPicard,
    undo,
    remove,
    addMany,
  };
}

export type Imports = ReturnType<typeof createImports>;
