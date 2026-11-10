// Where things are on screen. Pure functions, so the awkward parts (a million rows, and browsers that
// cannot make an element that tall) are unit-tested rather than eyeballed.

import { MAX_COLS, MAX_ROWS } from '../engine/address.ts';

export const ROW_H = 24;
export const HEADER_H = 26;
export const ROW_HEADER_W = 58;
export const DEFAULT_COL_W = 96;
export const MIN_COL_W = 28;

/** Firefox caps element height near 17.9 million px; 1,048,576 rows × 24 px is 25.2 million. */
export const MAX_SCROLL_PX = 12_000_000;
const ONE_TO_ONE_PX = 8_000_000;

export const SHEET_H = MAX_ROWS * ROW_H;

/** Column x-offsets as prefix sums: colX[c] is the left edge of column c, colX[MAX_COLS] the total width. */
export function columnOffsets(widths: ReadonlyMap<number, number>): Float64Array {
  const xs = new Float64Array(MAX_COLS + 1);
  for (let c = 0; c < MAX_COLS; c++) xs[c + 1] = xs[c] + (widths.get(c) ?? DEFAULT_COL_W);
  return xs;
}

/** The column containing x (in sheet pixels), by binary search. */
export function colAt(xs: Float64Array, x: number): number {
  let lo = 0;
  let hi = MAX_COLS - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const rowAt = (y: number): number => Math.max(0, Math.min(MAX_ROWS - 1, Math.floor(y / ROW_H)));

/**
 * The scrollbar can only be MAX_SCROLL_PX tall, but the sheet is taller. The first 8 million pixels
 * (about 333,000 rows) scroll one-to-one; beyond that the remaining rows are compressed into the rest
 * of the scrollbar. Wheel and trackpad scrolling feel normal where people actually work.
 */
export const SCROLL_H = Math.min(SHEET_H, MAX_SCROLL_PX);

export function scrollToSheetY(scrollTop: number, viewH: number): number {
  const total = SHEET_H - viewH;
  const track = Math.min(SHEET_H, MAX_SCROLL_PX) - viewH;
  if (track >= total || scrollTop <= ONE_TO_ONE_PX) return Math.max(0, Math.min(scrollTop, total));
  const t = (scrollTop - ONE_TO_ONE_PX) / (track - ONE_TO_ONE_PX);
  return ONE_TO_ONE_PX + Math.min(1, t) * (total - ONE_TO_ONE_PX);
}

export function sheetYToScroll(y: number, viewH: number): number {
  const total = SHEET_H - viewH;
  const track = Math.min(SHEET_H, MAX_SCROLL_PX) - viewH;
  const clamped = Math.max(0, Math.min(y, total));
  if (track >= total || clamped <= ONE_TO_ONE_PX) return clamped;
  return ONE_TO_ONE_PX + ((clamped - ONE_TO_ONE_PX) / (total - ONE_TO_ONE_PX)) * (track - ONE_TO_ONE_PX);
}

export interface Viewport {
  /** Sheet-pixel position of the top-left of the cell area. */
  x: number;
  y: number;
  /** Size of the cell area in CSS pixels (excluding headers). */
  w: number;
  h: number;
}

export interface Visible {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

export function visibleCells(xs: Float64Array, v: Viewport): Visible {
  return {
    r1: rowAt(v.y),
    r2: Math.min(MAX_ROWS - 1, rowAt(v.y + v.h)),
    c1: colAt(xs, v.x),
    c2: Math.min(MAX_COLS - 1, colAt(xs, v.x + v.w)),
  };
}

/** Screen rectangle (relative to the canvas, headers included) of a cell range. */
export function rectOf(xs: Float64Array, v: Viewport, r1: number, c1: number, r2: number, c2: number): { x: number; y: number; w: number; h: number } {
  const x = ROW_HEADER_W + xs[c1] - v.x;
  const y = HEADER_H + r1 * ROW_H - v.y;
  return { x, y, w: xs[c2 + 1] - xs[c1], h: (r2 - r1 + 1) * ROW_H };
}
