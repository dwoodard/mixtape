import { describe, expect, it, vi } from "vitest";
import { createGenreFill, MIN_CONFIDENCE, normalizeGenre, type GenreFillDeps } from "./genreFill";
import { pickGenreTag, type TagMatch } from "./musicbrainz";
import { makeTrack } from "./testing";
import type { Track } from "./types";

const match = (genreHint: string, confidence = 90): TagMatch => ({ recordingId: "", releaseId: "", title: "", artist: "", album: "", albumArtist: "", year: "", trackNumber: "", discNumber: "", genreHint, releaseKind: "", confidence, reasons: [] });
const song = (n: number, genre = "") => makeTrack({ path: `/m/${n}.mp3`, title: `Song ${n}`, genre });

function fill(library: Track[], over: Partial<GenreFillDeps> = {}) {
  const deps: GenreFillDeps = {
    library: () => library,
    lookup: vi.fn(async () => [match("rock")]),
    write: vi.fn(async () => null),
    ...over,
  };
  return { fill: createGenreFill(deps), deps };
}

describe("genre names", () => {
  it("writes MusicBrainz's lower-case tags as titles, with the usual exceptions", () => {
    expect(normalizeGenre("progressive rock")).toBe("Progressive Rock");
    expect(normalizeGenre("r&b")).toBe("R&B");
    expect(normalizeGenre("hip hop")).toBe("Hip Hop");
    expect(normalizeGenre("  Indie-pop ")).toBe("Indie-Pop");
    expect(normalizeGenre("drum and bass")).toBe("Drum And Bass");
  });

  it("picks the most voted tag that is really a genre", () => {
    expect(pickGenreTag([{ name: "seen live", count: 9 }, { name: "1980s", count: 5 }, { name: "synth-pop", count: 3 }, { name: "pop", count: 1 }])).toBe("synth-pop");
    expect(pickGenreTag([{ name: "usa", count: 4 }, { name: "male vocalists", count: 2 }])).toBe("");
    expect(pickGenreTag(undefined)).toBe("");
  });
});

describe("looking up genres", () => {
  it("only looks at songs with no genre, and suggests the confident ones", async () => {
    const { fill: f, deps } = fill([song(1), song(2, "Pop"), song(3, "  ")]);
    expect(f.missingCount()).toBe(2);
    await f.start();
    expect(deps.lookup).toHaveBeenCalledTimes(2);
    expect(f.state.phase).toBe("review");
    expect(f.state.total).toBe(2);
    expect(f.state.looked).toBe(2);
    expect(f.state.suggestions.map((s) => [s.track.title, s.genre])).toEqual([["Song 1", "Rock"], ["Song 3", "Rock"]]);
  });

  it("skips a weak match or one with no genre, and counts it", async () => {
    const answers = [[match("rock", MIN_CONFIDENCE - 1)], [match("")], [], [match("jazz", MIN_CONFIDENCE)]];
    const { fill: f } = fill([song(1), song(2), song(3), song(4)], { lookup: vi.fn(async () => answers.shift()!) });
    await f.start();
    expect(f.state.suggestions.map((s) => s.genre)).toEqual(["Jazz"]);
    expect(f.state.skipped).toBe(3);
  });

  it("can be stopped, and keeps what it found for review", async () => {
    let n = 0;
    const { fill: f } = fill([song(1), song(2), song(3), song(4)], {
      lookup: vi.fn(async () => {
        if (++n === 2) f.cancel();
        return [match("rock")];
      }),
    });
    await f.start();
    expect(f.state.phase).toBe("review");
    expect(f.state.looked).toBe(2);
    expect(f.state.suggestions).toHaveLength(2);
  });

  it("gives up with the service's message after three failures in a row, not after one", async () => {
    const calls = [new Error("busy"), [match("rock")], new Error("down"), new Error("down"), new Error("down"), [match("rock")]];
    const { fill: f, deps } = fill(Array.from({ length: 6 }, (_, i) => song(i)), {
      lookup: vi.fn(async () => {
        const next = calls.shift();
        if (next instanceof Error) throw next;
        return next!;
      }),
    });
    await f.start();
    expect(f.state.error).toBe("down");
    expect(deps.lookup).toHaveBeenCalledTimes(5);
    expect(f.state.suggestions).toHaveLength(1);
  });

  it("does not start twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fill: f, deps } = fill([song(1)], { lookup: vi.fn(async () => (await gate, [match("rock")])) });
    const first = f.start();
    await f.start();
    release();
    await first;
    expect(deps.lookup).toHaveBeenCalledTimes(1);
  });
});

describe("writing genres", () => {
  it("writes only the ticked suggestions, one song at a time, and nothing before it is asked", async () => {
    const { fill: f, deps } = fill([song(1), song(2), song(3)]);
    await f.start();
    expect(deps.write).not.toHaveBeenCalled();

    f.setInclude("/m/2.mp3", false);
    await f.write();

    expect(vi.mocked(deps.write).mock.calls.map(([t, g]) => [t.title, g])).toEqual([["Song 1", "Rock"], ["Song 3", "Rock"]]);
    expect(f.state.phase).toBe("done");
    expect(f.state.written).toBe(2);
    expect(f.state.suggestions.map((s) => s.state)).toEqual(["written", "pending", "written"]);
  });

  it("records a failed write and goes on to the next song", async () => {
    const { fill: f } = fill([song(1), song(2)], { write: vi.fn().mockResolvedValueOnce("Couldn't replace the original").mockResolvedValueOnce(null) });
    await f.start();
    await f.write();
    expect(f.state.failedWrites).toBe(1);
    expect(f.state.written).toBe(1);
    expect(f.state.suggestions[0]).toMatchObject({ state: "failed", error: "Couldn't replace the original" });
  });

  it("can be stopped between songs", async () => {
    const { fill: f } = fill([song(1), song(2), song(3)], {
      write: vi.fn(async (t) => {
        if (t.title === "Song 1") f.cancel();
        return null;
      }),
    });
    await f.start();
    await f.write();
    expect(f.state.written).toBe(1);
    expect(f.state.suggestions.map((s) => s.state)).toEqual(["written", "pending", "pending"]);
  });

  it("select all and none only touch songs not yet written", async () => {
    const { fill: f } = fill([song(1), song(2)]);
    await f.start();
    f.setAll(false);
    expect(f.state.suggestions.every((s) => !s.include)).toBe(true);
    f.setAll(true);
    expect(f.state.suggestions.every((s) => s.include)).toBe(true);
  });

  it("will not write before there is something to review", async () => {
    const { fill: f, deps } = fill([song(1)]);
    await f.write();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("starts over after it is done, with whatever still has no genre", async () => {
    const library = [song(1), song(2)];
    const { fill: f } = fill(library);
    await f.start();
    await f.write();
    f.reset();
    expect(f.state.phase).toBe("idle");
    expect(f.state.suggestions).toEqual([]);
  });
});
