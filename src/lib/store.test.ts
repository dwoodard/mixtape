import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import { createStore } from "./store";
import { makePlayerState, makeTrack } from "./testing";
import type { PlayerState, Track, WindowMode } from "./types";

function fakeApi(overrides: Partial<Api> = {}) {
  const listeners = {
    state: [] as ((s: PlayerState) => void)[],
    queue: [] as ((q: Track[]) => void)[],
    position: [] as ((ms: number) => void)[],
    mode: [] as ((m: WindowMode) => void)[],
  };
  const unlisten = vi.fn();
  const api: Api = {
    snapshot: vi.fn(async () => ({ state: makePlayerState(), queue: [] })),
    windowMode: vi.fn(async () => "large" as WindowMode),
    pickFolder: vi.fn(async () => "/music"),
    scanFolder: vi.fn(async () => [makeTrack()]),
    playTracks: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    playIndex: vi.fn(async () => {}),
    toggle: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    removeFromQueue: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    toggleWindowMode: vi.fn(async () => "thin" as WindowMode),
    quit: vi.fn(async () => {}),
    onState: vi.fn(async (cb) => (listeners.state.push(cb), unlisten)),
    onQueue: vi.fn(async (cb) => (listeners.queue.push(cb), unlisten)),
    onPosition: vi.fn(async (cb) => (listeners.position.push(cb), unlisten)),
    onWindowMode: vi.fn(async (cb) => (listeners.mode.push(cb), unlisten)),
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
    expect(unlisten).toHaveBeenCalledTimes(4);
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
