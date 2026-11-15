import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { createStore } from "./store";
import type { FlagStorage } from "./ui";
import { makePlayerState, makeTrack } from "./testing";
import { panelWantedHeight } from "./thinBar";
import type { CleanupReport, PlayerState, ScanProgress, Track, WindowMode } from "./types";

function fakeApi(overrides: Partial<Api> = {}) {
  const listeners = {
    state: [] as ((s: PlayerState) => void)[],
    queue: [] as ((q: Track[]) => void)[],
    position: [] as ((ms: number) => void)[],
    mode: [] as ((m: WindowMode) => void)[],
    scan: [] as ((p: ScanProgress) => void)[],
  };
  const unlisten = vi.fn();
  const api: Api = {
    snapshot: vi.fn(async () => ({ state: makePlayerState(), queue: [] })),
    windowMode: vi.fn(async () => "large" as WindowMode),
    pickFolder: vi.fn(async () => "/music"),
    scanFolder: vi.fn(async () => [makeTrack()]),
    musicFolder: vi.fn(async () => "/nas/music" as string | null),
    importLibrary: vi.fn(async () => [makeTrack()]),
    cancelScan: vi.fn(async () => {}),
    cachedLibrary: vi.fn(async () => null),
    removeFromLibrary: vi.fn(async () => {}),
    revealInFinder: vi.fn(async () => {}),
    writeTags: vi.fn(async () => []),
    importTools: vi.fn(async () => ({ ytDlp: "/bin/yt-dlp", ffmpeg: "/bin/ffmpeg", picard: "/Applications/MusicBrainz Picard.app" })),
    importList: vi.fn(async () => []),
    importAddLink: vi.fn(async () => {}),
    pickAudioFiles: vi.fn(async () => [] as string[]),
    importAddFiles: vi.fn(async () => 0),
    importSetTags: vi.fn(async () => ({}) as never),
    importAdd: vi.fn(async () => makeTrack()),
    importOpenInPicard: vi.fn(async () => {}),
    importCancelPicard: vi.fn(async () => {}),
    replaceQueueTracks: vi.fn(async () => {}),
    moveQueueTrack: vi.fn(async () => {}),
    picardOpenFiles: vi.fn(async () => {}),
    refreshFolders: vi.fn(async () => []),
    importUndo: vi.fn(async () => ""),
    importRemove: vi.fn(async () => {}),
    onImportEvent: vi.fn(async () => unlisten),
    trashDuplicates: vi.fn(async () => ({ trashed: [], held: [], holdingFolder: null, missing: [], skipped: [] })),
    removedCount: vi.fn(async () => 0),
    restoreRemoved: vi.fn(async () => {}),
    enqueueNext: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    dismissError: vi.fn(async () => {}),
    setShuffle: vi.fn(async () => {}),
    setRepeat: vi.fn(async () => {}),
    playTracks: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    playIndex: vi.fn(async () => {}),
    toggle: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    removeFromQueue: vi.fn(async () => {}),
    removeFromQueueDown: vi.fn(async () => {}),
    resizeThin: vi.fn(async () => {}),
    openThinPanel: vi.fn(async () => ({ side: "down" as const, height: 200 })),
    closeThinPanel: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    toggleWindowMode: vi.fn(async () => "thin" as WindowMode),
    quit: vi.fn(async () => {}),
    onState: vi.fn(async (cb) => (listeners.state.push(cb), unlisten)),
    onQueue: vi.fn(async (cb) => (listeners.queue.push(cb), unlisten)),
    onPosition: vi.fn(async (cb) => (listeners.position.push(cb), unlisten)),
    onWindowMode: vi.fn(async (cb) => (listeners.mode.push(cb), unlisten)),
    onScanProgress: vi.fn(async (cb) => (listeners.scan.push(cb), unlisten)),
    ...overrides,
  };
  return { api, listeners, unlisten };
}

describe("init", () => {
  it("loads the snapshot and window mode", async () => {
    const track = makeTrack({ title: "Now" });
    const { api } = fakeApi({
      snapshot: vi.fn(async () => ({
        state: makePlayerState({ status: "playing", currentIndex: 0, currentTrack: track }),
        queue: [track],
      })),
      windowMode: vi.fn(async () => "thin" as WindowMode),
    });
    const store = createStore(api);

    await store.init();

    expect(store.player.value.currentTrack?.title).toBe("Now");
    expect(store.queue.value).toEqual([track]);
    expect(store.mode.value).toBe("thin");
  });

  it("applies pushed state, queue, position, and mode updates", async () => {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();

    listeners.state[0](makePlayerState({ status: "paused", volume: 0.4 }));
    listeners.queue[0]([makeTrack({ title: "Q" })]);
    listeners.position[0](12_345);
    listeners.mode[0]("thin");

    expect(store.player.value.status).toBe("paused");
    expect(store.player.value.volume).toBe(0.4);
    expect(store.player.value.positionMs).toBe(12_345);
    expect(store.queue.value[0].title).toBe("Q");
    expect(store.mode.value).toBe("thin");
  });

  it("returns a cleanup that unsubscribes every listener", async () => {
    const { api, unlisten } = fakeApi();
    const cleanup = await createStore(api).init();
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(5);
  });
});

