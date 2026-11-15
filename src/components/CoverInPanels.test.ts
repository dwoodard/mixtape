import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
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
