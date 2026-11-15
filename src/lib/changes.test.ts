import { describe, expect, it } from "vitest";
import { changedTracks, queueReplacements, sameRecording } from "./changes";
import { makeTrack } from "./testing";

const t = (path: string, title: string, over = {}) => makeTrack({ path, title, artist: "PROF", album: "", durationMs: 165_000, ...over });

describe("sameRecording", () => {
  it("matches the same title and length, ignoring case and punctuation", () => {
    expect(sameRecording(t("a", "Dynamite"), t("b", "dynamite!", { durationMs: 165_200 }))).toBe(true);
  });
  it("does not match a different title or a clearly different length", () => {
    expect(sameRecording(t("a", "Dynamite"), t("b", "Dynamite (Live)"))).toBe(false);
    expect(sameRecording(t("a", "Dynamite"), t("b", "Dynamite", { durationMs: 200_000 }))).toBe(false);
    expect(sameRecording(t("a", ""), t("b", ""))).toBe(false);
  });
});

describe("changedTracks", () => {
  const before = [t("/m/a.mp3", "A"), t("/m/b.mp3", "B")];
  it("is what is new or retagged, not what is unchanged", () => {
    const after = [t("/m/a.mp3", "A"), t("/m/b.mp3", "B", { album: "New Album" }), t("/m/c.mp3", "C")];
    expect(changedTracks(before, after).map((x) => x.path)).toEqual(["/m/b.mp3", "/m/c.mp3"]);
  });
  it("is empty when nothing changed", () => {
    expect(changedTracks(before, before)).toEqual([]);
  });
});

describe("queueReplacements", () => {
  it("refreshes an entry for the same file whose tags are out of date", () => {
    const queue = [t("/m/PROF/Unknown/Dynamite.mp3", "Dynamite")];
    const fresh = t("/m/PROF/Unknown/Dynamite.mp3", "Dynamite", { album: "Good Time Boy" });
    expect(queueReplacements(queue, [fresh], [fresh])).toEqual([{ oldPath: queue[0].path, track: fresh }]);
  });

  it("leaves an entry alone when its tags are already current", () => {
    const same = t("/m/a.mp3", "A");
    expect(queueReplacements([same], [same], [{ ...same }])).toEqual([]);
  });

  it("follows a song that was undone and re-added somewhere else (the Dynamite case)", () => {
    const stale = t("/m/PROF/Unknown Album/Dynamite.mp3", "Dynamite", { artist: "PROF" });
    const readded = t("/m/PROF/Good Time Boy/06 Dynamite.mp3", "Dynamite", { artist: "Prof", album: "Good Time Boy" });
    const library = [readded, t("/m/other.mp3", "Other")];
    expect(queueReplacements([stale], library, [readded])).toEqual([{ oldPath: stale.path, track: readded }]);
  });

  it("does not touch an entry whose file is still in the library, even if a lookalike was added", () => {
    const q = t("/m/orig/Dynamite.mp3", "Dynamite");
    const copy = t("/m/copy/Dynamite.mp3", "Dynamite", { album: "X" });
    expect(queueReplacements([q], [q, copy], [copy])).toEqual([]);
  });

  it("does not guess when the library has not loaded", () => {
    const stale = t("/m/gone.mp3", "Dynamite");
    expect(queueReplacements([stale], [], [t("/m/new.mp3", "Dynamite")])).toEqual([]);
  });

  it("prefers a candidate by the same artist, and replaces each file once", () => {
    const stale = t("/m/gone.mp3", "Dynamite", { artist: "PROF" });
    const other = t("/m/x.mp3", "Dynamite", { artist: "BTS" });
    const right = t("/m/y.mp3", "Dynamite", { artist: "prof" });
    const out = queueReplacements([stale, stale], [other, right], [other, right]);
    expect(out).toEqual([{ oldPath: stale.path, track: right }]);
  });

  it("does nothing for an empty queue or no changes", () => {
    expect(queueReplacements([], [t("a", "A")], [t("a", "A")])).toEqual([]);
    expect(queueReplacements([t("a", "A")], [t("a", "A")], [])).toEqual([]);
  });
});