describe("openFolder", () => {
  it("scans the picked folder into the library", async () => {
    const { api } = fakeApi();
    const store = createStore(api);

    await store.openFolder();

    expect(api.scanFolder).toHaveBeenCalledWith("/music");
    expect(store.library.value).toHaveLength(1);
    expect(store.folder.value).toBe("/music");
    expect(store.scanning.value).toBe(false);
  });

  it("does nothing when the picker is cancelled", async () => {
    const { api } = fakeApi({ pickFolder: vi.fn(async () => null) });
    const store = createStore(api);

    await store.openFolder();

    expect(api.scanFolder).not.toHaveBeenCalled();
    expect(store.library.value).toEqual([]);
  });

  it("keeps the previous library and reports the error when scanning fails", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.openFolder();
    (api.scanFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce("boom");

    await store.openFolder();

    expect(store.scanError.value).toBe("boom");
    expect(store.library.value).toHaveLength(1);
    expect(store.scanning.value).toBe(false);
  });
});

describe("importLibrary", () => {
  it("imports the configured folder after init", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.init();

    await store.importLibrary();

    expect(store.configuredFolder.value).toBe("/nas/music");
    expect(api.importLibrary).toHaveBeenCalled();
    expect(store.library.value).toHaveLength(1);
    expect(store.folder.value).toBe("/nas/music");
  });

  it("does nothing when no folder is configured", async () => {
    const { api } = fakeApi({ musicFolder: vi.fn(async () => null) });
    const store = createStore(api);
    await store.init();

    await store.importLibrary();

    expect(api.importLibrary).not.toHaveBeenCalled();
  });

  it("reports the error when the import fails", async () => {
    const { api } = fakeApi({ importLibrary: vi.fn(async () => Promise.reject("not mounted")) });
    const store = createStore(api);
    await store.init();

    await store.importLibrary();

    expect(store.scanError.value).toBe("not mounted");
    expect(store.scanning.value).toBe(false);
  });
});

describe("actions", () => {
  it("toggleMode adopts the mode the backend switched to", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.toggleMode();
    expect(api.toggleWindowMode).toHaveBeenCalled();
    expect(store.mode.value).toBe("thin");
  });

  it("forwards transport and queue commands", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    const tracks = [makeTrack()];

    await store.playTracks(tracks, 0);
    await store.enqueue(tracks);
    await store.playQueueIndex(2);
    await store.toggle();
    await store.next();
    await store.prev();
    await store.seek(5000);
    await store.setVolume(0.5);
    await store.removeFromQueue(1);
    await store.clearQueue();
    await store.moveQueueTrack(3, 0);

    expect(api.moveQueueTrack).toHaveBeenCalledWith(3, 0);
    expect(api.playTracks).toHaveBeenCalledWith(tracks, 0);
    expect(api.enqueue).toHaveBeenCalledWith(tracks);
    expect(api.playIndex).toHaveBeenCalledWith(2);
    expect(api.seek).toHaveBeenCalledWith(5000);
    expect(api.setVolume).toHaveBeenCalledWith(0.5);
    expect(api.removeFromQueue).toHaveBeenCalledWith(1);
    expect(api.clearQueue).toHaveBeenCalled();
    expect(api.toggle).toHaveBeenCalled();
    expect(api.next).toHaveBeenCalled();
    expect(api.prev).toHaveBeenCalled();
  });
});

describe("scan progress and cancel", () => {
  it("shows pushed progress while scanning and clears it when done", async () => {
    let finish!: (tracks: Track[]) => void;
    const { api, listeners } = fakeApi({
      scanFolder: vi.fn(() => new Promise<Track[]>((resolve) => (finish = resolve))),
    });
    const store = createStore(api);
    await store.init();

    const scanning = store.openFolder();
    await vi.waitFor(() => expect(store.scanning.value).toBe(true));
    listeners.scan[0]({ phase: "reading", done: 25, total: 100 });
    expect(store.scanProgress.value).toEqual({ phase: "reading", done: 25, total: 100 });

    finish([makeTrack()]);
    await scanning;

    expect(store.scanProgress.value).toBeNull();
    expect(store.scanning.value).toBe(false);
  });

  it("cancelScan asks the backend to stop", async () => {
    const { api } = fakeApi();
    await createStore(api).cancelScan();
    expect(api.cancelScan).toHaveBeenCalled();
  });

  it("treats a cancelled scan as neither an error nor a library change", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.openFolder();
    (api.scanFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce("cancelled");

    await store.openFolder();

    expect(store.scanError.value).toBeNull();
    expect(store.library.value).toHaveLength(1);
    expect(store.scanning.value).toBe(false);
  });

  it("a cancelled older scan does not clear the state of the newer one", async () => {
    let rejectFirst!: (reason: string) => void;
    let finishSecond!: (tracks: Track[]) => void;
    const scanFolder = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Track[]>((_, reject) => (rejectFirst = reject)))
      .mockImplementationOnce(() => new Promise<Track[]>((resolve) => (finishSecond = resolve)));
    const { api } = fakeApi({ scanFolder });
    const store = createStore(api);

    const first = store.openFolder();
    await vi.waitFor(() => expect(scanFolder).toHaveBeenCalledTimes(1));
    const second = store.openFolder();
    await vi.waitFor(() => expect(scanFolder).toHaveBeenCalledTimes(2));

    rejectFirst("cancelled");
    await first;
    expect(store.scanning.value).toBe(true);

    finishSecond([makeTrack({ title: "Second" })]);
    await second;
    expect(store.library.value[0].title).toBe("Second");
    expect(store.scanning.value).toBe(false);
  });
});

