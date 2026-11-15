import { describe, expect, it } from "vitest";
import { assess } from "./removed";
import { makeTrack } from "./testing";
import type { RemovedSong } from "./types";

const song = (path: string, over: Partial<RemovedSong> = {}): RemovedSong => ({
  path,
  missing: false,
  size: 1000,
  modifiedMs: 1,
  track: makeTrack({ path, title: "Mud", artist: "Primus", album: "Pork Soda", durationMs: 200_000 }),
  ...over,
});
const lib = (path: string, over = {}) => makeTrack({ path, title: "Mud", artist: "Primus", album: "Pork Soda", durationMs: 200_000, ...over });

describe("assess", () => {
  it("calls a file whose exact song is in the library a spare copy", () => {
    expect(assess(song("/x/Mud (2).mp3"), [lib("/m/Mud.mp3")])).toMatchObject({ advice: "spare-copy", match: { path: "/m/Mud.mp3" } });
  });

  it("notices a different version of the same title and artist", () => {
    const r = assess(song("/x/Mud.mp3"), [lib("/m/Mud.mp3", { album: "Live", durationMs: 250_000 })]);
    expect(r.advice).toBe("other-version");
    expect(r.text).toContain("Live");
  });

  it("says a song nothing in the library matches is not in the library", () => {
    expect(assess(song("/x/Mud.mp3"), [lib("/m/Other.mp3", { title: "Other" })]).advice).toBe("not-in-library");
  });

  it("handles a file that can't be read", () => {
    expect(assess(song("/x/a.mp3", { track: null }), []).advice).toBe("not-in-library");
  });

  it("says a gone file only needs forgetting, and names the original of a gone copy", () => {
    const gone = (path: string) => song(path, { missing: true, size: 0, modifiedMs: 0, track: null });
    expect(assess(gone("/m/Mud (2).mp3"), [lib("/m/Mud.mp3")])).toMatchObject({ advice: "gone-copy", match: { path: "/m/Mud.mp3" } });
    expect(assess(gone("/m/Zed.mp3"), [lib("/m/Mud.mp3")]).advice).toBe("gone");
  });
});
