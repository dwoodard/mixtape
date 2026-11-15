import { describe, expect, it } from "vitest";
import { albumHue, groupAlbums, groupName, groupTracks, tracksInGroup, groupArtists, sortAlbumTracks, tracksForArtist } from "./grouping";
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

describe("albumHue", () => {
  it("is stable and within the hue range", () => {
    expect(albumHue("Boards\u0000Geogaddi")).toBe(albumHue("Boards\u0000Geogaddi"));
    for (const key of ["", "a", "Boards\u0000MHTRTC", "ünïcode"]) {
      const hue = albumHue(key);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("usually differs between albums", () => {
    expect(albumHue("a")).not.toBe(albumHue("b"));
  });
});

describe("groupName", () => {
  const t = makeTrack({ artist: "Abe", genre: "Jazz", year: 1994 });

  it("names the group under each mode", () => {
    expect(groupName(t, "artist")).toBe("Abe");
    expect(groupName(t, "genre")).toBe("Jazz");
    expect(groupName(t, "year")).toBe("1994");
    expect(groupName(t, "decade")).toBe("1990s");
  });

  it("puts tracks missing the tag in an Unknown group", () => {
    const bare = makeTrack({ genre: "", year: null });
    expect(groupName(bare, "genre")).toBe("Unknown genre");
    expect(groupName(bare, "year")).toBe("Unknown year");
    expect(groupName(bare, "decade")).toBe("Unknown decade");
  });
});

describe("groupName by folder", () => {
  it("names the folder holding the file, with its parent", () => {
    expect(groupName(makeTrack({ path: "/Music/Forrest Frank/song.mp3" }), "folder")).toBe("Music/Forrest Frank");
    expect(groupName(makeTrack({ path: "/song.mp3" }), "folder")).toBe("Unknown folder");
  });
});

describe("groupTracks", () => {
  const library = [
    makeTrack({ path: "1", artist: "Abe", album: "X", genre: "Jazz", year: 1994 }),
    makeTrack({ path: "2", artist: "Abe", album: "X", genre: "Jazz", year: 1994 }),
    makeTrack({ path: "3", artist: "Abe", album: "Y", genre: "Rock", year: 2003 }),
    makeTrack({ path: "4", artist: "Zed", album: "Z", genre: "Rock", year: 1998 }),
    makeTrack({ path: "5", artist: "Mia", album: "W", genre: "", year: null }),
  ];
  const names = (g: { name: string }[]) => g.map((x) => x.name);

  it("groups by genre and counts distinct albums and tracks", () => {
    const groups = groupTracks(library, "genre", "name", "asc");
    expect(groups).toEqual([
      { name: "Jazz", albumCount: 1, trackCount: 2 },
      { name: "Rock", albumCount: 2, trackCount: 2 },
      { name: "Unknown genre", albumCount: 1, trackCount: 1 },
    ]);
  });

  it("sorts decades numerically with unknown last", () => {
    expect(names(groupTracks(library, "decade", "name", "asc"))).toEqual(["1990s", "2000s", "Unknown decade"]);
    expect(names(groupTracks(library, "decade", "name", "desc"))).toEqual(["2000s", "1990s", "Unknown decade"]);
  });

  it("sorts by track or album count, breaking ties by name", () => {
    expect(names(groupTracks(library, "artist", "tracks", "desc"))).toEqual(["Abe", "Mia", "Zed"]);
    expect(names(groupTracks(library, "artist", "tracks", "asc"))).toEqual(["Mia", "Zed", "Abe"]);
    expect(names(groupTracks(library, "artist", "albums", "desc"))).toEqual(["Abe", "Mia", "Zed"]);
  });

  it("keeps Unknown groups last whichever way it is sorted", () => {
    const sorted = groupTracks(library, "genre", "tracks", "asc");
    expect(sorted[sorted.length - 1].name).toBe("Unknown genre");
    const desc = groupTracks(library, "genre", "tracks", "desc");
    expect(desc[desc.length - 1].name).toBe("Unknown genre");
  });

  it("returns nothing for no tracks", () => {
    expect(groupTracks([], "artist", "name", "asc")).toEqual([]);
  });
});

describe("tracksInGroup", () => {
  it("returns a group's tracks in album order", () => {
    const tracks = [
      makeTrack({ path: "a", title: "B-side", genre: "Rock", album: "Two", year: 2001, trackNumber: 1 }),
      makeTrack({ path: "b", title: "Opener", genre: "Rock", album: "One", year: 1999, trackNumber: 1 }),
      makeTrack({ path: "c", title: "Other", genre: "Jazz", album: "Three" }),
    ];
    expect(tracksInGroup(tracks, "genre", "Rock").map((t) => t.title)).toEqual(["Opener", "B-side"]);
  });
});