describe("saved library", () => {
  it("shows the cached library on init without scanning", async () => {
    const { api } = fakeApi({
      cachedLibrary: vi.fn(async () => ({
        folder: "/Volumes/music",
        tracks: [makeTrack({ title: "Cached" })],
        scannedAtMs: 1234,
      })),
    });
    const store = createStore(api);

    await store.init();

    expect(store.library.value[0].title).toBe("Cached");
    expect(store.folder.value).toBe("/Volumes/music");
    expect(store.scannedAt.value).toBe(1234);
    expect(api.scanFolder).not.toHaveBeenCalled();
    expect(api.importLibrary).not.toHaveBeenCalled();
  });

  it("starts empty when nothing is cached", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.init();
    expect(store.library.value).toEqual([]);
    expect(store.scannedAt.value).toBeNull();
  });

  it("refresh rescans the current folder and updates the scan time", async () => {
    const { api } = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [makeTrack()], scannedAtMs: 1 })),
    });
    const store = createStore(api);
    await store.init();

    await store.refresh();

    expect(api.scanFolder).toHaveBeenCalledWith("/m");
    expect(store.scannedAt.value).toBeGreaterThan(1);
  });

  it("refresh does nothing without a folder", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.refresh();
    expect(api.scanFolder).not.toHaveBeenCalled();
  });
});

describe("play modes", () => {
  it("toggleShuffle flips the current setting", async () => {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();

    await store.toggleShuffle();
    expect(api.setShuffle).toHaveBeenLastCalledWith(true);

    listeners.state[0](makePlayerState({ shuffle: true }));
    await store.toggleShuffle();
    expect(api.setShuffle).toHaveBeenLastCalledWith(false);
  });

  it("cycleRepeat goes off, all, one, then back to off", async () => {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();

    await store.cycleRepeat();
    expect(api.setRepeat).toHaveBeenLastCalledWith("all");
    listeners.state[0](makePlayerState({ repeat: "all" }));
    await store.cycleRepeat();
    expect(api.setRepeat).toHaveBeenLastCalledWith("one");
    listeners.state[0](makePlayerState({ repeat: "one" }));
    await store.cycleRepeat();
    expect(api.setRepeat).toHaveBeenLastCalledWith("off");
  });

  it("forwards play next and stop", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    const tracks = [makeTrack()];
    await store.enqueueNext(tracks);
    await store.stop();
    expect(api.enqueueNext).toHaveBeenCalledWith(tracks);
    expect(api.stop).toHaveBeenCalled();
  });
});

describe("thin bar", () => {
  it("passes the dragged width to the window", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.resizeThin(640);
    expect(api.resizeThin).toHaveBeenCalledWith(640);
  });

  it("the drop-down panel starts closed and the toggle opens it where the window says", async () => {
    const { api, listeners } = fakeApi({ openThinPanel: vi.fn(async () => ({ side: "up" as const, height: 150 })) });
    const store = createStore(api);
    await store.init();
    listeners.queue[0]([makeTrack(), makeTrack(), makeTrack()]);
    expect(store.thinPanelOpen.value).toBe(false);

    await store.toggleThinPanel();

    expect(api.openThinPanel).toHaveBeenCalledWith(panelWantedHeight(3));
    expect(store.thinPanelOpen.value).toBe(true);
    expect(store.thinPanel.value).toEqual({ side: "up", height: 150 });
  });

  it("toggling again closes it", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.toggleThinPanel();
    await store.toggleThinPanel();
    expect(api.closeThinPanel).toHaveBeenCalledTimes(1);
    expect(store.thinPanelOpen.value).toBe(false);
    expect(store.thinPanel.value).toBeNull();
  });

  it("stays closed when the window had no room to open it", async () => {
    const { api } = fakeApi({ openThinPanel: vi.fn(async () => null) });
    const store = createStore(api);
    await store.toggleThinPanel();
    expect(store.thinPanelOpen.value).toBe(false);
  });

  it("closing a panel that is not open does nothing", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.closeThinPanel();
    expect(api.closeThinPanel).not.toHaveBeenCalled();
  });

  it("switching window mode closes the panel in the app (the window closes it itself)", async () => {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();
    await store.toggleThinPanel();
    listeners.mode[0]("large");
    expect(store.thinPanelOpen.value).toBe(false);
  });
});

