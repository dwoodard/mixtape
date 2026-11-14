import { describe, expect, it } from "vitest";
import { moveInGrid, stepIndex } from "./gridNav";

// 10 items, 4 wide:
//  0  1  2  3
//  4  5  6  7
//  8  9
describe("moveInGrid", () => {
  const move = (i: number, key: Parameters<typeof moveInGrid>[1]) => moveInGrid(i, key, 4, 10);

  it("left and right step through items, crossing row ends", () => {
    expect(move(3, "ArrowRight")).toBe(4);
    expect(move(4, "ArrowLeft")).toBe(3);
  });

  it("stops at the first and last item", () => {
    expect(move(0, "ArrowLeft")).toBe(0);
    expect(move(9, "ArrowRight")).toBe(9);
  });

  it("up and down move by a row", () => {
    expect(move(5, "ArrowDown")).toBe(9);
    expect(move(5, "ArrowUp")).toBe(1);
  });

  it("up on the first row and down on the last row stay put", () => {
    expect(move(2, "ArrowUp")).toBe(2);
    expect(move(8, "ArrowDown")).toBe(8);
  });

  it("down from above a short last row lands on the last item", () => {
    expect(move(3, "ArrowDown")).toBe(7);
    expect(move(7, "ArrowDown")).toBe(9);
    expect(move(6, "ArrowDown")).toBe(9);
  });

  it("copes with one column, a bad column count and no items", () => {
    expect(moveInGrid(1, "ArrowDown", 1, 3)).toBe(2);
    expect(moveInGrid(1, "ArrowDown", 0, 3)).toBe(2);
    expect(moveInGrid(0, "ArrowRight", 4, 0)).toBe(-1);
  });
});

describe("stepIndex", () => {
  it("steps by one and stops at the ends", () => {
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(2, -1, 5)).toBe(1);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(0, -1, 5)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});
