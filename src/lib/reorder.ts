export interface RowBox {
  top: number;
  height: number;
}

/**
 * Where a dragged row would be inserted if dropped with the pointer at `y`:
 * 0 means before the first row, `rows.length` means after the last. A row is
 * split at its middle, so the pointer in a row's top half inserts before it.
 */
export function insertionIndex(rows: RowBox[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    if (y < rows[i].top + rows[i].height / 2) return i;
  }
  return rows.length;
}

/**
 * The index a moved row ends up at, given the insertion point from
 * `insertionIndex` (counted before the row is lifted out), or null when
 * dropping there would not change the order.
 */
export function finalIndex(from: number, insertAt: number): number | null {
  const to = insertAt > from ? insertAt - 1 : insertAt;
  return to === from ? null : to;
}