describe("remove from here down", () => {
  it("asks the backend to drop that queue row and everything below it, once", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.removeFromQueueDown(3);
    expect(api.removeFromQueueDown).toHaveBeenCalledTimes(1);
    expect(api.removeFromQueueDown).toHaveBeenCalledWith(3);
    expect(api.removeFromQueue).not.toHaveBeenCalled();
  });
});

describe("playing one song from a list", () => {
  const song = makeTrack({ path: "/m/one.mp3", title: "One" });
  const queued = [makeTrack({ path: "/m/a.mp3", title: "A" }), makeTrack({ path: "/m/b.mp3", title: "B" })];

  async function storeWith(state: Partial<PlayerState>, queue: Track[]) {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();
    listeners.state[0](makePlayerState(state));
    listeners.queue[0](queue);
    return { api, store };
  }

  it("play now with nothing loaded plays the song without disturbing the queue", async () => {
    const { api, store } = await storeWith({ status: "stopped", currentIndex: 0 }, queued);
    await store.playNow(song);
    expect(api.enqueue).toHaveBeenCalledWith([song]);
    expect(api.playIndex).toHaveBeenCalledWith(2);
    expect(api.enqueueNext).not.toHaveBeenCalled();
  });

  it("with nothing playing and an empty queue, the song becomes the queue and plays", async () => {
    const { api, store } = await storeWith({ status: "stopped" }, []);
    await store.playSong(song);
    expect(api.playTracks).toHaveBeenCalledWith([song], 0);
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it("with nothing playing and a queue, the song goes on the end and plays, and the queue stays", async () => {
    const { api, store } = await storeWith({ status: "stopped", currentIndex: 0 }, queued);
    await store.playSong(song);
    expect(api.enqueue).toHaveBeenCalledWith([song]);
    expect(api.playIndex).toHaveBeenCalledWith(2);
    expect(api.playTracks).not.toHaveBeenCalled();
  });

  it("play now puts the song right after the current one and starts it, keeping the rest", async () => {
    const { api, store } = await storeWith({ status: "playing", currentIndex: 0 }, queued);
    await store.playNow(song);
    expect(api.enqueueNext).toHaveBeenCalledWith([song]);
    expect(api.playIndex).toHaveBeenCalledWith(1);
    expect(api.playTracks).not.toHaveBeenCalled();
  });

  it("play now waits for the insert before starting, so the index is the new song", async () => {
    const calls: string[] = [];
    const { api, listeners } = fakeApi({
      enqueueNext: vi.fn(async () => void calls.push("insert")),
      playIndex: vi.fn(async () => void calls.push("play")),
    });
    const store = createStore(api);
    await store.init();
    listeners.state[0](makePlayerState({ status: "paused", currentIndex: 1 }));
    listeners.queue[0](queued);
    await store.playNow(song);
    expect(calls).toEqual(["insert", "play"]);
    expect(api.playIndex).toHaveBeenCalledWith(2);
  });
});

describe("startup", () => {
  it("has no window mode until the backend answers", async () => {
    let answer!: (m: WindowMode) => void;
    const { api } = fakeApi({ windowMode: vi.fn(() => new Promise<WindowMode>((r) => (answer = r))) });
    const store = createStore(api);

    const started = store.init();
    expect(store.mode.value).toBeNull();
    answer("thin");
    await started;

    expect(store.mode.value).toBe("thin");
  });

  it("sets the mode even when the optional loads fail", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api } = fakeApi({
      windowMode: vi.fn(async () => "thin" as WindowMode),
      cachedLibrary: vi.fn(async () => Promise.reject("cache unreadable")),
    });
    const store = createStore(api);

    await store.init();

    expect(store.mode.value).toBe("thin");
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});

describe("removing from the library", () => {
  const a = makeTrack({ path: "/m/a.mp3", title: "A" });
  const b = makeTrack({ path: "/m/b.mp3", title: "B" });
  const c = makeTrack({ path: "/m/c.mp3", title: "C" });

  async function loaded(overrides: Partial<Api> = {}) {
    const fake = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [a, b, c], scannedAtMs: 1 })),
      ...overrides,
    });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  it("removes the chosen songs from the library and updates the removed count", async () => {
    const { api, store } = await loaded({ removedCount: vi.fn(async () => 2) });

    await store.removeFromLibrary([a, c]);

    expect(api.removeFromLibrary).toHaveBeenCalledWith(["/m/a.mp3", "/m/c.mp3"]);
    expect(store.library.value.map((t) => t.title)).toEqual(["B"]);
    expect(store.removedCount.value).toBe(2);
  });

  it("keeps the library intact and reports the error when removing fails", async () => {
    const { store } = await loaded({ removeFromLibrary: vi.fn(async () => Promise.reject("disk full")) });

    await store.removeFromLibrary([a]);

    expect(store.library.value).toHaveLength(3);
    expect(store.libraryError.value).toBe("disk full");
  });

  it("does nothing for an empty selection", async () => {
    const { api, store } = await loaded();
    await store.removeFromLibrary([]);
    expect(api.removeFromLibrary).not.toHaveBeenCalled();
  });

  it("loads the removed count at startup", async () => {
    const { store } = await loaded({ removedCount: vi.fn(async () => 5) });
    expect(store.removedCount.value).toBe(5);
  });

  it("restoring forgets the removals and rescans the folder", async () => {
    const { api, store } = await loaded({ removedCount: vi.fn(async () => 3) });

    await store.restoreRemoved();

    expect(api.restoreRemoved).toHaveBeenCalled();
    expect(api.scanFolder).toHaveBeenCalledWith("/m");
    expect(store.removedCount.value).toBe(0);
  });
});

