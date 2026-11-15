import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommands, dispatchKey, type Command, type KeyEventLike } from "./commands";
import type { Store } from "./store";
import { makePlayerState, makeTrack } from "./testing";
import { appMode, djPanelOpen, helpOpen, libraryView, paletteOpen, publishSelection, selectedSongs, tagEditPaths } from "./ui";

function fakeStore(over: Record<string, unknown> = {}) {
  const store = {
    mode: { value: "large" },
    player: { value: makePlayerState({ status: "playing", volume: 0.5, positionMs: 5_000, durationMs: 60_000 }) },
    queue: { value: [makeTrack()] },
    scanning: { value: false },
    folder: { value: "/music" },
    duplicateGroups: { value: [] },
    toggle: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    enqueue: vi.fn(),
    clearQueue: vi.fn(),
    toggleMode: vi.fn(async () => "thin"),
    ...over,
  };
  return store as unknown as Store & typeof store;
}

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  repeat: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...mods,
});
const nothingFocused = { editable: false, pressable: false };
const get = (commands: Command[], id: string) => commands.find((c) => c.id === id)!;

beforeEach(() => {
  paletteOpen.value = false;
  helpOpen.value = false;
  tagEditPaths.value = [];
  selectedSongs.value = [];
  appMode.value = "player";
  libraryView.value = "tracks";
});

