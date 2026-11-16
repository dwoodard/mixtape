import { describe, expect, it, vi } from "vitest";
import { createPlaybackEvents } from "./playbackEvents";
import { createDjEvents, QUEUE_ENDED_PROMPT } from "./djEvents";
import { makePlayerState, makeTrack } from "./testing";

const songs = [makeTrack({ path: "/a.mp3" }), makeTrack({ path: "/b.mp3" })];
const playingLast = makePlayerState({ status: "playing", currentIndex: 1, currentTrack: songs[1], positionMs: 59_900, durationMs: 60_000 });
const stoppedAtLast = makePlayerState({ status: "stopped", currentIndex: 1, currentTrack: songs[1], positionMs: 0, durationMs: 60_000 });

function setup() {
  const bus = createPlaybackEvents();
  const ended = vi.fn();
  const emptied = vi.fn();
  bus.on("queue-ended", ended);
  bus.on("queue-emptied", emptied);
  return { bus, ended, emptied };
}

describe("playback events", () => {
  it("fires queue-ended when the last song finishes by itself", () => {
    const { bus, ended } = setup();
    bus.observe(playingLast, songs);
    bus.observe(stoppedAtLast, songs);
    expect(ended).toHaveBeenCalledWith({ last: songs[1] });
  });

  it("does not fire when the person stops a song in the middle", () => {
    const { bus, ended } = setup();
    bus.observe({ ...playingLast, positionMs: 10_000 }, songs);
    bus.observe(stoppedAtLast, songs);
    expect(ended).not.toHaveBeenCalled();
  });

  it("does not fire when songs are still left or the queue repeats", () => {
    const { bus, ended } = setup();
    bus.observe({ ...playingLast, currentIndex: 0 }, songs);
    bus.observe({ ...stoppedAtLast, currentIndex: 0 }, songs);
    bus.observe({ ...playingLast, repeat: "all" }, songs);
    bus.observe({ ...stoppedAtLast, repeat: "all" }, songs);
    expect(ended).not.toHaveBeenCalled();
  });

  it("fires queue-emptied once when the last song leaves the queue, not queue-ended", () => {
    const { bus, ended, emptied } = setup();
    bus.observe(playingLast, songs);
    bus.observe(makePlayerState(), []);
    bus.observe(makePlayerState(), []);
    expect(emptied).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });

  it("stops calling a listener once it is removed, and survives a throwing one", () => {
    const bus = createPlaybackEvents();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const late = vi.fn();
    bus.on("queue-emptied", () => {
      throw new Error("boom");
    });
    const off = bus.on("queue-emptied", late);
    bus.observe(playingLast, songs);
    bus.observe(makePlayerState(), []);
    off();
    bus.observe(playingLast, songs);
    bus.observe(makePlayerState(), []);
    expect(late).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("DJ event rules", () => {
  function dj(saved: Record<string, string> = {}) {
    const bus = createPlaybackEvents();
    const chat = { send: vi.fn(async (_: string) => {}), busy: { value: false } };
    const data = new Map<string, string>(Object.entries(saved));
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const events = createDjEvents(bus, chat, storage);
    const finish = () => {
      bus.observe(playingLast, songs);
      bus.observe(stoppedAtLast, songs);
    };
    const clear = () => {
      bus.observe(playingLast, songs);
      bus.observe(makePlayerState(), []);
    };
    return { events, chat, finish, clear, data };
  }

  it("comes with a queue-ended rule, and asks the DJ for more only while attached", async () => {
    const { events, chat, finish } = dj();
    expect(events.rules.value).toHaveLength(1);
    finish();
    expect(chat.send).not.toHaveBeenCalled();
    events.attach();
    finish();
    expect(chat.send).toHaveBeenCalledWith(QUEUE_ENDED_PROMPT);
    events.detach();
    finish();
    expect(chat.send).toHaveBeenCalledTimes(1);
  });

  it("runs added rules for their event, skips switched-off and removed ones", () => {
    const { events, chat, finish, clear } = dj();
    events.attach();
    events.add("queue-emptied", "  Say goodbye  ");
    events.add("queue-emptied", "   ");
    expect(events.rules.value).toHaveLength(2);
    clear();
    expect(chat.send).toHaveBeenCalledWith("Say goodbye");
    const [, added] = events.rules.value;
    events.toggle(added.id);
    clear();
    expect(chat.send).toHaveBeenCalledTimes(1);
    events.remove(events.rules.value[0].id);
    finish();
    expect(chat.send).toHaveBeenCalledTimes(1);
  });

  it("does not ask while the DJ is busy", () => {
    const { events, chat, finish } = dj();
    events.attach();
    chat.busy.value = true;
    finish();
    expect(chat.send).not.toHaveBeenCalled();
  });

  it("remembers what is attached and the rules, and ignores corrupt saved rules", () => {
    const { events, data } = dj();
    events.attach();
    events.add("queue-ended", "More please");
    expect(data.get("mixtape.dj.attached")).toBe("1");
    const again = dj(Object.fromEntries(data));
    expect(again.events.attached.value).toBe(true);
    expect(again.events.rules.value.map((r) => r.prompt)).toContain("More please");
    expect(dj({ "mixtape.dj.events": "{nope" }).events.rules.value).toHaveLength(1);
    expect(dj({ "mixtape.dj.events": JSON.stringify([{ id: "x", event: "bogus", prompt: "p", enabled: true }]) }).events.rules.value).toHaveLength(0);
  });
});