describe("reveal in Finder", () => {
  it("sends the songs' paths", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.revealInFinder([makeTrack({ path: "/m/a.mp3" }), makeTrack({ path: "/m/b.mp3" })]);
    expect(api.revealInFinder).toHaveBeenCalledWith(["/m/a.mp3", "/m/b.mp3"]);
  });

  it("does nothing for no songs and reports a failure", async () => {
    const { api } = fakeApi({ revealInFinder: vi.fn(async () => Promise.reject("not mounted")) });
    const store = createStore(api);
    await store.revealInFinder([]);
    expect(api.revealInFinder).not.toHaveBeenCalled();

    await store.revealInFinder([makeTrack()]);
    expect(store.libraryError.value).toBe("not mounted");
  });
});

describe("fixing an unplayable song", () => {
  it("removes it from the library and every queue position, then clears the error", async () => {
    const gone = makeTrack({ path: "/m/gone.wav" });
    const ok = makeTrack({ path: "/m/ok.mp3" });
    const { api, listeners } = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [gone, ok], scannedAtMs: 1 })),
      removedCount: vi.fn(async () => 1),
    });
    const store = createStore(api);
    await store.init();
    listeners.queue[0]([gone, ok, gone]);

    await store.removeUnplayable("/m/gone.wav");

    expect(api.removeFromLibrary).toHaveBeenCalledWith(["/m/gone.wav"]);
    expect(store.library.value.map((t) => t.path)).toEqual(["/m/ok.mp3"]);
    const removed = (api.removeFromQueue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(removed).toEqual([2, 0]);
    expect(api.dismissError).toHaveBeenCalled();
    expect(store.removedCount.value).toBe(1);
  });

  it("leaves everything alone and reports the problem if the library cannot be updated", async () => {
    const { api } = fakeApi({ removeFromLibrary: vi.fn(async () => Promise.reject("disk full")) });
    const store = createStore(api);

    await store.removeUnplayable("/m/gone.wav");

    expect(store.libraryError.value).toBe("disk full");
    expect(api.removeFromQueue).not.toHaveBeenCalled();
    expect(api.dismissError).not.toHaveBeenCalled();
  });

  it("dismissError asks the backend to clear it", async () => {
    const { api } = fakeApi();
    await createStore(api).dismissError();
    expect(api.dismissError).toHaveBeenCalled();
  });
});

