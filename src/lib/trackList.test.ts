import { describe, expect, it } from "vitest";
import { filterTracks, shuffleTracks, sortTracks, wantsNoCover } from "./trackList";
import { makeTrack } from "./testing";

const tracks = [
  makeTrack({ path: "1", title: "Roygbiv", artist: "Boards of Canada", album: "Music Has the Right", year: 1998 }),
  makeTrack({ path: "2", title: "alpha", artist: "Zed", album: "Letters", year: null }),
  makeTrack({ path: "3", title: "Beta", artist: "Abe", album: "Letters", year: 2004, genre: "Jazz" }),
];

describe("filterTracks", () => {
  it("returns everything for a blank query", () => {
    expect(filterTracks(tracks, "  ")).toHaveLength(3);
  });

  it("matches across fields, ignoring case", () => {
    expect(filterTracks(tracks, "BOARDS").map((t) => t.path)).toEqual(["1"]);
    expect(filterTracks(tracks, "jazz").map((t) => t.path)).toEqual(["3"]);
  });

  it("requires every word to match", () => {
    expect(filterTracks(tracks, "letters beta").map((t) => t.path)).toEqual(["3"]);
    expect(filterTracks(tracks, "letters nothing")).toEqual([]);
  });
});

describe("filterTracks by cover art", () => {
  const coverless = new Set(["2", "3"]);

  it("keeps only songs without a cover for nocover or no:cover, and combines with other words", () => {
    expect(filterTracks(tracks, "nocover", coverless).map((t) => t.path)).toEqual(["2", "3"]);
    expect(filterTracks(tracks, "No:Cover", coverless).map((t) => t.path)).toEqual(["2", "3"]);
    expect(filterTracks(tracks, "nocover jazz", coverless).map((t) => t.path)).toEqual(["3"]);
    expect(filterTracks(tracks, "nocover", new Set())).toEqual([]);
  });

  it("keeps only songs without saved lyrics for nolyrics, from the song's own flag", () => {
    const list = [makeTrack({ path: "a", hasLyrics: true }), makeTrack({ path: "b", hasLyrics: false, genre: "Jazz" }), makeTrack({ path: "c", hasLyrics: false })];
    expect(filterTracks(list, "nolyrics").map((t) => t.path)).toEqual(["b", "c"]);
    expect(filterTracks(list, "no:lyrics jazz").map((t) => t.path)).toEqual(["b"]);
  });

  it("recognizes the word so the files get checked", () => {
    expect(wantsNoCover("rock NoCover")).toBe(true);
    expect(wantsNoCover("cover")).toBe(false);
  });
});

describe("filterTracks by year", () => {
  const a = makeTrack({ path: "/a", title: "Right in Two", year: 2019 });
  const b = makeTrack({ path: "/b", title: "Other", year: 2008 });
  const none = makeTrack({ path: "/c", title: "No year", year: null });

  it("finds the songs from a year, alone or with other words", () => {
    expect(filterTracks([a, b, none], "2019").map((t) => t.title)).toEqual(["Right in Two"]);
    expect(filterTracks([a, b, none], "two 2019")).toHaveLength(1);
    expect(filterTracks([a, b, none], "two 2008")).toHaveLength(0);
  });

  it("does not turn a missing year into the word null", () => {
    expect(filterTracks([none], "null")).toHaveLength(0);
  });
});

describe("shuffleTracks", () => {
  const many = Array.from({ length: 30 }, (_, i) => makeTrack({ path: String(i) }));

  it("keeps every track, leaves the input alone, and is repeatable for one seed", () => {
    const a = shuffleTracks(many, 1);
    expect(a.map((t) => t.path).sort()).toEqual(many.map((t) => t.path).sort());
    expect(many[0].path).toBe("0");
    expect(shuffleTracks(many, 1)).toEqual(a);
  });

  it("gives a different order for a different seed", () => {
    expect(shuffleTracks(many, 1).map((t) => t.path)).not.toEqual(shuffleTracks(many, 2).map((t) => t.path));
  });
});

describe("sortTracks", () => {
  it("keeps the given order for the default key", () => {
    expect(sortTracks(tracks, "default", "desc")).toBe(tracks);
  });

  it("sorts text case-insensitively", () => {
    expect(sortTracks(tracks, "title", "asc").map((t) => t.path)).toEqual(["2", "3", "1"]);
    expect(sortTracks(tracks, "title", "desc").map((t) => t.path)).toEqual(["1", "3", "2"]);
  });

  it("sorts by date added and puts unknown dates last", () => {
    const dated = [
      makeTrack({ path: "old", addedMs: 1_000 }),
      makeTrack({ path: "none", addedMs: 0 }),
      makeTrack({ path: "new", addedMs: 5_000 }),
    ];
    expect(sortTracks(dated, "addedMs", "desc").map((t) => t.path)).toEqual(["new", "old", "none"]);
    expect(sortTracks(dated, "addedMs", "asc").map((t) => t.path)).toEqual(["old", "new", "none"]);
  });

  it("puts missing values last in both directions", () => {
    expect(sortTracks(tracks, "year", "asc").map((t) => t.path)).toEqual(["1", "3", "2"]);
    expect(sortTracks(tracks, "year", "desc").map((t) => t.path)).toEqual(["3", "1", "2"]);
  });

  it("does not mutate the input", () => {
    const copy = [...tracks];
    sortTracks(tracks, "artist", "asc");
    expect(tracks).toEqual(copy);
  });
});

describe("sorting by plays", () => {
  const a = makeTrack({ path: "/a", title: "A" });
  const b = makeTrack({ path: "/b", title: "B" });
  const c = makeTrack({ path: "/c", title: "C" });
  const plays = { "/b": { count: 5, lastPlayedMs: 1 }, "/c": { count: 2, lastPlayedMs: 1 } };

  it("puts the most played first when descending, and counts unplayed songs as zero", () => {
    expect(sortTracks([a, b, c], "plays", "desc", plays).map((t) => t.title)).toEqual(["B", "C", "A"]);
    expect(sortTracks([a, b, c], "plays", "asc", plays).map((t) => t.title)).toEqual(["A", "C", "B"]);
  });

  it("keeps the given order for songs with equal counts", () => {
    expect(sortTracks([c, a], "plays", "desc", {}).map((t) => t.title)).toEqual(["C", "A"]);
  });
});
