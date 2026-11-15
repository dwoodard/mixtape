import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { createStore } from "./store";
import type { FlagStorage } from "./ui";
import { makePlayerState, makeTrack } from "./testing";
import { panelWantedHeight } from "./thinBar";
import type { CleanupReport, PlayerState, PlayStat, ScanProgress, Track, WindowMode } from "./types";

function fakeApi(overrides: Partial<Api> = {}) {
  const listeners = {
    state: [] as ((s: PlayerState) => void)[],
    queue: [] as ((q: Track[]) => void)[],
    position: [] as ((ms: number) => void)[],
    mode: [] as ((m: WindowMode) => void)[],
    scan: [] as ((p: ScanProgress) => void)[],
    scanTracks: [] as ((t: Track[]) => void)[],
    played: [] as ((p: { path: string } & PlayStat) => void)[],
  };
  const unlisten = vi.fn();
  const api: Api = {
    snapshot: vi.fn(async () => ({ state: makePlayerState(), queue: [] })),
    playStats: vi.fn(async () => ({}) as Record<string, PlayStat>),
    windowMode: vi.fn(async () => "large" as WindowMode),
    pickFolder: vi.fn(async () => "/music"),
    scanFolder: vi.fn(async () => [makeTrack()]),
    musicFolder: vi.fn(async () => "/nas/music" as string | null),
    importLibrary: vi.fn(async () => [makeTrack()]),
    cancelScan: vi.fn(async () => {}),
    cachedLibrary: vi.fn(async () => null),
    removeFromLibrary: vi.fn(async () => {}),
    inspectFile: vi.fn(async () => ({}) as never),
    readLyrics: vi.fn(async () => null),
    fixLength: vi.fn(async () => makeTrack()),
    revealInFinder: vi.fn(async () => {}),
    openLink: vi.fn(async () => {}),
    writeTags: vi.fn(async () => []),
    missingCovers: vi.fn(async () => [] as string[]),
    pickImage: vi.fn(async () => null as string | null),
    importTools: vi.fn(async () => ({ ytDlp: "/bin/yt-dlp", ffmpeg: "/bin/ffmpeg", picard: "/Applications/MusicBrainz Picard.app" })),
    importList: vi.fn(async () => []),
    importAddLink: vi.fn(async () => {}),
    pickAudioFiles: vi.fn(async () => [] as string[]),
    importAddFiles: vi.fn(async () => 0),
    importSetTags: vi.fn(async () => ({}) as never),
    importAdd: vi.fn(async () => makeTrack()),
    importOpenInPicard: vi.fn(async () => {}),
    importReveal: vi.fn(async () => {}),
    importStop: vi.fn(async () => 0),
    importFetch: vi.fn(async () => 0),
    importCancelPicard: vi.fn(async () => {}),
    replaceQueueTracks: vi.fn(async () => {}),
    moveQueueTrack: vi.fn(async () => {}),
    picardOpenFiles: vi.fn(async () => {}),
    refreshFolders: vi.fn(async () => []),
    importUndo: vi.fn(async () => ""),
    importRemove: vi.fn(async () => {}),
    onImportEvent: vi.fn(async () => unlisten),
    trashDuplicates: vi.fn(async () => ({ trashed: [], held: [], holdingFolder: null, missing: [], skipped: [] })),
    moveSongs: vi.fn(async () => ({ moved: [], failed: [] })),
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
    onSpectrum: vi.fn(async () => unlisten),
    onScanProgress: vi.fn(async (cb) => (listeners.scan.push(cb), unlisten)),
    onScanTracks: vi.fn(async (cb) => (listeners.scanTracks.push(cb), unlisten)),
    onPlayed: vi.fn(async (cb) => (listeners.played.push(cb), unlisten)),
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
    expect(unlisten).toHaveBeenCalledTimes(7);
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

  it("checks each song for a cover once, and drops it from the list when new art is written", async () => {
    const { api, store } = await loaded(
      [{ path: "/m/a.mp3", track: a, error: null }],
      { missingCovers: vi.fn(async (paths: string[]) => paths) },
    );

    await store.checkCovers();
    expect([...store.coverless.value].sort()).toEqual(["/m/a.mp3", "/m/b.mp3"]);
    await store.checkCovers();
    expect(api.missingCovers).toHaveBeenCalledTimes(1);

    await store.writeTags([a], { coverUrl: "https://example.com/c.jpg" });
    expect([...store.coverless.value]).toEqual(["/m/b.mp3"]);
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
    const { api, store } = await loaded({ refreshFolders: vi.fn(async () => [{ dir: "/m/Korn", tracks: [renamed, b] }]) });
    await store.openInPicard([a]);

    await store.refreshPicardFolders();

    // The artist folder, not just the album: a rename can move a song to another album folder.
    expect(api.refreshFolders).toHaveBeenCalledWith(["/m/Korn"]);
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

describe("songs appear while a new folder is scanned", () => {
  const song = (artist: string, title: string) => makeTrack({ path: `/new/${title}.mp3`, artist, title });

  async function startScan(existing: Track[] = []) {
    let finish!: (tracks: Track[]) => void;
    let fail!: (e: unknown) => void;
    const { api, listeners } = fakeApi({
      cachedLibrary: vi.fn(async () => (existing.length ? { folder: "/old", tracks: existing, scannedAtMs: 1 } : null)),
      scanFolder: vi.fn(() => new Promise<Track[]>((resolve, reject) => ((finish = resolve), (fail = reject)))),
    });
    const store = createStore(api);
    await store.init();
    const opening = store.openFolder();
    await vi.waitFor(() => expect(api.scanFolder).toHaveBeenCalled());
    return { store, listeners, finish: (t: Track[]) => finish(t), fail: (e: unknown) => fail(e), opening };
  }

  it("shows batches in scan order as they arrive, then the final list", async () => {
    vi.useFakeTimers();
    try {
      const { store, listeners, finish, opening } = await startScan([makeTrack({ path: "/old/a.mp3", title: "Old" })]);
      expect(store.library.value).toEqual([]);

      listeners.scanTracks[0]([song("Zed", "z1"), song("Abba", "a1")]);
      listeners.scanTracks[0]([song("Mid", "m1")]);
      await vi.advanceTimersByTimeAsync(250);
      expect(store.library.value.map((t) => t.title)).toEqual(["a1", "m1", "z1"]);

      finish([song("Abba", "a1"), song("Mid", "m1"), song("Zed", "z1")]);
      await opening;
      expect(store.library.value.map((t) => t.title)).toEqual(["a1", "m1", "z1"]);
      expect(store.scanning.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the previous library back when the scan is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const old = [makeTrack({ path: "/old/a.mp3", title: "Old" })];
      const { store, listeners, fail, opening } = await startScan(old);
      listeners.scanTracks[0]([song("Abba", "a1")]);
      await vi.advanceTimersByTimeAsync(250);
      expect(store.library.value.map((t) => t.title)).toEqual(["a1"]);

      fail("cancelled");
      await opening;
      expect(store.library.value).toEqual(old);
      expect(store.folder.value).toBe("/old");
      expect(store.scanError.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores songs that arrive when no scan is streaming", async () => {
    const { api, listeners } = fakeApi();
    const store = createStore(api);
    await store.init();
    listeners.scanTracks[0]([song("Abba", "late")]);
    expect(store.library.value).toEqual([]);
  });
});

describe("play counts", () => {
  it("loads the saved counts at start and follows each new play", async () => {
    const { api, listeners } = fakeApi({ playStats: vi.fn(async () => ({ "/a.mp3": { count: 2, lastPlayedMs: 100 } })) });
    const store = createStore(api);
    await store.init();
    expect(store.plays.value["/a.mp3"]).toEqual({ count: 2, lastPlayedMs: 100 });

    listeners.played[0]({ path: "/a.mp3", count: 3, lastPlayedMs: 200 });
    listeners.played[0]({ path: "/b.mp3", count: 1, lastPlayedMs: 300 });

    expect(store.plays.value).toEqual({
      "/a.mp3": { count: 3, lastPlayedMs: 200 },
      "/b.mp3": { count: 1, lastPlayedMs: 300 },
    });
  });

  it("a failed load of the counts does not stop the app starting", async () => {
    const { api } = fakeApi({ playStats: vi.fn(async () => Promise.reject("no file")) });
    const store = createStore(api);
    await store.init();
    expect(store.plays.value).toEqual({});
  });
});

describe("clear others", () => {
  async function queueOf(n: number) {
    const tracks = Array.from({ length: n }, (_, i) => makeTrack({ path: `/m/${i}.mp3`, title: `S${i}` }));
    const { api, listeners } = fakeApi({ snapshot: vi.fn(async () => ({ state: makePlayerState(), queue: tracks })) });
    const store = createStore(api);
    await store.init();
    return { api, store, listeners };
  }

  it("removes everything below in one step, then everything above from the bottom up", async () => {
    const { api, store } = await queueOf(5);
    await store.clearOtherQueueSongs(2);
    expect(api.removeFromQueueDown).toHaveBeenCalledWith(3);
    expect(vi.mocked(api.removeFromQueue).mock.calls).toEqual([[1], [0]]);
  });

  it("leaves out the step with nothing to remove, for the first and the last song", async () => {
    const first = await queueOf(3);
    await first.store.clearOtherQueueSongs(0);
    expect(first.api.removeFromQueueDown).toHaveBeenCalledWith(1);
    expect(first.api.removeFromQueue).not.toHaveBeenCalled();

    const last = await queueOf(3);
    await last.store.clearOtherQueueSongs(2);
    expect(last.api.removeFromQueueDown).not.toHaveBeenCalled();
    expect(vi.mocked(last.api.removeFromQueue).mock.calls).toEqual([[1], [0]]);
  });

  it("does nothing for a one-song queue or a row that is not there", async () => {
    const one = await queueOf(1);
    await one.store.clearOtherQueueSongs(0);
    const many = await queueOf(3);
    await many.store.clearOtherQueueSongs(9);
    for (const { api } of [one, many]) {
      expect(api.removeFromQueueDown).not.toHaveBeenCalled();
      expect(api.removeFromQueue).not.toHaveBeenCalled();
    }
  });
});

describe("thin bar panel: queue and DJ", () => {
  it("opens the DJ at its own height and closes it when asked again", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.toggleThinView("dj", 500);
    expect(api.openThinPanel).toHaveBeenCalledWith(420);
    expect(store.thinPanelView.value).toBe("dj");
    expect(api.resizeThin).not.toHaveBeenCalled();

    await store.toggleThinView("dj", 500);
    expect(store.thinPanelOpen.value).toBe(false);
    expect(api.closeThinPanel).toHaveBeenCalledOnce();
  });

  it("widens a bar that is too narrow for the chat before opening it", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.toggleThinView("dj", 200);
    expect(api.resizeThin).toHaveBeenCalledWith(340);
    // The queue does not need the room.
    await store.toggleThinView("queue", 200);
    expect(vi.mocked(api.resizeThin)).toHaveBeenCalledTimes(1);
  });

  it("switching between the queue and the DJ re-opens the panel at the other height", async () => {
    const { api } = fakeApi();
    const store = createStore(api);
    await store.toggleThinPanel();
    expect(store.thinPanelView.value).toBe("queue");
    expect(api.openThinPanel).toHaveBeenLastCalledWith(panelWantedHeight(0));

    await store.toggleThinView("dj", 500);
    expect(api.closeThinPanel).toHaveBeenCalledOnce();
    expect(api.openThinPanel).toHaveBeenLastCalledWith(420);
    expect(store.thinPanelView.value).toBe("dj");
    expect(store.thinPanelOpen.value).toBe(true);
  });
});

describe("fixing a wrong length", () => {
  it("updates the song in the library and the queue, never touching the file", async () => {
    const wrong = makeTrack({ path: "/m/blue.mp3", title: "Blue", durationMs: 1_513_926 });
    const fixed = { ...wrong, durationMs: 252_317 };
    const { api } = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [wrong], scannedAtMs: 1 })),
      snapshot: vi.fn(async () => ({ state: makePlayerState(), queue: [wrong] })),
      fixLength: vi.fn(async () => fixed),
    });
    const store = createStore(api);
    await store.init();

    expect(await store.fixLength(wrong, 252_317)).toBeNull();

    expect(api.fixLength).toHaveBeenCalledWith("/m/blue.mp3", 252_317);
    expect(store.library.value[0].durationMs).toBe(252_317);
    expect(store.lastChange.value?.message).toBe("Length corrected: Blue");
    expect(api.replaceQueueTracks).toHaveBeenCalled();
  });

  it("reports what went wrong and changes nothing", async () => {
    const song = makeTrack({ path: "/m/a.mp3", durationMs: 9 });
    const { api } = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [song], scannedAtMs: 1 })),
      fixLength: vi.fn(async () => Promise.reject("That song is not in the saved library.")),
    });
    const store = createStore(api);
    await store.init();
    expect(await store.fixLength(song, 100)).toBe("That song is not in the saved library.");
    expect(store.library.value[0].durationMs).toBe(9);
  });

  it("checks a song against its stored length", async () => {
    const song = makeTrack({ path: "/m/a.mp3", durationMs: 1234 });
    const { api } = fakeApi();
    await createStore(api).inspectFile(song);
    expect(api.inspectFile).toHaveBeenCalledWith("/m/a.mp3", 1234);
  });
});