describe("trashing duplicate copies", () => {
  const keep = makeTrack({ path: "/m/a.mp3", title: "A" });
  const dup1 = makeTrack({ path: "/m/a 1.mp3", title: "A" });
  const dup2 = makeTrack({ path: "/m/a 2.mp3", title: "A" });

  async function loaded(report: object, extra: Partial<Api> = {}) {
    const fake = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [keep, dup1, dup2], scannedAtMs: 1 })),
      trashDuplicates: vi.fn(async () => report as never),
      ...extra,
    });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  const pairs = [
    { keep: "/m/a.mp3", extra: "/m/a 1.mp3" },
    { keep: "/m/a.mp3", extra: "/m/a 2.mp3" },
  ];

  it("hides what was trashed from the library and queue, and keeps what was left alone", async () => {
    const { api, store, listeners } = await loaded({
      trashed: ["/m/a 1.mp3"],
      held: [],
      missing: [],
      skipped: [{ path: "/m/a 2.mp3", reason: "Different size from the copy being kept." }],
    });
    listeners.queue[0]([dup1, keep, dup1]);

    await store.trashDuplicates(pairs);

    expect(api.trashDuplicates).toHaveBeenCalledWith(pairs);
    expect(api.removeFromLibrary).toHaveBeenCalledWith(["/m/a 1.mp3"]);
    expect(store.library.value.map((t) => t.path)).toEqual(["/m/a.mp3", "/m/a 2.mp3"]);
    expect((api.removeFromQueue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([2, 0]);
    expect(store.cleanupReport.value?.skipped).toHaveLength(1);
  });

  it("also clears extras that were already gone from disk", async () => {
    const { api, store } = await loaded({ trashed: [], held: [], missing: ["/m/a 2.mp3"], skipped: [] });
    await store.trashDuplicates(pairs);
    expect(api.removeFromLibrary).toHaveBeenCalledWith(["/m/a 2.mp3"]);
  });

  it("changes nothing in the library when everything was skipped", async () => {
    const { api, store } = await loaded({
      trashed: [],
      held: [],
      missing: [],
      skipped: [{ path: "/m/a 1.mp3", reason: "Couldn't move to the Trash: no Trash" }],
    });
    await store.trashDuplicates(pairs);
    expect(api.removeFromLibrary).not.toHaveBeenCalled();
    expect(store.library.value).toHaveLength(3);
    expect(store.cleanupReport.value?.skipped[0].reason).toContain("no Trash");
  });

  it("reports a backend failure and leaves the library alone", async () => {
    const { store } = await loaded({}, { trashDuplicates: vi.fn(async () => Promise.reject("boom")) });
    await store.trashDuplicates(pairs);
    expect(store.libraryError.value).toBe("boom");
    expect(store.library.value).toHaveLength(3);
  });

  it("treats files moved to the holding folder like trashed ones", async () => {
    const { api, store } = await loaded({
      trashed: [],
      held: [
        { path: "/m/a 1.mp3", movedTo: "/m/.mixtape-duplicates/x/a 1.mp3" },
        { path: "/m/a 2.mp3", movedTo: "/m/.mixtape-duplicates/x/a 2.mp3" },
      ],
      holdingFolder: "/m/.mixtape-duplicates/2026-01-01-000000",
      missing: [],
      skipped: [],
    });

    await store.trashDuplicates(pairs);

    expect(api.removeFromLibrary).toHaveBeenCalledWith(["/m/a 1.mp3", "/m/a 2.mp3"]);
    expect(store.library.value.map((t) => t.path)).toEqual(["/m/a.mp3"]);
    expect(store.cleanupReport.value?.holdingFolder).toContain(".mixtape-duplicates");
  });

  it("ignores a second clean-up while one is running", async () => {
    let finish!: (r: object) => void;
    const { api, store } = await loaded(
      {},
      { trashDuplicates: vi.fn(() => new Promise<CleanupReport>((resolve) => (finish = resolve as never))) },
    );

    const first = store.trashDuplicates(pairs);
    await vi.waitFor(() => expect(store.cleaningUp.value).toBe(true));
    await store.trashDuplicates(pairs);
    expect(api.trashDuplicates).toHaveBeenCalledTimes(1);

    finish({ trashed: [], held: [], holdingFolder: null, missing: [], skipped: [] });
    await first;
    expect(store.cleaningUp.value).toBe(false);
  });

  it("does nothing without pairs", async () => {
    const { api, store } = await loaded({ trashed: [], held: [], missing: [], skipped: [] });
    await store.trashDuplicates([]);
    expect(api.trashDuplicates).not.toHaveBeenCalled();
  });
});

describe("noticing duplicates after a scan", () => {
  const memory = (): FlagStorage => {
    const data: Record<string, string> = {};
    return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  };
  const dupe = (path: string) =>
    makeTrack({ path, title: "Spiderwebs", artist: "No Doubt", album: "Tragic Kingdom", durationMs: 268_000 });
  const withDupes = [dupe("/m/a.mp3"), dupe("/m/a 1.mp3"), makeTrack({ path: "/m/other.mp3", title: "Other" })];

  function storeScanning(tracks: Track[], storage = memory()) {
    const { api } = fakeApi({ scanFolder: vi.fn(async () => tracks) });
    return { store: createStore(api, storage), storage };
  }

  it("announces new duplicate songs once after a scan", async () => {
    const { store } = storeScanning(withDupes);
    await store.openFolder();
    expect(store.duplicateNotice.value).toBe(1);

    store.dismissDuplicateNotice();
    await store.refresh();
    expect(store.duplicateNotice.value).toBe(0);
  });

  it("does not announce when there are none, or for the saved library shown at startup", async () => {
    const clean = storeScanning([makeTrack({ path: "/m/x.mp3" })]);
    await clean.store.openFolder();
    expect(clean.store.duplicateNotice.value).toBe(0);

    const { api } = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: withDupes, scannedAtMs: 1 })),
    });
    const store = createStore(api, memory());
    await store.init();
    expect(store.duplicateGroups.value).toHaveLength(1);
    expect(store.duplicateNotice.value).toBe(0);
  });

  it("remembers what it announced across restarts, but announces genuinely new groups", async () => {
    const storage = memory();
    const first = storeScanning(withDupes, storage);
    await first.store.openFolder();

    const second = storeScanning(withDupes, storage);
    await second.store.openFolder();
    expect(second.store.duplicateNotice.value).toBe(0);

    const another = [
      ...withDupes,
      makeTrack({ path: "/m/z.mp3", title: "Zed" }),
      makeTrack({ path: "/m/z 1.mp3", title: "Zed" }),
    ];
    const third = storeScanning(another, storage);
    await third.store.openFolder();
    expect(third.store.duplicateNotice.value).toBe(1);
  });

  it("a group marked Not a duplicate leaves the list and is never announced", async () => {
    const { store } = storeScanning(withDupes);
    await store.openFolder();
    expect(store.duplicateGroups.value).toHaveLength(1);

    store.ignoreDuplicate(store.duplicateGroups.value[0].key);
    expect(store.duplicateGroups.value).toHaveLength(0);
    expect(store.ignoredDuplicates.value.size).toBe(1);

    store.resetIgnoredDuplicates();
    expect(store.duplicateGroups.value).toHaveLength(1);
  });
});

