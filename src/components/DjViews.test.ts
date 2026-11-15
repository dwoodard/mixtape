import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import type { DjHost, DjView } from "../lib/dj";
import { makeTrack } from "../lib/testing";
import type { ImportItem } from "../lib/types";
import { createGenreFill } from "../lib/genreFill";
import DjViews from "./DjViews.vue";

const halo = makeTrack({ path: "/m/halo.mp3", title: "Halo", artist: "Beyoncé", album: "I Am", year: 2008 });
const host = {
  library: () => [],
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

  const match = { recordingId: "", releaseId: "", title: "Halo", artist: "Artist", album: "I Am", albumArtist: "", year: "2008", trackNumber: "3", discNumber: "", genreHint: "pop", releaseKind: "Album", confidence: 91, reasons: ["same length"] };

  it("draws a tag match with its confidence and an Apply button counting what would change", async () => {
    const html = await render({ kind: "tags", song: makeTrack({ title: "Halo", album: "", year: 2008 }), matches: [match] });
    expect(html).toContain("91%");
    // Album and track differ; title, artist and year already match.
    expect(html).toContain("Apply 2 changes");
    expect(html).not.toContain("Already matches");
  });

  it("opens a single match by itself, showing every tag beside the song's own and marking what differs", async () => {
    const html = await render({ kind: "tags", song: makeTrack({ title: "Halo", album: "", year: 2008 }), matches: [match] });
    expect(html).toContain("MusicBrainz</th>");
    for (const label of ["Title", "Artist", "Album", "Album artist", "Track", "Disc", "Year", "Genre"]) expect(html).toContain(`>${label}</th>`);
    expect(html).toContain("(empty)");
    expect(html).toContain("suggestion, not in the file");
    // Album and track are marked as differing, year is not.
    expect(html.match(/<tr class="differs"/g)).toHaveLength(2);
    // And the ways to go further: the page, Picard, the library.
    expect(html).toContain("MusicBrainz ↗");
    expect(html).toContain(">Picard<");
    expect(html).toContain(">Show<");
  });

  it("every card follows the library, so edited tags show here too", async () => {
    const drawn = makeTrack({ path: "/m/one.mp3", title: "Old Title", artist: "Old Artist" });
    const edited = { ...drawn, title: "New Title", artist: "New Artist" };
    const withLibrary = (view: DjView) =>
      renderToString(createSSRApp({ render: () => h(DjViews, { view, host: { ...host, library: () => [edited] } as unknown as DjHost }) }));

    const songs = await withLibrary({ kind: "songs", title: "Queue", songs: [drawn], total: 1 });
    expect(songs).toContain("New Title");
    expect(songs).not.toContain("Old Title");

    const lyrics = await withLibrary({ kind: "lyrics", song: drawn, text: "words", instrumental: false });
    expect(lyrics).toContain("New Title");

    const dup = await withLibrary({ kind: "duplicates", groups: [{ keep: drawn, extras: [] }] });
    expect(dup).toContain("New Title");
  });

  it("compares against the song as the library has it now, so a saved match reads Already matches", async () => {
    const drawn = makeTrack({ path: "/m/two.mp3", title: "Halo", artist: "Artist", album: "I Am", year: 2019, trackNumber: 3 });
    const saved = { ...drawn, year: 2008 };
    const view: DjView = { kind: "tags", song: drawn, matches: [match] };
    const withHost = (library: ReturnType<typeof makeTrack>[]) =>
      renderToString(createSSRApp({ render: () => h(DjViews, { view, host: { ...host, library: () => library } as unknown as DjHost }) }));

    // Before the save the year differs; after it the library has the new year and the card follows.
    expect(await withHost([drawn])).toContain("Apply 1 change");
    const after = await withHost([saved]);
    expect(after).toContain("✓ Already matches");
    expect(after).not.toMatch(/Apply \d+ change/);
  });

  it("offers to add the genre suggestion only when the song has no genre, and never as part of Apply", async () => {
    const empty = await render({ kind: "tags", song: makeTrack({ title: "Halo", album: "I Am", year: 2008, trackNumber: 3, genre: "" }), matches: [match] });
    expect(empty).toContain('title="Write this genre into the song"');
    // Everything else already matches, so there is nothing for Apply to do: the genre alone does not count as a change.
    expect(empty).toContain("✓ Already matches");

    const tagged = await render({ kind: "tags", song: makeTrack({ title: "Halo", album: "I Am", year: 2008, trackNumber: 3, genre: "Rock" }), matches: [match] });
    expect(tagged).not.toContain("Write this genre into the song");
  });

  it("keeps several matches closed until one is opened, with only the summary showing", async () => {
    const html = await render({ kind: "tags", song: makeTrack({ title: "Halo" }), matches: [match, { ...match, album: "Other", confidence: 60 }] });
    expect(html).toContain("91%");
    expect(html).toContain("60%");
    expect(html).not.toContain("suggestion, not in the file");
    expect(html).not.toContain("MusicBrainz ↗");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  it("says Already matches, as plain text and not a button, when nothing would change", async () => {
    const song = makeTrack({ title: "Halo", artist: "Artist", album: "I Am", year: 2008, trackNumber: 3 });
    const html = await render({ kind: "tags", song, matches: [match] });
    expect(html).toMatch(/<span class="ok"[^>]*>✓ Already matches<\/span>/);
    expect(html).not.toMatch(/Apply \d+ change/);
  });

  it("offers to save fetched lyrics into the song's tags, and says so when they are already there", async () => {
    const fetched = await render({ kind: "lyrics", song: halo, text: "words", instrumental: false, source: "lrclib.net" });
    expect(fetched).toContain("Save in the song&#39;s tags");
    expect(fetched).not.toContain("✓ Saved");

    const saved = await render({ kind: "lyrics", song: halo, text: "words", instrumental: false, source: "saved in the song's tags", saved: true });
    expect(saved).toContain("✓ Saved in the song&#39;s tags");
    expect(saved).not.toContain("<button");

    // An instrumental has nothing to save.
    const none = await render({ kind: "lyrics", song: halo, text: "", instrumental: true });
    expect(none).not.toContain("Save in the song");
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

  describe("the genre fill card", () => {
    const songs = [makeTrack({ path: "/m/a.mp3", title: "Song A", artist: "Band", genre: "" }), makeTrack({ path: "/m/b.mp3", title: "Song B", artist: "Band", genre: "" })];
    const mb = (genreHint: string) => ({ recordingId: "", releaseId: "", title: "", artist: "", album: "", albumArtist: "", year: "", trackNumber: "", discNumber: "", genreHint, releaseKind: "", confidence: 90, reasons: [] });
    const make = () => createGenreFill({ library: () => songs, lookup: async () => [mb("progressive rock")], write: async () => null });
    const draw = (job: ReturnType<typeof make>) =>
      renderToString(createSSRApp({ render: () => h(DjViews, { view: { kind: "genres", job } as DjView, host: { ...host, library: () => songs } as unknown as DjHost }) }));

    it("offers to start, with how long it will take and a promise to write nothing yet", async () => {
      const html = await draw(make());
      expect(html).toContain("2 songs have no genre");
      expect(html).toContain("about 1 minutes");
      expect(html).toContain("Nothing is written until you say so");
      expect(html).toContain(">Start<");
    });

    it("shows progress with a way to stop while it looks", async () => {
      const job = make();
      job.state.phase = "looking";
      job.state.total = 10;
      job.state.looked = 4;
      const html = await draw(job);
      expect(html).toContain("Looked up 4 of 10");
      expect(html).toContain("width:40%");
      expect(html).toContain("Stop and review");
    });

    it("lists the suggestions to choose from, with totals, and the button counts what is ticked", async () => {
      const job = make();
      await job.start();
      job.setInclude("/m/b.mp3", false);
      const html = await draw(job);
      expect(html).toContain("2 suggestions from 2 songs");
      expect(html).toContain("Progressive Rock 2");
      expect(html).toContain("Song A");
      expect(html).toContain("Write 1 genre<");
      expect(html.match(/type="checkbox"/g)).toHaveLength(2);
      expect(html.match(/checked/g)).toHaveLength(1);
    });

    it("reports what was written and what failed when done", async () => {
      const job = make();
      job.state.phase = "done";
      job.state.written = 3;
      job.state.failedWrites = 1;
      job.state.suggestions = [{ track: songs[0], genre: "Rock", confidence: 90, include: true, state: "failed", error: "Couldn't replace the original" }];
      const html = await draw(job);
      expect(html).toContain("Wrote 3 genres");
      expect(html).toContain("1 failed");
      expect(html).toContain("Couldn&#39;t replace the original");
    });
  });
});

