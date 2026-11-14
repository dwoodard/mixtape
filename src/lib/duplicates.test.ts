import { describe, expect, it } from "vitest";
import { extraCopies, findDuplicates } from "./duplicates";
import { makeTrack } from "./testing";

const song = (path: string, overrides = {}) =>
  makeTrack({ path, title: "Spiderwebs", artist: "No Doubt", album: "Tragic Kingdom", durationMs: 268_000, ...overrides });

describe("findDuplicates", () => {
  it("groups copies of the same recording and keeps the one without a copy marker", () => {
    const groups = findDuplicates([
      song("/m/01 Spiderwebs 1.mp3"),
      song("/m/01 Spiderwebs 2.mp3"),
      song("/m/01 Spiderwebs.mp3"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].keep.path).toBe("/m/01 Spiderwebs.mp3");
    expect(groups[0].extras.map((t) => t.path).sort()).toEqual(["/m/01 Spiderwebs 1.mp3", "/m/01 Spiderwebs 2.mp3"]);
  });

  it("understands (2) and copy markers", () => {
    const groups = findDuplicates([song("/m/a (2).mp3"), song("/m/a.mp3"), song("/m/a copy.mp3")]);
    expect(groups[0].keep.path).toBe("/m/a.mp3");
    expect(groups[0].extras).toHaveLength(2);
  });

  it("does not treat a real title ending in a number as a copy", () => {
    // "Song 2" is a different recording from "Song", so they are not duplicates at all.
    const none = findDuplicates([
      makeTrack({ path: "/m/Song.mp3", title: "Song", durationMs: 100_000 }),
      makeTrack({ path: "/m/Song 2.mp3", title: "Song 2", durationMs: 120_000 }),
    ]);
    expect(none).toEqual([]);
  });

  it("when no file looks like a copy, keeps the shortest path", () => {
    const groups = findDuplicates([song("/music/deep/folder/a.mp3"), song("/music/a.mp3")]);
    expect(groups[0].keep.path).toBe("/music/a.mp3");
  });

  it("a legit title ending in a number still keeps the original-named file", () => {
    const groups = findDuplicates([
      makeTrack({ path: "/m/Song 2.mp3", title: "Song 2", artist: "Blur", album: "Blur", durationMs: 120_000 }),
      makeTrack({ path: "/m/Song 2 1.mp3", title: "Song 2", artist: "Blur", album: "Blur", durationMs: 120_000 }),
    ]);
    expect(groups[0].keep.path).toBe("/m/Song 2.mp3");
    expect(groups[0].extras.map((t) => t.path)).toEqual(["/m/Song 2 1.mp3"]);
  });

  it("matches ignoring case and spacing, but not different lengths, albums or artists", () => {
    const groups = findDuplicates([
      song("/m/a.mp3"),
      song("/m/b.mp3", { title: " SPIDERWEBS " }),
      song("/m/live.mp3", { durationMs: 300_000 }),
      song("/m/other-album.mp3", { album: "Greatest Hits" }),
      song("/m/cover.mp3", { artist: "Someone Else" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].extras.length + 1).toBe(2);
  });

  it("returns nothing when every song is unique", () => {
    expect(findDuplicates([song("/m/a.mp3"), song("/m/b.mp3", { title: "Other" })])).toEqual([]);
    expect(findDuplicates([])).toEqual([]);
  });

  it("orders groups by artist, album, title and lists every extra copy", () => {
    const groups = findDuplicates([
      song("/m/z1.mp3", { title: "Zed" }),
      song("/m/z.mp3", { title: "Zed" }),
      song("/m/a1.mp3", { title: "Alpha" }),
      song("/m/a.mp3", { title: "Alpha" }),
    ]);
    expect(groups.map((g) => g.keep.title)).toEqual(["Alpha", "Zed"]);
    expect(extraCopies(groups)).toHaveLength(2);
  });
});