describe("writing tags", () => {
  const a = makeTrack({ path: "/m/a.mp3", title: "Old A" });
  const b = makeTrack({ path: "/m/b.mp3", title: "Old B" });

  async function loaded(results: object[], extra: Partial<Api> = {}) {
    const fake = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [a, b], scannedAtMs: 1 })),
      writeTags: vi.fn(async () => results as never),
      ...extra,
    });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  it("updates the library with what was re-read, for the files that succeeded only", async () => {
    const { api, store } = await loaded([
      { path: "/m/a.mp3", track: { ...a, title: "New A" }, error: null },
      { path: "/m/b.mp3", track: null, error: "Can't read this file." },
    ]);

    await store.writeTags([a, b], { title: "New" });

    expect(api.writeTags).toHaveBeenCalledWith(["/m/a.mp3", "/m/b.mp3"], { title: "New" });
    expect(store.library.value.map((t) => t.title)).toEqual(["New A", "Old B"]);
    expect(store.tagResults.value?.[1].error).toBe("Can't read this file.");
    expect(store.writingTags.value).toBe(false);
  });

  it("does nothing for no songs or no changes", async () => {
    const { api, store } = await loaded([]);
    await store.writeTags([], { title: "x" });
    await store.writeTags([a], {});
    expect(api.writeTags).not.toHaveBeenCalled();
  });

  it("reports a failed call and leaves the library alone", async () => {
    const { store } = await loaded([], { writeTags: vi.fn(async () => Promise.reject("boom")) });
    await store.writeTags([a], { title: "x" });
    expect(store.libraryError.value).toBe("boom");
    expect(store.library.value.map((t) => t.title)).toEqual(["Old A", "Old B"]);
    expect(store.writingTags.value).toBe(false);
  });
});

describe("library songs in Picard", () => {
  const a = makeTrack({ path: "/m/Korn/Follow/old.mp3", title: "Old", artist: "Korn", album: "Follow" });
  const b = makeTrack({ path: "/m/Korn/Follow/other.mp3", title: "Other", artist: "Korn", album: "Follow" });
  const c = makeTrack({ path: "/m/PROF/Unknown/Dynamite.mp3", title: "Dynamite", artist: "PROF" });

  async function loaded(overrides: Partial<Api> = {}) {
    const fake = fakeApi({ cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [a, b, c], scannedAtMs: 1 })), ...overrides });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  it("sends the songs to Picard and remembers their folders", async () => {
    const { api, store } = await loaded();
    await store.openInPicard([a, b, c]);
    expect(api.picardOpenFiles).toHaveBeenCalledWith([a.path, b.path, c.path]);
    expect(Object.keys(store.picardFolders.value).sort()).toEqual(["/m/Korn/Follow", "/m/PROF/Unknown"]);
  });

  it("shows why Picard could not be opened and remembers nothing", async () => {
    const { store } = await loaded({ picardOpenFiles: vi.fn(async () => Promise.reject("Picard isn't installed.")) });
    await store.openInPicard([a]);
    expect(store.libraryError.value).toContain("isn't installed");
    expect(store.picardFolders.value).toEqual({});
  });

  it("does nothing for no songs", async () => {
    const { api, store } = await loaded();
    await store.openInPicard([]);
    expect(api.picardOpenFiles).not.toHaveBeenCalled();
  });

  it("when the user comes back, re-checks those folders and applies what Picard changed", async () => {
    const renamed = makeTrack({ path: "/m/Korn/Follow/1-03 Got the Life.mp3", title: "Got the Life", artist: "Korn", album: "Follow" });
    const { api, store } = await loaded({ refreshFolders: vi.fn(async () => [{ dir: "/m/Korn/Follow", tracks: [renamed, b] }]) });
    await store.openInPicard([a]);

    await store.refreshPicardFolders();

    expect(api.refreshFolders).toHaveBeenCalledWith(["/m/Korn/Follow"]);
    expect(store.library.value.map((t) => t.path).sort()).toEqual([renamed.path, b.path, c.path].sort());
    // Still being watched: the user may save in Picard later.
    expect(Object.keys(store.picardFolders.value)).toEqual(["/m/Korn/Follow"]);
  });

  it("does nothing when no songs were sent, and forgets folders sent long ago", async () => {
    const { api, store } = await loaded();
    await store.refreshPicardFolders();
    expect(api.refreshFolders).not.toHaveBeenCalled();

    await store.openInPicard([a]);
    await store.refreshPicardFolders(Date.now() + 31 * 60 * 1000);
    expect(api.refreshFolders).not.toHaveBeenCalled();
    expect(store.picardFolders.value).toEqual({});
  });

  it("keeps the library as it was if the re-check fails", async () => {
    const { store } = await loaded({ refreshFolders: vi.fn(async () => Promise.reject("not mounted")) });
    await store.openInPicard([a]);
    await store.refreshPicardFolders();
    expect(store.library.value).toHaveLength(3);
    expect(store.libraryError.value).toBe("not mounted");
  });
});

