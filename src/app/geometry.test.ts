import { describe, expect, it } from 'vitest';
import { MAX_COLS, MAX_ROWS } from '../engine/address.ts';
import { colAt, columnOffsets, DEFAULT_COL_W, MAX_SCROLL_PX, ROW_H, rowAt, scrollToSheetY, SHEET_H, sheetYToScroll } from './geometry.ts';

describe('columns', () => {
  it('finds the column under any x, with custom widths', () => {
    const xs = columnOffsets(new Map([[1, 200]]));
    expect(colAt(xs, 0)).toBe(0);
    expect(colAt(xs, DEFAULT_COL_W - 1)).toBe(0);
    expect(colAt(xs, DEFAULT_COL_W)).toBe(1);
    expect(colAt(xs, DEFAULT_COL_W + 199)).toBe(1);
    expect(colAt(xs, DEFAULT_COL_W + 200)).toBe(2);
    expect(colAt(xs, 1e12)).toBe(MAX_COLS - 1);
  });
});

describe('scrolling a million rows', () => {
  const viewH = 800;

  it('maps the scrollbar to the whole sheet, end to end', () => {
    const maxScroll = Math.min(SHEET_H, MAX_SCROLL_PX) - viewH;
    expect(scrollToSheetY(0, viewH)).toBe(0);
    expect(scrollToSheetY(maxScroll, viewH)).toBe(SHEET_H - viewH);
    expect(rowAt(scrollToSheetY(maxScroll, viewH) + viewH - 1)).toBe(MAX_ROWS - 1);
  });

  it('scrolls one-to-one through the first 300,000 rows', () => {
    for (const y of [0, 1000, 123_456, 7_999_999]) expect(scrollToSheetY(y, viewH)).toBe(y);
    expect(rowAt(300_000 * ROW_H)).toBe(300_000);
  });

  it('is invertible, so jumping to a cell lands on it', () => {
    for (const row of [0, 10, 333_000, 500_000, 1_000_000, MAX_ROWS - 40]) {
      const y = row * ROW_H;
      expect(Math.abs(scrollToSheetY(sheetYToScroll(y, viewH), viewH) - y)).toBeLessThan(1e-6 * SHEET_H);
    }
  });

  it('is monotonic', () => {
    let last = -1;
    for (let s = 0; s < MAX_SCROLL_PX; s += 97_003) {
      const y = scrollToSheetY(s, viewH);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
  });
});
