import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import type { DjHost, DjView } from "../lib/dj";
import { makeTrack } from "../lib/testing";
import type { ImportItem } from "../lib/types";
import DjViews from "./DjViews.vue";

const halo = makeTrack({ path: "/m/halo.mp3", title: "Halo", artist: "Beyoncé", album: "I Am", year: 2008 });
const host = {
  plays: () => ({ "/m/halo.mp3": { count: 12, lastPlayedMs: Date.UTC(2026, 10, 14) } }),
  imports: () => [{ id: 4, stage: "ready", url: "u", videoTitle: "Some video", proposal: { title: "Imported song", artist: "Band" }, picard: "none", progress: 1 }] as unknown as ImportItem[],
} as unknown as DjHost;

const render = (view: DjView) => renderToString(createSSRApp({ render: () => h(DjViews, { view, host }) }));

describe("DjViews", () => {
  it("draws songs with their play count and the controls to play, queue and show them", async () => {
    const html = await render({ kind: "songs", title: "Found", songs: [halo, makeTrack({ path: "/m/b.mp3", title: "Other" })], total: 2 });
    expect(html).toContain("Halo");
    expect(html).toContain("12×");
    for (const control of ["Play now", "Play next", "Add to the queue", "Show in the library", "Play all"]) expect(html).toContain(control);
  });

  it("marks the song that is playing", async () => {
    const html = await render({ kind: "songs", title: "Left to play", songs: [halo, makeTrack({ path: "/m/b.mp3", title: "Next one" })], total: 2, currentPath: "/m/halo.mp3" });
    expect(html).toContain("Now playing");
    expect(html.match(/Now playing/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="(song current|current song)"/);
  });

  it("shows a few songs and offers the rest", async () => {
    const many = Array.from({ length: 9 }, (_, i) => makeTrack({ path: `/m/${i}.mp3`, title: `Song ${i}` }));
    const html = await render({ kind: "songs", title: "Queue", songs: many, total: 9 });
    expect(html).toContain("Song 5");
    expect(html).not.toContain("Song 6");
    expect(html).toContain("Show all 9");
  });

  it("draws each tag match with its confidence, what would change and an Apply button", async () => {
    const html = await render({
      kind: "tags",
      song: makeTrack({ title: "Halo", album: "", year: 2008 }),
      matches: [{ title: "Halo", artist: "Artist", album: "I Am", albumArtist: "", year: "2008", trackNumber: "3", discNumber: "", genreHint: "", releaseKind: "Album", confidence: 91, reasons: ["same length"] }],
    });
    expect(html).toContain("91%");
    expect(html).toContain("Album");
    expect(html).toContain("(empty)");
    expect(html).toContain(">I Am<");
    expect(html).toContain("Apply");
    // The year already matches, so it is not listed as a change.
    expect(html).not.toContain("Year");
  });

  it("heads the lyrics with what the service matched, and warns only when that is not your song", async () => {
    const same = await render({ kind: "lyrics", song: halo, text: "words", instrumental: false, source: "lrclib.net", matched: { title: "Halo", artist: "Beyonce", album: "I Am...Sasha Fierce" } });
    expect(same).toContain("I Am...Sasha Fierce");
    expect(same).toContain("Lyrics · lrclib.net");
    expect(same).toContain("Beyonce");
    expect(same).not.toContain("wrong lyrics");

    const other = await render({ kind: "lyrics", song: halo, text: "words", instrumental: false, matched: { title: "Halo (Live)", artist: "Beyoncé", album: "World Tour" } });
    expect(other).toContain("Matched");
    expect(other).toContain("wrong lyrics");
    expect(other).toContain("Halo (Live)");

    // Without a match (an older card) it falls back to your own song.
    const bare = await render({ kind: "lyrics", song: halo, text: "words", instrumental: false });
    expect(bare).toContain("Halo");
    expect(bare).not.toContain("lrclib");
  });

  it("draws lyrics, an instrumental note, duplicates with a Trash button, and Discovery with its controls", async () => {
    expect(await render({ kind: "lyrics", song: halo, text: "Remember those walls", instrumental: false })).toContain("Remember those walls");
    expect(await render({ kind: "lyrics", song: halo, text: "", instrumental: true })).toContain("instrumental");
    const dup = await render({ kind: "duplicates", groups: [{ keep: halo, extras: [makeTrack({ path: "/m/halo 1.mp3" })] }] });
    expect(dup).toContain("Move 1 extra to the Trash");
    const imp = await render({ kind: "imports", ids: [4] });
    expect(imp).toContain("Imported song");
    expect(imp).toContain(">Add<");
    expect(imp).toContain("Picard");
  });
});
