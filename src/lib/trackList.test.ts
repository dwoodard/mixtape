import { describe, expect, it } from "vitest";
import { filterTracks, sortTracks } from "./trackList";
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

describe("sortTracks", () => {
  it("keeps the given order for the default key", () => {
    expect(sortTracks(tracks, "default", "desc")).toBe(tracks);
  });

  it("sorts text case-insensitively", () => {
    expect(sortTracks(tracks, "title", "asc").map((t) => t.path)).toEqual(["2", "3", "1"]);
    expect(sortTracks(tracks, "title", "desc").map((t) => t.path)).toEqual(["1", "3", "2"]);
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
