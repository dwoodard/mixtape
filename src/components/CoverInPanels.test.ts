import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { libraryQuery, libraryView, searchLibrary, setAppMode, appMode } from "../lib/ui";
import { store } from "../lib/store";
import { makeTrack } from "../lib/testing";
import QueueList from "./QueueList.vue";
import TagPanel from "./TagPanel.vue";

const render = (component: object, props: Record<string, unknown> = {}) =>
  renderToString(createSSRApp({ render: () => h(component, props) }));

describe("cover art in the queue", () => {
  it("shows a cover beside every song", async () => {
    store.queue.value = [
      makeTrack({ path: "/m/a.mp3", title: "One", album: "Disc" }),
      makeTrack({ path: "/m/b.mp3", title: "Two", album: "Other" }),
    ];
    const html = await render(QueueList);
    expect(html).toContain("One");
    expect(html.match(/class="cover[ "]/g)).toHaveLength(2);
    expect(html).toContain("cover://");
    store.queue.value = [];
  });
});

describe("cover art in the now playing tags", () => {
  it("shows the cover of the song next to its tags", async () => {
    const html = await render(TagPanel, { track: makeTrack({ path: "/m/a.mp3", title: "War Pigs", album: "The Vinyl Collection" }) });
    expect(html).toContain("War Pigs");
    expect(html).toMatch(/class="cover[ "]/);
    expect(html.indexOf("cover")).toBeLessThan(html.indexOf("<dl"));
  });

  it("shows no cover when nothing is playing", async () => {
    const html = await render(TagPanel, { track: null });
    expect(html).toContain("Nothing playing");
    expect(html).not.toMatch(/class="cover[ "]/);
  });
});

describe("links in the now playing tags", () => {
  const track = makeTrack({ path: "/m/tool/10.mp3", title: "Right in Two", artist: "Tool", album: "10,000 Days", albumArtist: "Tool", genre: "", year: 2019, trackNumber: 10, discNumber: 1 });

  it("makes artist, album, album artist and the file links, and the cover opens the album", async () => {
    const html = await render(TagPanel, { track });
    const links = [...html.matchAll(/<button class="link"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    // Artist, album, album artist, year, file. Not the title, track, disc, length, or an empty genre.
    expect(links).toEqual(["Tool", "10,000 Days", "Tool", "2019", "/m/tool/10.mp3"]);
    expect(html).toContain("art-link");
    expect(html).toContain("Show the file in Finder");
  });

  it("links the genre only when there is one", async () => {
    const html = await render(TagPanel, { track: { ...track, genre: "Metal" } });
    expect(html).toMatch(/<button class="link"[^>]*>Metal<\/button>/);
  });

  it("a song with no year has nothing to link", async () => {
    const html = await render(TagPanel, { track: { ...track, year: null } });
    expect([...html.matchAll(/<button class="link"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).not.toContain("2019");
  });

  it("a song with no album has a plain cover, not a link", async () => {
    const html = await render(TagPanel, { track: { ...track, album: "" } });
    expect(html).not.toContain("art-link");
  });
});

describe("searchLibrary", () => {
  it("shows the player's Tracks view filtered to the words", () => {
    setAppMode("settings");
    libraryView.value = "albums";
    searchLibrary("Tool");
    expect(appMode.value).toBe("player");
    expect(libraryView.value).toBe("tracks");
    expect(libraryQuery.value).toBe("Tool");
  });
});

