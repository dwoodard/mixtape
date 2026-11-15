import { describe, expect, it } from "vitest";
import { filterTracks, gridColumns, shuffleTracks, sortTracks } from "./trackList";
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

describe("gridColumns", () => {
  it("leaves out the album and date columns when they are hidden", () => {
    expect(gridColumns({ album: true, added: true })).toBe("34px 3fr 2fr 2fr 96px 52px 24px");
    expect(gridColumns({ album: false, added: true })).toBe("34px 3fr 2fr 96px 52px 24px");
    expect(gridColumns({ album: true, added: false })).toBe("34px 3fr 2fr 2fr 52px 24px");
    expect(gridColumns({ album: false, added: false })).toBe("34px 3fr 2fr 52px 24px");
  });
});
