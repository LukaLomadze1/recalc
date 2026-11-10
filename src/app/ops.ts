// Grid operations that turn a gesture into cell writes: clearing, the fill handle, copy and paste,
// and Ctrl+Arrow jumps. Pure functions of the sheet, so they are unit-tested without a browser.

import { MAX_COLS, MAX_ROWS, toKey, type CellKey, type Coord, type Range } from '../engine/address.ts';
import type { Sheet } from '../engine/sheet.ts';
import { shiftFormula } from '../engine/transform.ts';
import { displayValue, textToNumber } from '../engine/values.ts';

export function clearWrites(sheet: Sheet, r: Range): Array<[CellKey, string]> {
  const out: Array<[CellKey, string]> = [];
  sheet.forEachOccupied(r, (_v, row, col) => {
    out.push([toKey(row, col), '']);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fill handle

/**
 * Extends `source` to cover `target` (which contains it), the way dragging the fill handle does:
 * formulas are copied with their references shifted, two or more numbers continue as a series,
 * "Item 1" continues as "Item 2", and anything else repeats. With series off (Ctrl+D), it only copies.
 */
export function fillWrites(sheet: Sheet, source: Range, target: Range, series = true): Array<[CellKey, string]> {
  const out: Array<[CellKey, string]> = [];
  const vertical = target.c1 === source.c1 && target.c2 === source.c2;
  const lines = vertical ? source.c2 - source.c1 + 1 : source.r2 - source.r1 + 1;
  const n = vertical ? source.r2 - source.r1 + 1 : source.c2 - source.c1 + 1;
  for (let line = 0; line < lines; line++) {
    const raws: string[] = [];
    for (let k = 0; k < n; k++) raws.push(vertical ? sheet.raw(toKey(source.r1 + k, source.c1 + line)) : sheet.raw(toKey(source.r1 + line, source.c1 + k)));
    const next = series ? detectSeries(raws) : null;
    const from = vertical ? target.r1 - source.r1 : target.c1 - source.c1;
    const to = vertical ? target.r2 - source.r1 : target.c2 - source.c1;
    for (let t = from; t <= to; t++) {
      if (t >= 0 && t < n) continue;
      const k = ((t % n) + n) % n;
      const raw = next ? next(t) : shiftFormula(raws[k], vertical ? t - k : 0, vertical ? 0 : t - k);
      const row = vertical ? source.r1 + t : source.r1 + line;
      const col = vertical ? source.c1 + line : source.c1 + t;
      out.push([toKey(row, col), raw]);
    }
  }
  return out;
}

function detectSeries(raws: string[]): ((t: number) => string) | null {
  const nums = raws.map((r) => (r === '' || r.startsWith('=') ? null : textToNumber(r)));
  if (raws.length >= 2 && nums.every((x) => x !== null)) {
    const xs = nums as number[];
    const step = xs[1] - xs[0];
    if (xs.every((x, i) => i === 0 || Math.abs(x - xs[i - 1] - step) < 1e-9 * Math.max(1, Math.abs(step)))) {
      return (t) => String(Number((xs[0] + step * t).toPrecision(15)));
    }
    return null;
  }
  if (raws.length === 1) {
    const m = /^(.*?)(\d+)$/.exec(raws[0]);
    if (m && m[1] !== '' && !raws[0].startsWith('=') && textToNumber(raws[0]) === null) {
      const base = Number(m[2]);
      const width = m[2].length;
      return (t) => m[1] + String(Math.max(0, base + t)).padStart(m[2].startsWith('0') ? width : 0, '0');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Clipboard

export interface Clip {
  r: Range;
  raws: string[][];
  /** What went to the system clipboard; a paste of exactly this text is a paste of this clip. */
  text: string;
  cut: boolean;
}

export function copyClip(sheet: Sheet, r: Range, cut: boolean): Clip {
  const raws: string[][] = [];
  const lines: string[] = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const rr: string[] = [];
    const vals: string[] = [];
    for (let col = r.c1; col <= r.c2; col++) {
      rr.push(sheet.raw(toKey(row, col)));
      vals.push(displayValue(sheet.valueAt(row, col)).replace(/[\t\r\n]/g, ' '));
    }
    raws.push(rr);
    lines.push(vals.join('\t'));
  }
  return { r, raws, text: lines.join('\n'), cut };
}

export const MAX_CLIP_CELLS = 200_000;

/** Parses tab-separated text from another program (Excel, Sheets, a web table). */
export function parseClipboardText(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

/**
 * The writes for pasting a block at `dest`. If the selection is an exact multiple of the block, the
 * block is tiled across it, as in Excel. Copied formulas are shifted; cut formulas are moved as-is.
 */
export function pasteWrites(block: string[][], dest: Range, origin: Coord | null, shift: boolean): { writes: Array<[CellKey, string]>; area: Range } {
  const h = block.length;
  const w = Math.max(...block.map((r) => r.length));
  const selH = dest.r2 - dest.r1 + 1;
  const selW = dest.c2 - dest.c1 + 1;
  const tileR = selH % h === 0 && selH > h ? selH / h : 1;
  const tileC = selW % w === 0 && selW > w ? selW / w : 1;
  const writes: Array<[CellKey, string]> = [];
  for (let tr = 0; tr < tileR; tr++)
    for (let tc = 0; tc < tileC; tc++)
      for (let i = 0; i < h; i++)
        for (let j = 0; j < w; j++) {
          const row = dest.r1 + tr * h + i;
          const col = dest.c1 + tc * w + j;
          if (row >= MAX_ROWS || col >= MAX_COLS) continue;
          const raw = block[i][j] ?? '';
          const moved = origin && shift ? shiftFormula(raw, row - (origin.row + i), col - (origin.col + j)) : raw;
          writes.push([toKey(row, col), moved]);
        }
  return {
    writes,
    area: { r1: dest.r1, c1: dest.c1, r2: Math.min(MAX_ROWS - 1, dest.r1 + h * tileR - 1), c2: Math.min(MAX_COLS - 1, dest.c1 + w * tileC - 1) },
  };
}

// ---------------------------------------------------------------------------------------------
// Navigation

/** Ctrl+Arrow: to the edge of the current block of data, or to the next non-blank cell, or to the sheet edge. */
export function jump(sheet: Sheet, from: Coord, dr: number, dc: number): Coord {
  const filled = (r: number, c: number): boolean => sheet.cell(toKey(r, c)) !== undefined;
  const inside = (r: number, c: number): boolean => r >= 0 && r < MAX_ROWS && c >= 0 && c < MAX_COLS;
  let r = from.row;
  let c = from.col;
  if (!inside(r + dr, c + dc)) return from;
  if (filled(r, c) && filled(r + dr, c + dc)) {
    while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
      r += dr;
      c += dc;
    }
    return { row: r, col: c };
  }
  for (;;) {
    r += dr;
    c += dc;
    if (!inside(r, c)) return { row: r - dr, col: c - dc };
    if (filled(r, c)) return { row: r, col: c };
    // Past the used area there is nothing more to find: go straight to the edge.
    if ((dr > 0 && r >= sheet.usedRows) || (dc > 0 && c >= sheet.usedCols)) return { row: dr > 0 ? MAX_ROWS - 1 : r, col: dc > 0 ? MAX_COLS - 1 : c };
  }
}

export interface Stats {
  count: number;
  numbers: number;
  sum: number;
  min: number;
  max: number;
}

export function selectionStats(sheet: Sheet, r: Range): Stats {
  const s: Stats = { count: 0, numbers: 0, sum: 0, min: Infinity, max: -Infinity };
  sheet.forEachOccupied(r, (v) => {
    s.count++;
    if (typeof v === 'number') {
      s.numbers++;
      s.sum += v;
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
    }
  });
  return s;
}
