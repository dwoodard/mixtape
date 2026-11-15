import { describe, expect, it } from "vitest";
import { applySuggestion, suggest, tokenize } from "./facets";
import { filterTracks } from "./trackList";
import { makeTrack } from "./testing";

const DAY = 86_400_000;
const now = Date.now();
const list = [
  makeTrack({ path: "1", title: "Roygbiv", artist: "Boards of Canada", albumArtist: "Boards of Canada", album: "Music Has the Right", year: 1998, genre: "IDM", durationMs: 150_000, addedMs: now - 2 * DAY }),
  makeTrack({ path: "2", title: "Alpha", artist: "Zed feat. Abe", albumArtist: "Various", album: "Letters", year: 2004, genre: "Jazz", durationMs: 250_000, addedMs: now - 100 * DAY, hasLyrics: false }),
  makeTrack({ path: "3", title: "Beta", artist: "Abe", album: "Letters", year: null, genre: "", durationMs: 400_000, addedMs: 0 }),
];
const paths = (q: string, coverless = new Set<string>()) => filterTracks(list, q, coverless).map((t) => t.path);

describe("tokenize", () => {
  it("reads facets, quoted values and positions", () => {
    expect(tokenize('rock artist:"Boards of Canada" Year:1998')).toEqual([
      { start: 0, end: 4, facet: null, value: "rock" },
      { start: 5, end: 30, facet: "artist", value: "boards of canada" },
      { start: 31, end: 40, facet: "year", value: "1998" },
    ]);
  });

  it("treats an unknown name as plain text", () => {
    expect(tokenize("mood:happy")[0]).toMatchObject({ facet: null, value: "mood:happy" });
  });
});

describe("filterTracks with facets", () => {
  it("matches one field only", () => {
    expect(paths("artist:abe")).toEqual(["2", "3"]);
    expect(paths("title:abe")).toEqual([]);
    expect(paths('artist:"boards of canada"')).toEqual(["1"]);
    expect(paths("albumartist:various")).toEqual(["2"]);
    expect(paths("genre:jazz album:letters")).toEqual(["2"]);
  });

  it("matches years and year ranges", () => {
    expect(paths("year:1998")).toEqual(["1"]);
    expect(paths("year:1990..2000")).toEqual(["1"]);
    expect(paths("year:2000..")).toEqual(["2"]);
    expect(paths("year:..2000")).toEqual(["1"]);
  });

  it("matches length in minutes", () => {
    expect(paths("length:2")).toEqual(["1"]);
    expect(paths("length:4..")).toEqual(["2", "3"]);
    expect(paths("length:..3")).toEqual(["1"]);
  });

  it("matches songs added within a span, never songs of unknown date", () => {
    expect(paths("added:7d")).toEqual(["1"]);
    expect(paths("added:1y")).toEqual(["1", "2"]);
    expect(paths("added:nonsense")).toEqual([]);
  });

  it("matches has and no for cover and lyrics, and combines with plain words", () => {
    const coverless = new Set(["3"]);
    expect(paths("no:cover", coverless)).toEqual(["3"]);
    expect(paths("has:cover", coverless)).toEqual(["1", "2"]);
    expect(paths("no:lyrics")).toEqual(["2"]);
    expect(paths("has:lyrics letters")).toEqual(["3"]);
  });
});

describe("suggest", () => {
  it("offers every facet for an empty box and narrows by what is typed", () => {
    expect(suggest("", 0, list).items.length).toBeGreaterThan(5);
    expect(suggest("al", 2, list).items.map((i) => i.insert)).toEqual(["albumartist:", "album:"]);
  });

  it("offers nothing for free text that starts no facet", () => {
    expect(suggest("zzz", 3, list).items).toEqual([]);
  });

  it("offers a facet's values from the library, quoting names with spaces", () => {
    const s = suggest("artist:bo", 9, list);
    expect(s.items.map((i) => i.insert)).toEqual(['artist:"Boards of Canada"']);
    expect(suggest("no:", 3, list).items.map((i) => i.insert)).toEqual(["no:cover", "no:lyrics"]);
  });

  it("offers only values from songs the other facets allow", () => {
    const q = 'artist:"Boards of Canada" album:';
    expect(suggest(q, q.length, list).items.map((i) => i.insert)).toEqual(['album:"Music Has the Right"']);
    const q2 = "album:letters artist:";
    expect(suggest(q2, q2.length, list).items.map((i) => i.insert)).toEqual(["artist:Abe", 'artist:"Zed feat. Abe"']);
  });

  it("works on the word under the caret in the middle of the query", () => {
    const s = suggest("rock gen year:1998", 8, list);
    expect(s.items.map((i) => i.insert)).toEqual(["genre:"]);
    expect([s.start, s.end]).toEqual([5, 8]);
  });
});

describe("applySuggestion", () => {
  it("leaves a facet name open for its value", () => {
    const s = suggest("rock ar", 7, list);
    expect(applySuggestion("rock ar", s, s.items[0])).toEqual({ query: "rock artist:", caret: 12 });
  });

  it("closes a chosen value with a space and puts the caret after it", () => {
    const s = suggest("artist:bo", 9, list);
    expect(applySuggestion("artist:bo", s, s.items[0])).toEqual({ query: 'artist:"Boards of Canada" ', caret: 26 });
  });
});
