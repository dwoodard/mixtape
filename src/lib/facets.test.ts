import { describe, expect, it } from "vitest";
import { applySuggestion, joinFilter, removePill, splitFilter, suggest, tokenize, toggleFacetTerm } from "./facets";
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

describe("suggest sorting", () => {
  const songs = [
    makeTrack({ path: "1", artist: "Beta", year: 2001 }),
    makeTrack({ path: "2", artist: "Alpha", year: 1990 }),
    makeTrack({ path: "3", artist: "Beta", year: 2001 }),
    makeTrack({ path: "4", artist: "Gamma", year: 2010 }),
  ];

  it("lists the facet's values with song counts, most songs first, then by name", () => {
    const s = suggest("artist:", 7, songs);
    expect(s.facet).toBe("artist");
    expect(s.items.map((i) => [i.label, i.count])).toEqual([["Beta", 2], ["Alpha", 1], ["Gamma", 1]]);
  });

  it("can list values by name, and years newest first", () => {
    expect(suggest("artist:", 7, songs, "name").items.map((i) => i.label)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(suggest("year:", 5, songs, "name").items.map((i) => i.label)).toEqual(["2010", "2001", "1990"]);
  });

  it("can group years into decades, inserting a year range", () => {
    const decades = suggest("year:", 5, songs, "count", "decade");
    expect(decades.items.map((i) => [i.label, i.insert, i.count])).toEqual([
      ["2000s", "year:2000..2009", 2],
      ["1990s", "year:1990..1999", 1],
      ["2010s", "year:2010..2019", 1],
    ]);
    expect(suggest("year:", 5, songs, "name", "decade").items.map((i) => i.label)).toEqual(["2010s", "2000s", "1990s"]);
  });

  it("only groups the year facet, and a chosen decade filters to that range", () => {
    expect(suggest("artist:", 7, songs, "count", "decade").items.map((i) => i.label)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(filterTracks(songs, "year:2000..2009").map((t) => t.path)).toEqual(["1", "3"]);
  });

  it("has no facet or counts when listing facet names", () => {
    const s = suggest("", 0, songs);
    expect(s.facet).toBeNull();
    expect(s.items.every((i) => i.count === undefined)).toBe(true);
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

describe("toggleFacetTerm", () => {
  it("adds a clicked value as a facet, quoting names with spaces, and takes it out when clicked again", () => {
    expect(toggleFacetTerm("", "artist", "The Lower Lights")).toBe('artist:"The Lower Lights"');
    expect(toggleFacetTerm("nocover", "year", "2010")).toBe("nocover year:2010");
    expect(toggleFacetTerm('artist:"The Lower Lights"', "artist", "the lower lights")).toBe("");
    expect(toggleFacetTerm('jazz album:"A Hymn Revival" year:2010', "album", "A Hymn Revival")).toBe("jazz year:2010");
  });

  it("treats the same value under another facet as a different term, and ignores empty values", () => {
    expect(toggleFacetTerm("artist:Beck", "album", "Beck")).toBe("artist:Beck album:Beck");
    expect(toggleFacetTerm("jazz", "album", "  ")).toBe("jazz");
  });

  it("produces a filter that selects the clicked value", () => {
    const tracks = [makeTrack({ path: "/a", artist: "The Lower Lights", album: "A Hymn Revival", year: 2010 }), makeTrack({ path: "/b", artist: "Other", album: "A Hymn Revival", year: 2011 })];
    const query = toggleFacetTerm(toggleFacetTerm("", "artist", "The Lower Lights"), "year", "2010");
    expect(filterTracks(tracks, query).map((t) => t.path)).toEqual(["/a"]);
  });
});

describe("filter pills", () => {
  it("turns finished facet words into pills and leaves the rest as text", () => {
    const { pills, text } = splitFilter('jazz artist:"The Lower Lights" rock year:2010', false);
    expect(pills.map((p) => [p.facet, p.value])).toEqual([["artist", "The Lower Lights"], ["year", "2010"]]);
    expect(text).toBe("jazz rock");
  });

  it("keeps a facet word that is still being typed at the end as text, until it is finished", () => {
    expect(splitFilter("artist:Beck", true)).toMatchObject({ pills: [], text: "artist:Beck" });
    expect(splitFilter("artist:Beck ", true).pills).toHaveLength(1);
    expect(splitFilter("artist:Beck", false).pills).toHaveLength(1);
  });

  it("does not make a pill of a facet name with no value yet, and keeps a trailing space in the text", () => {
    expect(splitFilter("year:", false)).toMatchObject({ pills: [], text: "year:" });
    expect(splitFilter("album:Dookie rock ", false).text).toBe("rock ");
  });

  it("puts pills and text back together, and removes one pill without touching the rest", () => {
    const query = 'jazz artist:"The Lower Lights" year:2010';
    const { pills, text } = splitFilter(query, false);
    expect(joinFilter(pills, text)).toBe('artist:"The Lower Lights" year:2010 jazz');
    expect(removePill(query, pills[0])).toBe("jazz year:2010");
    expect(removePill(query, pills[1])).toBe('jazz artist:"The Lower Lights"');
    expect(joinFilter([], "rock")).toBe("rock");
  });

  it("offers facet names, not values, when the text field after a pill is empty", () => {
    const { pills, text } = splitFilter("artist:AJR", false);
    const query = joinFilter(pills, text, true);
    const offered = suggest(query, query.length, [makeTrack({ artist: "AJR" }), makeTrack({ artist: "AJR feat. Rivers Cuomo" })]);
    expect(offered.items.map((i) => i.label)).toContain("album:");
    expect(offered.items.map((i) => i.label)).not.toContain("AJR feat. Rivers Cuomo");
  });
});

describe("editing the text beside a pill", () => {
  /** What the filter box does on each keystroke: keep the pills as drawn, then put the typed text after them. */
  const type = (query: string, value: string) => {
    const pills = splitFilter(query, false).pills;
    return joinFilter(pills, value, true);
  };

  it("keeps a pill that sits after the free text while that text is edited", () => {
    const query = type('Ireland artist:"Garth Brooks"', "Irelan");
    expect(splitFilter(query, true)).toMatchObject({ pills: [{ facet: "artist", value: "Garth Brooks" }], text: "Irelan" });
  });

  it("keeps the pill when all of the text is deleted, and does not turn it back into typed text", () => {
    let query = 'artist:"Garth Brooks" Ireland';
    for (const value of ["Irelan", "Ire", "I", ""]) query = type(query, value);
    const parts = splitFilter(query, true);
    expect(parts.pills).toHaveLength(1);
    expect(parts.text).toBe("");
  });
});
