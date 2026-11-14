import { describe, expect, it } from "vitest";
import { clickRow, emptySelection, moveSelection, pruneSelection, selectAll, selectedTracks } from "./selection";
import { makeTrack } from "./testing";

const rows = ["a", "b", "c", "d", "e"];
const plain = { shift: false, toggle: false };

describe("clickRow", () => {
  it("a plain click selects only that row", () => {
    const first = clickRow(emptySelection(), rows, "b", plain);
    const second = clickRow(first, rows, "d", plain);
    expect([...second.paths]).toEqual(["d"]);
    expect(second.anchor).toBe("d");
  });

  it("toggle adds and removes rows without losing the others", () => {
    let sel = clickRow(emptySelection(), rows, "a", plain);
    sel = clickRow(sel, rows, "c", { shift: false, toggle: true });
    expect([...sel.paths].sort()).toEqual(["a", "c"]);
    sel = clickRow(sel, rows, "a", { shift: false, toggle: true });
    expect([...sel.paths]).toEqual(["c"]);
  });

  it("shift selects the range from the anchor, in either direction", () => {
    const anchored = clickRow(emptySelection(), rows, "b", plain);
    expect([...clickRow(anchored, rows, "d", { shift: true, toggle: false }).paths]).toEqual(["b", "c", "d"]);
    expect([...clickRow(anchored, rows, "a", { shift: true, toggle: false }).paths]).toEqual(["a", "b"]);
  });

  it("shift keeps the anchor so the range can be adjusted", () => {
    const anchored = clickRow(emptySelection(), rows, "b", plain);
    const wide = clickRow(anchored, rows, "e", { shift: true, toggle: false });
    const narrow = clickRow(wide, rows, "c", { shift: true, toggle: false });
    expect([...narrow.paths]).toEqual(["b", "c"]);
  });

  it("shift without an anchor behaves like a plain click", () => {
    expect([...clickRow(emptySelection(), rows, "c", { shift: true, toggle: false }).paths]).toEqual(["c"]);
  });
});

describe("selectAll", () => {
  it("selects every row", () => {
    expect(selectAll(rows).paths.size).toBe(5);
    expect(selectAll([]).anchor).toBeNull();
  });
});

describe("selectedTracks", () => {
  it("returns the selected tracks in list order, not click order", () => {
    const tracks = rows.map((p) => makeTrack({ path: p }));
    let sel = clickRow(emptySelection(), rows, "d", plain);
    sel = clickRow(sel, rows, "b", { shift: false, toggle: true });
    expect(selectedTracks(tracks, sel).map((t) => t.path)).toEqual(["b", "d"]);
  });
});

describe("pruneSelection", () => {
  it("drops rows that are no longer visible", () => {
    const sel = selectAll(rows);
    const pruned = pruneSelection(sel, ["a", "b"]);
    expect([...pruned.paths]).toEqual(["a", "b"]);
  });

  it("returns the same object when nothing changed", () => {
    const sel = selectAll(rows);
    expect(pruneSelection(sel, rows)).toBe(sel);
  });
});

describe("moveSelection", () => {
  const down = (sel = emptySelection(), extend = false) => moveSelection(sel, rows, 1, extend)!;
  const up = (sel = emptySelection(), extend = false) => moveSelection(sel, rows, -1, extend)!;

  it("with nothing selected, down picks the first row and up the last", () => {
    expect(down().index).toBe(0);
    expect(up().index).toBe(4);
  });

  it("moves a single selection one row at a time", () => {
    let result = down();
    result = down(result.selection);
    expect([...result.selection.paths]).toEqual(["b"]);
    result = up(result.selection);
    expect([...result.selection.paths]).toEqual(["a"]);
  });

  it("stops at the ends instead of wrapping", () => {
    const last = clickRow(emptySelection(), rows, "e", plain);
    expect(down(last).index).toBe(4);
    const first = clickRow(emptySelection(), rows, "a", plain);
    expect(up(first).index).toBe(0);
  });

  it("moves from the clicked row", () => {
    const clicked = clickRow(emptySelection(), rows, "c", plain);
    expect([...down(clicked).selection.paths]).toEqual(["d"]);
  });

  it("shift extends from the anchor and can shrink back", () => {
    const start = clickRow(emptySelection(), rows, "b", plain);
    const wider = down(down(start, true).selection, true);
    expect([...wider.selection.paths]).toEqual(["b", "c", "d"]);
    const narrower = up(wider.selection, true);
    expect([...narrower.selection.paths]).toEqual(["b", "c"]);
    expect(narrower.selection.anchor).toBe("b");
  });

  it("shift past the anchor flips the range to the other side", () => {
    const start = clickRow(emptySelection(), rows, "c", plain);
    const result = up(up(up(start, true).selection, true).selection, true);
    expect([...result.selection.paths]).toEqual(["a", "b", "c"]);
  });

  it("returns null when there are no rows", () => {
    expect(moveSelection(emptySelection(), [], 1, false)).toBeNull();
  });

  it("recovers when the focused row is gone", () => {
    const stale = { paths: new Set(["zzz"]), anchor: "zzz", focus: "zzz" };
    expect(moveSelection(stale, rows, 1, false)!.index).toBe(0);
  });
});
