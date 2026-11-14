import { describe, expect, it } from "vitest";
import { groupAlbums, groupArtists, sortAlbumTracks, tracksForArtist } from "./grouping";
import { makeTrack } from "./testing";

const tracks = [
  makeTrack({ path: "1", title: "Two", artist: "Boards", album: "MHTRTC", year: 1998, trackNumber: 2, durationMs: 100 }),
  makeTrack({ path: "2", title: "One", artist: "Boards", album: "MHTRTC", year: 1998, trackNumber: 1, durationMs: 200 }),
  makeTrack({ path: "3", title: "Later", artist: "Boards", album: "Geogaddi", year: 2002, trackNumber: 1, durationMs: 300 }),
  makeTrack({ path: "4", title: "Solo", artist: "Abe", album: "Letters", year: null, trackNumber: 1, durationMs: 400 }),
  makeTrack({ path: "5", title: "Loose", artist: "Abe", album: "", durationMs: 50 }),
];

describe("sortAlbumTracks", () => {
  it("orders by disc, then track, with unnumbered tracks last", () => {
    const sorted = sortAlbumTracks([
      makeTrack({ title: "d2t1", discNumber: 2, trackNumber: 1 }),
      makeTrack({ title: "none" }),
      makeTrack({ title: "d1t2", discNumber: 1, trackNumber: 2 }),
      makeTrack({ title: "d1t1", discNumber: 1, trackNumber: 1 }),
    ]);
    expect(sorted.map((t) => t.title)).toEqual(["d1t1", "d1t2", "d2t1", "none"]);
  });
});

describe("groupAlbums", () => {
  const albums = groupAlbums(tracks);

  it("groups by artist and album, sorted by artist, year, title", () => {
    expect(albums.map((a) => `${a.artist}/${a.title}`)).toEqual([
      "Abe/Letters",
      "Abe/Unknown album",
      "Boards/MHTRTC",
      "Boards/Geogaddi",
    ]);
  });

  it("orders each album's tracks and totals its length", () => {
    const album = albums.find((a) => a.title === "MHTRTC")!;
    expect(album.tracks.map((t) => t.title)).toEqual(["One", "Two"]);
    expect(album.durationMs).toBe(300);
    expect(album.year).toBe(1998);
  });

  it("uses the album artist over the track artist so compilations stay together", () => {
    const comp = groupAlbums([
      makeTrack({ artist: "A", albumArtist: "Various", album: "Hits" }),
      makeTrack({ artist: "B", albumArtist: "Various", album: "Hits" }),
    ]);
    expect(comp).toHaveLength(1);
    expect(comp[0].artist).toBe("Various");
  });

  it("returns nothing for no tracks and leaves year null when unknown", () => {
    expect(groupAlbums([])).toEqual([]);
    expect(albums.find((a) => a.title === "Letters")!.year).toBeNull();
  });
});

describe("groupArtists", () => {
  it("counts albums and tracks, sorted by name", () => {
    expect(groupArtists(tracks)).toEqual([
      { name: "Abe", albumCount: 2, trackCount: 2 },
      { name: "Boards", albumCount: 2, trackCount: 3 },
    ]);
  });

  it("files tracks without any artist under a placeholder", () => {
    expect(groupArtists([makeTrack({ artist: "", albumArtist: "" })])[0].name).toBe("Unknown artist");
  });
});

describe("tracksForArtist", () => {
  it("lists an artist's tracks album by album", () => {
    expect(tracksForArtist(tracks, "Boards").map((t) => t.title)).toEqual(["One", "Two", "Later"]);
  });
});
