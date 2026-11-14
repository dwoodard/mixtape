import { nextTick } from "vue";
import type { Store } from "./store";
import { allowedWhileFocused, COMMANDS, findCommand, type CommandDef, type FocusKind, type KeyLike } from "./shortcuts";
import {
  appMode,
  helpOpen,
  libraryView,
  paletteOpen,
  savingQueue,
  selectedSongs,
  setAppMode,
  tagEditPaths,
  type LibraryView,
} from "./ui";

const SEEK_STEP_MS = 10_000;
const VOLUME_STEP = 0.05;
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

export interface Command extends CommandDef {
  enabled: boolean;
  /** Missing for commands that only exist as a key on the focused list. */
  run?: () => void | Promise<void>;
}

/** What still works in the thin bar: it has no lists, queue or overlays. */
const THIN_BAR = new Set(["playPause", "next", "prev", "seekForward", "seekBack", "volumeUp", "volumeDown", "mute", "shuffle", "repeat", "stop", "toggleMode"]);

let volumeBeforeMute = 0.5;

/** Every command with its current availability and what it does. Cheap: call it again after state changes. */
export function createCommands(store: Store): Command[] {
  const large = store.mode.value === "large";
  const player = store.player.value;
  const hasQueue = store.queue.value.length > 0;
  const songs = selectedSongs.value;
  const scanning = store.scanning.value;

  const showView = (view: LibraryView) => () => {
    setAppMode("player");
    libraryView.value = view;
  };
  const volumeBy = (delta: number) => () => store.setVolume(clamp(player.volume + delta, 0, 1));
  const seekBy = (delta: number) => () => store.seek(clamp(player.positionMs + delta, 0, player.durationMs));

  const focusSearch = async () => {
    setAppMode("player");
    if (libraryView.value === "playlists" || libraryView.value === "duplicates") libraryView.value = "tracks";
    await nextTick();
    const input = document.getElementById("library-filter") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  };

  const behavior: Record<string, { enabled?: boolean; run?: () => void | Promise<void> }> = {
    playPause: { enabled: hasQueue, run: () => store.toggle() },
    next: { enabled: hasQueue, run: () => store.next() },
    prev: { enabled: hasQueue, run: () => store.prev() },
    seekForward: { enabled: hasQueue && player.durationMs > 0, run: seekBy(SEEK_STEP_MS) },
    seekBack: { enabled: hasQueue && player.durationMs > 0, run: seekBy(-SEEK_STEP_MS) },
    volumeUp: { run: volumeBy(VOLUME_STEP) },
    volumeDown: { run: volumeBy(-VOLUME_STEP) },
    mute: {
      run: () => {
        if (player.volume > 0) {
          volumeBeforeMute = player.volume;
          return store.setVolume(0);
        }
        return store.setVolume(volumeBeforeMute);
      },
    },
    shuffle: { run: () => store.toggleShuffle() },
    repeat: { run: () => store.cycleRepeat() },
    stop: { enabled: player.status !== "stopped", run: () => store.stop() },

    focusSearch: { run: focusSearch },
    viewTracks: { run: showView("tracks") },
    viewAlbums: { run: showView("albums") },
    viewArtists: { run: showView("artists") },
    viewPlaylists: { run: showView("playlists") },
    viewDuplicates: { enabled: store.duplicateGroups.value.length > 0, run: showView("duplicates") },
    discovery: { run: () => setAppMode(appMode.value === "player" ? "discovery" : "player") },
    toggleMode: { run: () => void store.toggleMode() },

    play: { enabled: songs.length > 0, run: () => store.playTracks(songs, 0) },
    enqueue: { enabled: songs.length > 0, run: () => store.enqueue(songs) },
    playNext: { enabled: songs.length > 0, run: () => store.enqueueNext(songs) },
    editTags: { enabled: songs.length > 0, run: () => void (tagEditPaths.value = songs.map((t) => t.path)) },
    picard: { enabled: songs.length > 0, run: () => store.openInPicard(songs) },
    reveal: { enabled: songs.length > 0, run: () => store.revealInFinder(songs) },
    remove: {},

    saveQueue: {
      enabled: hasQueue,
      run: () => {
        setAppMode("player");
        savingQueue.value = true;
      },
    },
    clearQueue: { enabled: hasQueue, run: () => store.clearQueue() },
    openFolder: { enabled: !scanning, run: () => store.openFolder() },
    refresh: { enabled: !!store.folder.value && !scanning, run: () => store.refresh() },

    palette: {
      run: () => {
        helpOpen.value = false;
        paletteOpen.value = !paletteOpen.value;
      },
    },
    help: {
      run: () => {
        paletteOpen.value = false;
        helpOpen.value = !helpOpen.value;
      },
    },
  };

  return COMMANDS.map((def) => {
    const b = behavior[def.id] ?? {};
    const inScope = large || THIN_BAR.has(def.id);
    return { ...def, enabled: inScope && (b.enabled ?? true), run: b.run };
  });
}

/** The parts of a keyboard event the dispatcher uses. */
export interface KeyEventLike extends KeyLike {
  repeat: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Runs the command a key press stands for. Returns whether it did.
 * Handled presses are stopped, so the focused list does not also act on them.
 */
export function dispatchKey(event: KeyEventLike, commands: Command[], focus: FocusKind): boolean {
  if (event.isComposing) return false;
  const found = findCommand(event);
  if (!found?.keys) return false;
  const command = commands.find((c) => c.id === found.id);
  if (!command?.run || !command.enabled) return false;
  if (event.repeat && !found.repeatable) return false;
  if (!allowedWhileFocused(found.keys, focus)) return false;
  // With an overlay or dialog open, only the overlays' own keys work.
  const covered = paletteOpen.value || helpOpen.value || tagEditPaths.value.length > 0;
  if (covered && found.id !== "palette" && found.id !== "help") return false;

  event.preventDefault();
  event.stopPropagation();
  void command.run();
  return true;
}
