import { describe, expect, it } from "vitest";
import { panelWantedHeight, queueSummary, THIN_MIN_WIDTH, THIN_TIERS, thinParts, thinTier, widthFromDrag } from "./thinBar";
import { makeTrack } from "./testing";

const queue = ["a", "b", "c"].map((n, i) => makeTrack({ path: `/m/${n}.mp3`, title: n, durationMs: (i + 1) * 60_000 }));

describe("queueSummary", () => {
  it("names the song directly below the current one as next, and counts the queue", () => {
    const s = queueSummary(queue, 0);
    expect(s.count).toBe(3);
    expect(s.next?.title).toBe("b");
    expect(s.totalMs).toBe(360_000);
  });
  it("has no next song at the end of the queue", () => {
    expect(queueSummary(queue, 2).next).toBeNull();
  });
  it("with nothing current, the next song is the first one", () => {
    expect(queueSummary(queue, null).next?.title).toBe("a");
  });
  it("is empty for an empty queue", () => {
    expect(queueSummary([], null)).toEqual({ count: 0, next: null, totalMs: 0 });
  });
});

describe("widthFromDrag", () => {
  it("grows by how far the pointer moved right and shrinks when it moves left", () => {
    expect(widthFromDrag(480, 1000, 1150)).toBe(630);
    expect(widthFromDrag(700, 1000, 900)).toBe(600);
  });
  it("rounds to whole pixels", () => {
    expect(widthFromDrag(480, 100, 100.6)).toBe(481);
  });
});

describe("thin bar tiers", () => {
  const MINS = [120, 160, 200, 240, 300, 380, 460, 560, 660, 800, 1000, 1320];
  const on = (tier: number) =>
    Object.entries(thinParts(tier)).filter(([, shown]) => shown).map(([key]) => key);

  it("starts at the minimum width the window allows (120)", () => {
    expect(THIN_MIN_WIDTH).toBe(120);
    expect(THIN_TIERS[0].min).toBe(THIN_MIN_WIDTH);
  });

  it("picks the right tier at every boundary, one pixel either side", () => {
    expect(THIN_TIERS.map((t) => t.min)).toEqual(MINS);
    MINS.forEach((min, i) => {
      expect(thinTier(min)).toBe(i);
      if (i > 0) expect(thinTier(min - 1)).toBe(i - 1);
    });
  });

  it("covers the whole range: below the minimum is the smallest tier, huge is the largest", () => {
    expect(thinTier(0)).toBe(0);
    expect(thinTier(119)).toBe(0);
    expect(thinTier(1727)).toBe(THIN_TIERS.length - 1);
    expect(thinTier(8000)).toBe(THIN_TIERS.length - 1);
    expect(thinTier(Number.NaN)).toBe(0);
  });

  it("at the minimum only play/pause and volume are left", () => {
    expect(on(0)).toEqual(["playPause", "volume"]);
  });

  it("growing from the minimum adds next, previous, the queue button, title, time, scrubber, then the extras", () => {
    expect(on(1)).toEqual(["playPause", "volume", "next"]);
    expect(on(2)).toEqual(["playPause", "volume", "next", "prev"]);
    expect(on(3)).toEqual(["playPause", "volume", "next", "prev", "queueButton", "djButton"]);
    expect(on(4)).toContain("title");
    expect(on(4)).not.toContain("time");
    expect(on(5)).toContain("time");
    expect(on(5)).not.toContain("seek");
    expect(on(6)).toContain("seek");
    expect(on(6)).not.toContain("repeat");
  });

  it("the extras arrive as repeat, shuffle, artist, cover art, then the queue summary (last)", () => {
    const first = (key: keyof ReturnType<typeof thinParts>) => THIN_TIERS.findIndex((_, t) => thinParts(t)[key]);
    const order = ["next", "prev", "queueButton", "title", "time", "seek", "repeat", "shuffle", "artist", "cover", "queueSummary"] as const;
    const tiers = order.map(first);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it("each tier adds something and never takes anything away", () => {
    for (let t = 1; t < THIN_TIERS.length; t++) {
      const before = on(t - 1);
      const now = on(t);
      before.forEach((key) => expect(now, `${key} disappears at tier ${t}`).toContain(key));
      expect(now.length, `tier ${t} adds nothing`).toBeGreaterThan(before.length);
    }
  });

  it("an old saved width of 480 shows the tier that fits it", () => {
    expect(thinTier(480)).toBe(6);
    expect(on(thinTier(480))).toEqual(
      expect.arrayContaining(["playPause", "volume", "next", "prev", "queueButton", "title", "time", "seek", "expandQuit"]),
    );
    expect(on(thinTier(480))).not.toContain("repeat");
  });

  it("the full-width bar shows everything", () => {
    expect(Object.values(thinParts(THIN_TIERS.length - 1)).every(Boolean)).toBe(true);
  });
});

describe("panelWantedHeight", () => {
  it("grows by a row per song on top of the panel's own header", () => {
    expect(panelWantedHeight(10) - panelWantedHeight(9)).toBe(28);
    expect(panelWantedHeight(3)).toBeGreaterThan(panelWantedHeight(2));
  });
  it("leaves room for the empty-queue message when the queue is empty", () => {
    expect(panelWantedHeight(0)).toBe(panelWantedHeight(1));
  });
});