describe("updates reach the queue and are easy to find", () => {
  const stale = makeTrack({ path: "/m/PROF/Unknown Album/Dynamite.mp3", title: "Dynamite", artist: "PROF", durationMs: 165_000 });
  const readded = makeTrack({ path: "/m/PROF/Good Time Boy/06 Dynamite.mp3", title: "Dynamite", artist: "Prof", album: "Good Time Boy", durationMs: 165_100 });

  async function withQueue(queue: Track[], library: Track[], overrides: Partial<Api> = {}) {
    const fake = fakeApi({ cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: library, scannedAtMs: 1 })), ...overrides });
    const store = createStore(fake.api);
    await store.init();
    fake.listeners.queue[0](queue);
    return { ...fake, store };
  }

  it("a song added to the library points a stale queue entry at it and raises a notice", async () => {
    const { api, store } = await withQueue([stale], [makeTrack({ path: "/m/other.mp3", title: "Other" })]);

    store.addToLibrary(readded);

    expect(api.replaceQueueTracks).toHaveBeenCalledWith([{ oldPath: stale.path, track: readded }]);
    expect(store.lastChange.value).toEqual({ message: "Added: Prof – Dynamite", track: readded });
    expect(store.library.value.map((t) => t.path)).toContain(readded.path);
  });

  it("an add that matches nothing in the queue leaves the queue alone but still raises a notice", async () => {
    const { api, store } = await withQueue([makeTrack({ path: "/m/x.mp3", title: "Something else" })], []);
    store.addToLibrary(readded);
    expect(api.replaceQueueTracks).not.toHaveBeenCalled();
    expect(store.lastChange.value?.message).toContain("Dynamite");
  });

  it("a folder re-check that retagged a song updates the queue and says so", async () => {
    const fresh = { ...stale, album: "Good Time Boy" };
    const { api, store } = await withQueue([stale], [stale], { refreshFolders: vi.fn(async () => [{ dir: "/m/PROF/Unknown Album", tracks: [fresh] }]) });
    await store.openInPicard([stale]);

    await store.refreshPicardFolders();

    expect(api.replaceQueueTracks).toHaveBeenCalledWith([{ oldPath: stale.path, track: fresh }]);
    expect(store.lastChange.value?.message).toBe("Updated from Picard: Dynamite");
  });

  it("a re-check that found nothing new raises no notice", async () => {
    const { store } = await withQueue([stale], [stale], { refreshFolders: vi.fn(async () => [{ dir: "/m/PROF/Unknown Album", tracks: [stale] }]) });
    await store.openInPicard([stale]);
    await store.refreshPicardFolders();
    expect(store.lastChange.value).toBeNull();
  });

  it("saving tags in the editor updates the queue entry for that file", async () => {
    const edited = { ...stale, album: "Edited" };
    const { api, store } = await withQueue([stale], [stale], {
      writeTags: vi.fn(async () => [{ path: stale.path, track: edited, error: null }]),
    });

    await store.writeTags([stale], { album: "Edited" });

    expect(api.replaceQueueTracks).toHaveBeenCalledWith([{ oldPath: stale.path, track: edited }]);
    expect(store.lastChange.value?.message).toBe("Saved tags: Dynamite");
  });

  it("the notice can be dismissed", async () => {
    const { store } = await withQueue([], []);
    store.addToLibrary(readded);
    store.dismissChange();
    expect(store.lastChange.value).toBeNull();
  });
});