describe("targeted refresh after an add", () => {
  const root = "/lib";
  const song = (path: string, title = "T") => makeTrack({ path, title, artist: "Primus", album: "Pork Soda" });
  async function ready(over: Partial<Api> = {}) {
    const fake = fakeApi({ cachedLibrary: vi.fn(async () => ({ folder: root, tracks: [], scannedAtMs: 1 })), ...over });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  it("re-checks only the folder the song went into, a moment after the add", async () => {
    vi.useFakeTimers();
    try {
      const { api, store } = await ready();
      store.addToLibrary(song(`${root}/Primus/Pork Soda/02 My Name Is Mud.mp3`));
      expect(api.refreshFolders).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1300);
      expect(api.refreshFolders).toHaveBeenCalledOnce();
      expect(api.refreshFolders).toHaveBeenCalledWith([`${root}/Primus/Pork Soda`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks each folder once however many songs were added, and says what it found next to them", async () => {
    vi.useFakeTimers();
    try {
      const copy = song(`${root}/Primus/Pork Soda/02 My Name Is Mud (2).mp3`, "My Name Is Mud");
      const { api, store } = await ready({ refreshFolders: vi.fn(async () => [{ dir: `${root}/Primus/Pork Soda`, tracks: [copy] }]) });
      for (let i = 1; i <= 5; i++) store.addToLibrary(song(`${root}/Primus/Pork Soda/0${i} Song.mp3`, `S${i}`));
      store.addToLibrary(song(`${root}/Primus/Seas/01 Other.mp3`, "Other"));

      await vi.advanceTimersByTimeAsync(1300);

      expect(api.refreshFolders).toHaveBeenCalledOnce();
      expect(api.refreshFolders).toHaveBeenCalledWith([`${root}/Primus/Pork Soda`, `${root}/Primus/Seas`]);
      expect(store.library.value.some((t) => t.path === copy.path)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a song outside the library folder, and reports a failure without losing the list", async () => {
    vi.useFakeTimers();
    try {
      const { api, store } = await ready();
      store.addToLibrary(song("/Users/dustin/Downloads/music/a.mp3"));
      await vi.advanceTimersByTimeAsync(1300);
      expect(api.refreshFolders).not.toHaveBeenCalled();

      const failing = await ready({ refreshFolders: vi.fn(async () => Promise.reject("The drive is not mounted.")) });
      failing.store.addToLibrary(song(`${root}/Primus/Pork Soda/01 Song.mp3`));
      await vi.advanceTimersByTimeAsync(1300);
      expect(failing.store.libraryError.value).toContain("not mounted");
      expect(failing.store.library.value).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("widens to the artist folder when asked, for songs something may have renamed", async () => {
    vi.useFakeTimers();
    try {
      const { api, store } = await ready();
      store.refreshAround([`${root}/Primus/Frizzle Fry (Remastered)/Too Many Puppies.mp3`], { widen: true });
      await vi.advanceTimersByTimeAsync(1300);
      expect(api.refreshFolders).toHaveBeenCalledWith([`${root}/Primus`]);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("moving songs to another folder", () => {
  const old = makeTrack({ path: "/m/Forrest_/s/a.mp3", title: "A" });
  const other = makeTrack({ path: "/m/Forrest Frank/b.mp3", title: "B" });
  const moved = makeTrack({ path: "/m/Forrest Frank/s/a.mp3", title: "A" });

  async function loaded(result: object) {
    const fake = fakeApi({
      cachedLibrary: vi.fn(async () => ({ folder: "/m", tracks: [old, other], scannedAtMs: 1 })),
      moveSongs: vi.fn(async () => result as never),
    });
    const store = createStore(fake.api);
    await store.init();
    return { ...fake, store };
  }

  it("swaps a moved song for the one read at its new place, in the library and the queue", async () => {
    const { api, store, listeners } = await loaded({ moved: [{ from: old.path, track: moved }], failed: [] });
    listeners.queue[0]([old]);

    const out = await store.moveSongs([{ path: old.path, folder: "/m/Forrest Frank/s" }]);

    expect(api.moveSongs).toHaveBeenCalledWith([{ path: old.path, folder: "/m/Forrest Frank/s" }]);
    expect(out.moved).toBe(1);
    expect(store.library.value.map((t) => t.path).sort()).toEqual([moved.path, other.path].sort());
    expect(api.replaceQueueTracks).toHaveBeenCalledWith([{ oldPath: old.path, track: moved }]);
  });

  it("keeps a song that could not move and reports why", async () => {
    const { store } = await loaded({ moved: [], failed: [{ path: old.path, error: "a file with that name is already in that folder" }] });
    const out = await store.moveSongs([{ path: old.path, folder: "/m/Forrest Frank/s" }]);
    expect(out.moved).toBe(0);
    expect(out.failed[0].error).toContain("already");
    expect(store.library.value.map((t) => t.path)).toContain(old.path);
  });
});
