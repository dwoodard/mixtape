import { afterEach, describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { imports } from "../lib/store";
import type { ImportItem } from "../lib/types";
import ImportInbox from "./ImportInbox.vue";

const song = (id: number, stage: ImportItem["stage"]): ImportItem =>
  ({ id, stage, url: `u${id}`, videoTitle: `Song ${id}`, proposal: { title: `Song ${id}`, artist: "Primus", album: "Album", albumArtist: "", year: "1990", track: "", genre: "", disc: "", discTotal: "" }, confidence: 0.9, progress: 0.3, picard: "none", notes: [], sources: {}, alternatives: {}, error: null }) as unknown as ImportItem;

const draw = (picked: number[]) =>
  renderToString(createSSRApp({ render: () => h(ImportInbox, { focus: null, picked: new Set(picked) }) }));

afterEach(() => {
  imports.items.value = [];
});

describe("stopping songs that are still loading", () => {
  it("shows no stop controls when nothing is loading", async () => {
    imports.items.value = [song(1, "ready"), song(2, "added")];
    const html = await draw([1]);
    expect(html).not.toContain("loading");
    expect(html).not.toContain("Stop all");
  });

  it("offers to stop the ticked ones, the rest, or all, with how many are loading", async () => {
    imports.items.value = [song(1, "fetching"), song(2, "queued"), song(3, "queued"), song(4, "ready")];
    const html = await draw([1, 4]);
    expect(html).toContain("3 loading");
    // One ticked song is loading (the ready one does not count).
    expect(html).toMatch(/Stop\s*1\s*selected/);
    expect(html).toContain("Stop the rest");
    expect(html).toContain("Stop all");
  });

  it("disables stopping the selection when no loading song is ticked, but not Stop all", async () => {
    imports.items.value = [song(1, "fetching"), song(2, "ready")];
    const html = await draw([2]);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Stop\s*selected/);
    expect(html).toMatch(/<button[^>]*class="danger"[^>]*>Stop all/);
    expect(html).not.toMatch(/<button[^>]*class="danger"[^>]*disabled/);
  });

  it("marks ticked rows and tells people shift-click picks a range", async () => {
    imports.items.value = [song(1, "ready"), song(2, "ready")];
    const html = await draw([2]);
    expect(html.match(/<tr class="picked"/g)).toHaveLength(1);
    expect(html).toContain("Shift-click to select a range");
  });
});

describe("songs held back from a playlist", () => {
  it("lists them with how many are held and the ways to fetch them, and no stop controls", async () => {
    imports.items.value = [song(1, "held"), song(2, "held"), song(3, "held")];
    const html = await draw([2]);
    expect(html).toContain("3 held, not fetched");
    expect(html).toMatch(/Fetch\s*1\s*selected/);
    expect(html).toContain("Fetch all 3");
    expect(html).toContain("Skip selected");
    expect(html).toContain("Held · not fetched");
    // Nothing is loading, so there is nothing to stop.
    expect(html).not.toContain("Stop all");
  });

  it("disables fetching and skipping the selection until a held song is ticked", async () => {
    imports.items.value = [song(1, "held"), song(2, "ready")];
    const html = await draw([2]);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Fetch\s*selected/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Skip selected/);
    expect(html).toMatch(/<button[^>]*title="Fetch every held song"[^>]*>Fetch all 1/);
  });

  it("shows no held bar when nothing is held", async () => {
    imports.items.value = [song(1, "ready")];
    expect(await draw([])).not.toContain("held, not fetched");
  });
});


describe("fetching one held song from its row", () => {
  it("puts a Fetch button on held rows only", async () => {
    imports.items.value = [song(1, "held"), song(2, "ready")];
    const html = await draw([]);
    expect(html.match(/title="Fetch this song"/g)).toHaveLength(1);
  });
});

describe("showing an added song in the library", () => {
  it("puts Show in library on added rows that have a file, and not on ready ones", async () => {
    imports.items.value = [{ ...song(1, "added"), addedPath: "/lib/a.mp3" } as ImportItem, song(2, "ready")];
    const html = await draw([]);
    expect(html.match(/Show in library/g)).toHaveLength(1);
  });
});

describe("the title links to the video on YouTube", () => {
  it("links songs that came from YouTube, and not songs from a file", async () => {
    imports.items.value = [
      { ...song(1, "ready"), url: "https://www.youtube.com/watch?v=abc" } as ImportItem,
      { ...song(2, "ready"), url: "/Users/me/song.mp3" } as ImportItem,
    ];
    const html = await draw([]);
    expect(html.match(/title="Open the video on YouTube"/g)).toHaveLength(1);
  });
});

describe("the inbox filter", () => {
  it("shows a filter box with the songs listed, and no filter box for an empty inbox", async () => {
    imports.items.value = [song(1, "ready"), song(2, "ready")];
    const html = await draw([]);
    expect(html).toContain('id="inbox-filter"');
    expect(html).toContain("Song 1");
    expect(html).toContain("Song 2");
    imports.items.value = [];
    expect(await draw([])).not.toContain("inbox-filter");
  });
});
