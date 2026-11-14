export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/**
 * Where an arrow key takes you in a grid of `count` items laid out `columns`
 * wide, reading left to right. Stays put at the edges. Pressing Down from a
 * row above a short last row lands on the last item rather than doing nothing.
 */
export function moveInGrid(index: number, key: GridKey, columns: number, count: number): number {
  if (count === 0) return -1;
  const cols = Math.max(1, columns);
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(last, index + 1);
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    case "ArrowDown": {
      if (index + cols <= last) return index + cols;
      const inLastRow = Math.floor(index / cols) === Math.floor(last / cols);
      return inLastRow ? index : last;
    }
  }
}

/** The index one step away in a list, clamped to its ends. -1 when the list is empty. */
export function stepIndex(index: number, delta: -1 | 1, count: number): number {
  if (count === 0) return -1;
  return Math.min(count - 1, Math.max(0, index + delta));
}
