import { describe, expect, it } from "vitest";
import type { DjHost } from "./dj";
import { createGenreFill } from "./genreFill";
import type { DuplicateGroup } from "./duplicates";
import { MAX_SUGGESTIONS, suggestionsFor } from "./djSuggestions";
import { makePlayerState, makeTrack } from "./testing";
import type { ImportItem, PlayerState, Track } from "./types";

const song = makeTrack({ path: "/m/a.mp3", title: "A" });

function host(over: { player?: Partial<PlayerState>; queue?: Track[]; imports?: Partial<ImportItem>[]; dupes?: number; library?: Track[] } = {}) {
  return {
    player: () => makePlayerState(over.player),
    queue: () => over.queue ?? [],
    imports: () => (over.imports ?? []) as ImportItem[],
    duplicateGroups: () => Array.from({ length: over.dupes ?? 0 }) as DuplicateGroup[],
    library: () => over.library ?? [song],
    genreFill: () => createGenreFill({ library: () => over.library ?? [song], lookup: async () => [], write: async () => null }),
  } as unknown as DjHost;
}
const labels = (h: DjHost) => suggestionsFor(h).map((s) => s.label);

describe("chat suggestions", () => {
  it("offers things about the song only when one is playing", () => {
    expect(labels(host())).not.toContain("Lyrics for this song");
    const playing = labels(host({ player: { currentTrack: song, status: "playing", currentIndex: 0 }, queue: [song] }));
    expect(playing).toEqual(expect.arrayContaining(["Lyrics for this song", "Look up its tags", "Times played"]));
  });

  it("asks about what is left only when a queue exists, and shows the whole queue when nothing follows", () => {
    expect(labels(host())).not.toContain("What's left in the queue?");
    const more = suggestionsFor(host({ player: { currentTrack: song, currentIndex: 0 }, queue: [song, song] }));
    expect(more.find((s) => s.label === "What's left in the queue?")?.prompt).toBe("What's left in the queue?");
    const last = suggestionsFor(host({ player: { currentTrack: song, currentIndex: 0 }, queue: [song] }));
    expect(last.find((s) => s.prompt === "Show me the queue")?.label).toBe("Show the queue");
  });

  it("offers Discovery and duplicates only when there is something to review", () => {
    expect(labels(host())).not.toEqual(expect.arrayContaining(["Find duplicates"]));
    const busy = labels(host({ dupes: 2, imports: [{ stage: "ready" }, { stage: "ready" }, { stage: "failed" }] }));
    expect(busy).toContain("Review Discovery (2)");
    expect(busy).toContain("Find duplicates");
  });

  it("always has something to start with, and never more than the limit", () => {
    const quiet = suggestionsFor(host());
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.map((s) => s.label)).toContain("Queue 15 songs I haven't played");
    const full = suggestionsFor(host({ player: { currentTrack: song, currentIndex: 0 }, queue: [song, song], dupes: 1, imports: [{ stage: "ready" }] }));
    expect(full).toHaveLength(MAX_SUGGESTIONS);
    // What is about the playing song comes first.
    expect(full[0].label).toBe("Lyrics for this song");
  });

  it("does not offer picks from an empty library", () => {
    expect(labels(host({ library: [] }))).not.toContain("Queue 10 songs I might like");
    expect(labels(host())).toContain("Queue 10 songs I might like");
  });

  it("offers to fill in genres only when a fair number are missing", () => {
    const few = Array.from({ length: 5 }, (_, i) => makeTrack({ path: `/m/${i}.mp3`, genre: "" }));
    const many = Array.from({ length: 30 }, (_, i) => makeTrack({ path: `/m/${i}.mp3`, genre: "" }));
    const tagged = Array.from({ length: 30 }, (_, i) => makeTrack({ path: `/m/${i}.mp3`, genre: "Rock" }));
    expect(labels(host({ library: few }))).not.toContain("Fill in missing genres");
    expect(labels(host({ library: tagged }))).not.toContain("Fill in missing genres");
    expect(labels(host({ library: many }))).toContain("Fill in missing genres");
  });
});