describe("commands", () => {
  it("seeks 10 seconds and stays inside the song", async () => {
    const store = fakeStore();
    await get(createCommands(store), "seekForward").run!();
    expect(store.seek).toHaveBeenLastCalledWith(15_000);
    await get(createCommands(store), "seekBack").run!();
    expect(store.seek).toHaveBeenLastCalledWith(0);
  });

  it("changes volume in steps, within 0 and 1", async () => {
    const store = fakeStore();
    await get(createCommands(store), "volumeUp").run!();
    expect(store.setVolume).toHaveBeenLastCalledWith(0.55);
    store.player.value = makePlayerState({ volume: 0.98 });
    await get(createCommands(store), "volumeUp").run!();
    expect(store.setVolume).toHaveBeenLastCalledWith(1);
  });

  it("mutes, then brings the old volume back", async () => {
    const store = fakeStore();
    await get(createCommands(store), "mute").run!();
    expect(store.setVolume).toHaveBeenLastCalledWith(0);
    store.player.value = makePlayerState({ volume: 0 });
    await get(createCommands(store), "mute").run!();
    expect(store.setVolume).toHaveBeenLastCalledWith(0.5);
  });

  it("acts on the selected songs only when there are some", async () => {
    const store = fakeStore();
    expect(get(createCommands(store), "enqueue").enabled).toBe(false);
    const song = makeTrack();
    publishSelection(Symbol("t"), [song]);
    const enqueue = get(createCommands(store), "enqueue");
    expect(enqueue.enabled).toBe(true);
    await enqueue.run!();
    expect(store.enqueue).toHaveBeenCalledWith([song]);
  });

  it("opens the tag editor for the selected songs", async () => {
    const song = makeTrack({ path: "/m/a.mp3" });
    publishSelection(Symbol("t"), [song]);
    await get(createCommands(fakeStore()), "editTags").run!();
    expect(tagEditPaths.value).toEqual(["/m/a.mp3"]);
  });

  it("switches views, and only offers Duplicates when there are some", async () => {
    const store = fakeStore();
    appMode.value = "discovery";
    await get(createCommands(store), "viewAlbums").run!();
    expect(appMode.value).toBe("player");
    expect(libraryView.value).toBe("albums");
    expect(get(createCommands(store), "viewDuplicates").enabled).toBe(false);
  });

  it("slides the DJ panel out and back, in the large window only", async () => {
    djPanelOpen.value = false;
    await get(createCommands(fakeStore()), "dj").run!();
    expect(djPanelOpen.value).toBe(true);
    await get(createCommands(fakeStore()), "dj").run!();
    expect(djPanelOpen.value).toBe(false);
  });

  it("does not fire the DJ key while typing in a text box", () => {
    const commands = createCommands(fakeStore());
    const event = { key: "\\", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    djPanelOpen.value = false;
    expect(dispatchKey(event, commands, { editable: true, pressable: false })).toBe(false);
    expect(djPanelOpen.value).toBe(false);
    expect(dispatchKey(event, commands, { editable: false, pressable: false })).toBe(true);
    expect(djPanelOpen.value).toBe(true);
  });

  it("in the thin bar, the DJ key opens the chat in the bar's panel and does not touch the large window", async () => {
    vi.stubGlobal("window", { innerWidth: 300 });
    try {
      djPanelOpen.value = false;
      const store = fakeStore({ mode: { value: "thin" }, toggleThinView: vi.fn(async () => {}) });
      const dj = get(createCommands(store), "dj");
      expect(dj.enabled).toBe(true);
      await dj.run!();
      expect(store.toggleThinView).toHaveBeenCalledWith("dj", 300);
      expect(store.toggleMode).not.toHaveBeenCalled();
      expect(djPanelOpen.value).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("limits the thin bar to playback and the window switch", () => {
    const commands = createCommands(fakeStore({ mode: { value: "thin" } }));
    expect(get(commands, "playPause").enabled).toBe(true);
    expect(get(commands, "toggleMode").enabled).toBe(true);
    expect(get(commands, "palette").enabled).toBe(false);
    expect(get(commands, "viewAlbums").enabled).toBe(false);
  });
});

describe("dispatchKey", () => {
  it("runs the command and stops the key from reaching the list", () => {
    const store = fakeStore();
    const event = key(" ");
    expect(dispatchKey(event, createCommands(store), nothingFocused)).toBe(true);
    expect(store.toggle).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("ignores keys that are not shortcuts", () => {
    const store = fakeStore();
    expect(dispatchKey(key("x"), createCommands(store), nothingFocused)).toBe(false);
    expect(dispatchKey(key("ArrowDown"), createCommands(store), nothingFocused)).toBe(false);
  });

  it("does not play and pause while typing, or on a focused button", () => {
    const store = fakeStore();
    expect(dispatchKey(key(" "), createCommands(store), { editable: true, pressable: false })).toBe(false);
    expect(dispatchKey(key(" "), createCommands(store), { editable: false, pressable: true })).toBe(false);
    expect(store.toggle).not.toHaveBeenCalled();
  });

  it("does not repeat a toggle when the key is held, but does repeat volume", () => {
    const store = fakeStore();
    expect(dispatchKey(key(" ", { repeat: true }), createCommands(store), nothingFocused)).toBe(false);
    expect(dispatchKey(key("ArrowUp", { metaKey: true, repeat: true }), createCommands(store), nothingFocused)).toBe(true);
  });

  it("does nothing for a command that is not available", () => {
    const store = fakeStore({ queue: { value: [] } });
    expect(dispatchKey(key(" "), createCommands(store), nothingFocused)).toBe(false);
  });

  it("lets only the overlays' own keys through while one is open", () => {
    const store = fakeStore();
    paletteOpen.value = true;
    expect(dispatchKey(key(" "), createCommands(store), nothingFocused)).toBe(false);
    expect(dispatchKey(key("k", { metaKey: true }), createCommands(store), { editable: true, pressable: false })).toBe(true);
    expect(paletteOpen.value).toBe(false);
  });

  it("blocks shortcuts behind the tag dialog", () => {
    tagEditPaths.value = ["/m/a.mp3"];
    expect(dispatchKey(key(" "), createCommands(fakeStore()), nothingFocused)).toBe(false);
  });

  it("ignores keys typed through an input method", () => {
    expect(dispatchKey(key(" ", { isComposing: true }), createCommands(fakeStore()), nothingFocused)).toBe(false);
  });
});
