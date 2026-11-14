import { describe, expect, it } from "vitest";
import { applyFolderRefresh, insertSorted } from "./librarySort";
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

describe("applyFolderRefresh", () => {
  const lib = [
    t("/m/Korn/Follow/15 Got the Life.mp3", "Korn", "Follow", 15),
    t("/m/Korn/Follow/old name.mp3", "Korn", "Follow", 3),
    t("/m/Korn/Follower/x.mp3", "Korn", "Follower", 1),
    t("/m/PROF/Unknown/Dynamite.mp3", "PROF", "", null),
  ];

  it("replaces only the re-checked folder: renames, retags and deletions", () => {
    const out = applyFolderRefresh(lib, [
      { dir: "/m/Korn/Follow", tracks: [t("/m/Korn/Follow/15 Got the Life.mp3", "Korn", "Follow", 15), t("/m/Korn/Follow/1-03 New name.mp3", "Korn", "Follow", 3)] },
    ]);
    expect(out.map((x) => x.path).sort()).toEqual([
      "/m/Korn/Follow/1-03 New name.mp3",
      "/m/Korn/Follow/15 Got the Life.mp3",
      "/m/Korn/Follower/x.mp3",
      "/m/PROF/Unknown/Dynamite.mp3",
    ]);
  });

  it("does not touch a folder whose name merely starts the same", () => {
    const out = applyFolderRefresh(lib, [{ dir: "/m/Korn/Follow", tracks: [] }]);
    expect(out.map((x) => x.path)).toContain("/m/Korn/Follower/x.mp3");
    expect(out).toHaveLength(2);
  });

  it("moves a song to its new place when its artist and album tags changed", () => {
    const out = applyFolderRefresh(lib, [{ dir: "/m/PROF/Unknown", tracks: [t("/m/PROF/Unknown/Dynamite.mp3", "PROF", "Dynamite - Single", 1)] }]);
    expect(out.find((x) => x.path === "/m/PROF/Unknown/Dynamite.mp3")!.album).toBe("Dynamite - Single");
  });

  it("handles no results and a trailing slash", () => {
    expect(applyFolderRefresh(lib, [])).toEqual(lib);
    expect(applyFolderRefresh(lib, [{ dir: "/m/PROF/Unknown/", tracks: [] }])).toHaveLength(3);
  });
});
