import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { makeTrack } from "../lib/testing";
import TrackTable from "./TrackTable.vue";

const render = (extra: Record<string, unknown> = {}) =>
  renderToString(
    createSSRApp({
      render: () =>
        h(TrackTable, {
          tracks: [makeTrack({ path: "/a", title: "Halo" }), makeTrack({ path: "/b", title: "Other" })],
          currentPath: null,
          selected: new Set<string>(),
          sortKey: "default",
          sortDirection: "asc",
          ...extra,
        }),
    }),
  );

describe("TrackTable", () => {
  it("shows the songs and a Plays column with each count at the far right", async () => {
    const html = await render({ plays: { "/a": { count: 4, lastPlayedMs: 1_700_000_000_000 } } });
    expect(html).toContain("Halo");
    expect(html).toContain("Plays");
    expect(html).toMatch(/class="cell time plays"[^>]*>4</);
    // A song never played shows nothing there.
    expect(html).toMatch(/class="cell time plays" title="Not played yet"[^>]*><\/span>/);
    // The count comes after the time and before the add button.
    expect(html.indexOf('class="cell time"')).toBeLessThan(html.indexOf('class="cell time plays"'));
    expect(html.indexOf('class="cell time plays"')).toBeLessThan(html.indexOf('class="add"'));
  });

  it("draws a line on the left edge only for songs missing a cover or lyrics, with a tooltip saying which", async () => {
    const complete = makeTrack({ path: "/a", title: "Complete" });
    const noCover = makeTrack({ path: "/b", title: "NoCover", hasCover: false });
    const noLyrics = makeTrack({ path: "/c", title: "NoLyrics", hasLyrics: false });
    const html = await render({ tracks: [complete, noCover, noLyrics] });
    const rows = html.split('class="row item"').slice(1);
    expect(rows[0]).not.toContain('class="gaps"');
    expect(rows[1]).toContain("No cover art");
    expect(rows[1]).not.toContain("No lyrics");
    expect(rows[2]).toContain("No lyrics saved");
    expect(rows[2]).not.toContain("No cover art");
  });

  it("still shows the songs when no play counts are given", async () => {
    const html = await render();
    expect(html).toContain("Halo");
    expect(html).toContain("Other");
  });
});
