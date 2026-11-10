// Cell addresses. Rows and columns are 0-based inside the engine and 1-based / lettered on screen.
// The limits match Excel, so a sheet here is the same size as a sheet there.

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384; // A … XFD

/** A cell packed into one number: row * MAX_COLS + col. Fits easily in a double (< 2^35). */
export type CellKey = number;

export const toKey = (row: number, col: number): CellKey => row * MAX_COLS + col;
export const rowOf = (key: CellKey): number => Math.floor(key / MAX_COLS);
export const colOf = (key: CellKey): number => key % MAX_COLS;

export interface Coord {
  row: number;
  col: number;
}

/** Inclusive, normalised (r1 <= r2, c1 <= c2). */
export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function colName(col: number): string {
  let name = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** 'A' → 0, 'XFD' → 16383. Returns -1 for anything that is not a column on the sheet. */
export function colIndex(name: string): number {
  if (name.length === 0 || name.length > 3) return -1;
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    const c = (name.charCodeAt(i) | 32) - 96; // case-insensitive a=1
    if (c < 1 || c > 26) return -1;
    n = n * 26 + c;
  }
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

export const addr = (row: number, col: number): string => colName(col) + (row + 1);
export const keyAddr = (key: CellKey): string => addr(rowOf(key), colOf(key));

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseAddress(text: string): Coord | null {
  const m = CELL_RE.exec(text.trim());
  if (!m) return null;
  const col = colIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col };
}

export function normalize(a: Coord, b: Coord): Range {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

/** 'B3', 'A1:C10' or a whole column 'C:E'. */
export function parseRange(text: string): Range | null {
  const parts = text.trim().split(':');
  if (parts.length === 1) {
    const a = parseAddress(parts[0]);
    return a && normalize(a, a);
  }
  if (parts.length !== 2) return null;
  const a = parseAddress(parts[0]);
  const b = parseAddress(parts[1]);
  if (a && b) return normalize(a, b);
  const ca = colIndex(parts[0].replace(/\$/g, ''));
  const cb = colIndex(parts[1].replace(/\$/g, ''));
  if (ca >= 0 && cb >= 0) return { r1: 0, c1: Math.min(ca, cb), r2: MAX_ROWS - 1, c2: Math.max(ca, cb) };
  return null;
}

export function rangeLabel(r: Range): string {
  if (r.r1 === 0 && r.r2 === MAX_ROWS - 1) return `${colName(r.c1)}:${colName(r.c2)}`;
  if (r.r1 === r.r2 && r.c1 === r.c2) return addr(r.r1, r.c1);
  return `${addr(r.r1, r.c1)}:${addr(r.r2, r.c2)}`;
}

export const rangeContains = (r: Range, row: number, col: number): boolean =>
  row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;

export const rangeArea = (r: Range): number => (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
