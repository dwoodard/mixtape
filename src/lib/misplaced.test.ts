import { describe, expect, it } from "vitest";
import { findMisplaced } from "./misplaced";
import { makeTrack } from "./testing";

const ROOT = "/Volumes/homes/music/Music";
const song = (rel: string, artist: string, albumArtist = "") => makeTrack({ path: `${ROOT}/${rel}`, artist, albumArtist });
const library = [
  song("Forrest Frank/CHILD OF GOD/a.mp3", "Forrest Frank"),
  song("Forrest Frank/CHILD OF GOD/b.mp3", "Forrest Frank & Connor Price"),
  song("Forrest Frank/LEMONADE/c.mp3", "Forrest Frank & The Figs"),
];

describe("findMisplaced", () => {
  it("sends a collaboration to the folder of the credited artist with the most songs, keeping its album folder", () => {
    const slow = song("Forrest_/slow down/01 slow down.mp3", "Forrest. & Forrest Frank");
    const [m] = findMisplaced([...library, slow], ROOT);
    expect(m.track).toBe(slow);
    expect(m.from).toBe("Forrest_");
    expect(m.to).toBe("Forrest Frank");
    expect(m.toFolder).toBe(`${ROOT}/Forrest Frank/slow down`);
  });

  it("leaves songs alone when they are in the folder of the artist with the most songs", () => {
    expect(findMisplaced(library, ROOT)).toEqual([]);
  });

  it("does nothing when no folder is named after any credited artist", () => {
    expect(findMisplaced([...library, song("Mystery/x/y.mp3", "Someone Else")], ROOT)).toEqual([]);
  });

  it("leaves compilations alone", () => {
    const comp = song("Various Artists/Hits/z.mp3", "Forrest Frank", "Various Artists");
    expect(findMisplaced([...library, comp], ROOT)).toEqual([]);
  });

  it("ignores songs outside or loose in the library folder, and an unknown folder", () => {
    const loose = makeTrack({ path: `${ROOT}/loose.mp3`, artist: "Forrest Frank" });
    const outside = makeTrack({ path: "/elsewhere/Forrest_/x.mp3", artist: "Forrest Frank" });
    expect(findMisplaced([...library, loose, outside], ROOT)).toEqual([]);
    expect(findMisplaced([...library, song("Forrest_/s/x.mp3", "Forrest Frank")], null)).toEqual([]);
  });
});
