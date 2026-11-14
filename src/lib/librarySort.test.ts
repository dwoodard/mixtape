import { describe, expect, it } from "vitest";
import { insertSorted } from "./librarySort";
import { makeTrack } from "./testing";

const t = (path: string, artist: string, album: string, track: number | null = null, albumArtist = "") =>
  makeTrack({ path, title: path, artist, album, trackNumber: track, albumArtist });

describe("insertSorted", () => {
  const library = [t("1", "AC/DC", "Back in Black", 1), t("2", "AC/DC", "Back in Black", 3), t("3", "Eminem", "Show", 1)];

  it("puts a new song where a scan would have", () => {
    const out = insertSorted(library, t("new", "AC/DC", "Back in Black", 2));
    expect(out.map((x) => x.path)).toEqual(["1", "new", "2", "3"]);
  });

  it("goes first or last when it sorts there, and into an empty library", () => {
    expect(insertSorted(library, t("a", "Aaa", "x")).map((x) => x.path)[0]).toBe("a");
    const last = insertSorted(library, t("z", "Zed", "x")).map((x) => x.path);
    expect(last[last.length - 1]).toBe("z");
    expect(insertSorted([], t("only", "A", "B")).map((x) => x.path)).toEqual(["only"]);
  });

  it("sorts by album artist when there is one, ignoring case", () => {
    const out = insertSorted(library, t("c", "Guest", "Comp", 1, "eminem"));
    // Filed under its album artist "eminem", so before the Eminem album "Show".
    expect(out.map((x) => x.path)).toEqual(["1", "2", "c", "3"]);
  });

  it("replaces an entry with the same path instead of duplicating it", () => {
    const out = insertSorted(library, { ...library[1], title: "changed" });
    expect(out).toHaveLength(3);
    expect(out.find((x) => x.path === "2")!.title).toBe("changed");
  });

  it("does not modify the original list", () => {
    const copy = [...library];
    insertSorted(library, t("n", "B", "b"));
    expect(library).toEqual(copy);
  });
});
