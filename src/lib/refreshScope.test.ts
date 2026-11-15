import { describe, expect, it } from "vitest";
import { scopeFor, scopeForDirs } from "./refreshScope";

const root = "/Volumes/homes/dwoodard/music/Music";

describe("which folders to refresh", () => {
  it("after an add: only the folder the file went into", () => {
    expect(scopeFor(root, [`${root}/Primus/Pork Soda/02 My Name Is Mud.mp3`], false)).toEqual([`${root}/Primus/Pork Soda`]);
  });

  it("after something may have renamed or moved it: the artist folder, which covers the albums under it", () => {
    expect(scopeFor(root, [`${root}/Primus/Frizzle Fry (Remastered)/Too Many Puppies.mp3`], true)).toEqual([`${root}/Primus`]);
  });

  it("gives each folder once, and leaves out folders another one already covers", () => {
    const paths = [`${root}/Primus/A/1.mp3`, `${root}/Primus/A/2.mp3`, `${root}/Primus/B/3.mp3`, `${root}/Zed/C/4.mp3`];
    expect(scopeFor(root, paths, false)).toEqual([`${root}/Primus/A`, `${root}/Primus/B`, `${root}/Zed/C`]);
    expect(scopeFor(root, paths, true)).toEqual([`${root}/Primus`, `${root}/Zed`]);
    // One file widened, another not: the artist folder covers the album folder inside it.
    expect(scopeFor(root, [`${root}/Primus/A/1.mp3`], true).concat(scopeFor(root, [`${root}/Primus/B/3.mp3`], false))).toHaveLength(2);
  });

  it("never gives the library root, so it can never turn into a full rescan", () => {
    expect(scopeFor(root, [`${root}/loose.mp3`], false)).toEqual([]);
    expect(scopeFor(root, [`${root}/loose.mp3`], true)).toEqual([]);
    // An artist folder with songs straight in it is itself the smallest folder.
    expect(scopeFor(root, [`${root}/Solo/one.mp3`], true)).toEqual([`${root}/Solo`]);
  });

  it("ignores files outside the library, a lookalike folder name, and an unknown library", () => {
    expect(scopeFor(root, ["/Users/dustin/Downloads/music/a.mp3", `${root}-old/Primus/A/1.mp3`], false)).toEqual([]);
    expect(scopeFor(null, [`${root}/Primus/A/1.mp3`], false)).toEqual([]);
  });

  it("copes with a trailing slash on the library folder", () => {
    expect(scopeFor(`${root}/`, [`${root}/Primus/A/1.mp3`], false)).toEqual([`${root}/Primus/A`]);
  });

  it("works from folders as well as files", () => {
    expect(scopeForDirs(root, [`${root}/Primus/Frizzle Fry (Remastered)`, `${root}/Primus/Pork Soda`], true)).toEqual([`${root}/Primus`]);
    expect(scopeForDirs(root, [`${root}/Primus/Pork Soda`], false)).toEqual([`${root}/Primus/Pork Soda`]);
  });
});
