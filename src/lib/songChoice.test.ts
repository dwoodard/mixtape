import { describe, expect, it, vi } from "vitest";
import { enterAction, songChoiceItems } from "./songChoice";
import { makeTrack } from "./testing";

const song = makeTrack({ path: "/m/one.mp3", title: "One" });

function actions() {
  return { playNow: vi.fn(), enqueueNext: vi.fn(), enqueue: vi.fn() };
}

describe("enterAction", () => {
  it("does nothing with no song selected, so it never plays the rest of the view", () => {
    expect(enterAction(0)).toBe("none");
  });
  it("treats one selected song like a double-click", () => {
    expect(enterAction(1)).toBe("choose");
  });
  it("plays a multi-selection as before", () => {
    expect(enterAction(3)).toBe("play-selection");
  });
});

describe("songChoiceItems", () => {
  it("offers Play now, Play next and Add to queue, in that order", () => {
    expect(songChoiceItems(song, actions()).map((i) => i.label)).toEqual(["Play now", "Play next", "Add to queue"]);
  });

  it("running nothing (Esc, clicking away) changes nothing", () => {
    const a = actions();
    songChoiceItems(song, a);
    expect(a.playNow).not.toHaveBeenCalled();
    expect(a.enqueueNext).not.toHaveBeenCalled();
    expect(a.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["Play now", "playNow", song],
    ["Play next", "enqueueNext", [song]],
    ["Add to queue", "enqueue", [song]],
  ] as const)("%s acts on that one song only", (label, method, arg) => {
    const a = actions();
    songChoiceItems(song, a).find((i) => i.label === label)!.action();
    expect(a[method]).toHaveBeenCalledTimes(1);
    expect(a[method]).toHaveBeenCalledWith(arg);
    const others = (["playNow", "enqueueNext", "enqueue"] as const).filter((m) => m !== method);
    others.forEach((m) => expect(a[m]).not.toHaveBeenCalled());
  });
});
