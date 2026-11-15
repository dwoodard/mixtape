import { describe, expect, it } from "vitest";
import { finalIndex, insertionIndex, type RowBox } from "./reorder";

// Four rows 20px tall starting at y=100: 100-120, 120-140, 140-160, 160-180.
const rows: RowBox[] = [0, 1, 2, 3].map((i) => ({ top: 100 + i * 20, height: 20 }));

describe("insertionIndex", () => {
  it("inserts before a row when the pointer is in its top half, after when in the bottom half", () => {
    expect(insertionIndex(rows, 104)).toBe(0);
    expect(insertionIndex(rows, 111)).toBe(1);
    expect(insertionIndex(rows, 124)).toBe(1);
    expect(insertionIndex(rows, 131)).toBe(2);
  });

  it("goes to the very start above the list and the very end below it", () => {
    expect(insertionIndex(rows, 10)).toBe(0);
    expect(insertionIndex(rows, 500)).toBe(4);
  });

  it("handles an empty list", () => {
    expect(insertionIndex([], 50)).toBe(0);
  });
});

describe("finalIndex", () => {
  it("moving down lands one before the insertion point, because the row is lifted out first", () => {
    expect(finalIndex(0, 3)).toBe(2);
    expect(finalIndex(1, 4)).toBe(3);
  });

  it("moving up lands exactly at the insertion point", () => {
    expect(finalIndex(3, 1)).toBe(1);
    expect(finalIndex(2, 0)).toBe(0);
  });

  it("dropping where it already is changes nothing", () => {
    expect(finalIndex(2, 2)).toBeNull();
    expect(finalIndex(2, 3)).toBeNull();
    expect(finalIndex(0, 0)).toBeNull();
    expect(finalIndex(0, 1)).toBeNull();
  });
});
