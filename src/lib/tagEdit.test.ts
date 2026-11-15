import { describe, expect, it } from "vitest";
import { MULTIPLE, buildEdit, changedFields, commonValue, draftFor, isMixed } from "./tagEdit";
import { makeTrack } from "./testing";

const a = makeTrack({ path: "a", title: "One", artist: "Abe", album: "Same", year: 1999, trackNumber: 1 });
const b = makeTrack({ path: "b", title: "Two", artist: "Abe", album: "Same", year: 1999, trackNumber: 2 });

describe("commonValue / isMixed", () => {
  it("is the shared value, or empty when the songs differ", () => {
    expect(commonValue([a, b], "artist")).toBe("Abe");
    expect(commonValue([a, b], "title")).toBe("");
    expect(isMixed([a, b], "title")).toBe(true);
    expect(isMixed([a, b], "artist")).toBe(false);
  });

  it("treats one song, no songs and missing numbers sensibly", () => {
    expect(isMixed([a], "title")).toBe(false);
    expect(commonValue([], "title")).toBe("");
    expect(commonValue([makeTrack({ year: null })], "year")).toBe("");
    expect(commonValue([a], "year")).toBe("1999");
  });
});

describe("draftFor", () => {
  it("starts the form from the selection", () => {
    const draft = draftFor([a, b]);
    expect(draft.artist).toBe("Abe");
    expect(draft.title).toBe("");
    expect(draft.year).toBe("1999");
  });
});

describe("buildEdit", () => {
  it("sends nothing when nothing changed", () => {
    expect(buildEdit([a], draftFor([a]))).toEqual({ edit: {}, changes: [], error: null });
  });

  it("adds a cover link as a change, and rejects one that is not https", () => {
    const ok = buildEdit([a], draftFor([a]), "  https://example.com/c.webp ");
    expect(ok.edit).toEqual({ coverUrl: "https://example.com/c.webp" });
    expect(ok.changes).toEqual([{ field: "coverUrl", label: "Cover art", from: "(current art)", to: "https://example.com/c.webp" }]);
    const bad = buildEdit([a], draftFor([a]), "http://example.com/c.jpg");
    expect(bad.error).toContain("https");
    expect(bad.edit).toEqual({});
    expect(buildEdit([a], draftFor([a]), "  ")).toEqual({ edit: {}, changes: [], error: null });
  });

  it("sends only the fields that changed, with before and after", () => {
    const draft = { ...draftFor([a]), title: "Renamed", genre: "Ska" };
    const { edit, changes, error } = buildEdit([a], draft);
    expect(error).toBeNull();
    expect(edit).toEqual({ title: "Renamed", genre: "Ska" });
    expect(changes).toEqual([
      { field: "title", label: "Title", from: "One", to: "Renamed" },
      { field: "genre", label: "Genre", from: "", to: "Ska" },
    ]);
  });

  it("changing one field across several songs leaves their other differences alone", () => {
    const draft = { ...draftFor([a, b]), album: "New Album" };
    const { edit, changes } = buildEdit([a, b], draft);
    expect(edit).toEqual({ album: "New Album" });
    expect(changes[0].from).toBe("Same");
  });

  it("marks a field as changing from several different values", () => {
    const draft = { ...draftFor([a, b]), title: "Same Title" };
    expect(buildEdit([a, b], draft).changes[0]).toEqual({
      field: "title",
      label: "Title",
      from: MULTIPLE,
      to: "Same Title",
    });
  });

  it("clearing a field sends an empty string", () => {
    const draft = { ...draftFor([a]), artist: "  " };
    expect(buildEdit([a], draft).edit).toEqual({ artist: "" });
  });

  it("ignores surrounding spaces", () => {
    expect(buildEdit([a], { ...draftFor([a]), title: "  One " }).changes).toEqual([]);
  });

  it("rejects non-numeric and out-of-range numbers and does not send them", () => {
    const bad = buildEdit([a], { ...draftFor([a]), trackNumber: "seven" });
    expect(bad.error).toBe("Track must be a whole number.");
    expect(bad.edit).toEqual({});
    expect(buildEdit([a], { ...draftFor([a]), year: "10000" }).error).toBe("Year must be between 0 and 9999.");
    expect(buildEdit([a], { ...draftFor([a]), year: "2001" }).error).toBeNull();
  });
});

describe("changedFields", () => {
  const a = makeTrack({ title: "Halo", year: 2008, genre: "Pop" });
  const b = makeTrack({ title: "Halo", year: 2011, genre: "Pop" });

  it("drops fields every song already has", () => {
    expect(changedFields({ title: "Halo", year: "2008", genre: "Rock" }, [a])).toEqual({ genre: "Rock" });
  });

  it("keeps a field that differs for even one of several songs", () => {
    expect(changedFields({ year: "2008", genre: "Pop" }, [a, b])).toEqual({ year: "2008" });
  });

  it("treats a missing number as empty, so clearing it is a change only when something is there", () => {
    expect(changedFields({ year: "" }, [makeTrack({ year: null })])).toEqual({});
    expect(changedFields({ year: "" }, [a])).toEqual({ year: "" });
  });
});

