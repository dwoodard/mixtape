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

  it("still shows the songs when no play counts are given", async () => {
    const html = await render();
    expect(html).toContain("Halo");
    expect(html).toContain("Other");
  });
});
