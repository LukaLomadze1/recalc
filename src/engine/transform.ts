// Rewriting references inside formula text: shifting relative references when a formula is copied,
// and moving every reference when rows or columns are inserted or deleted. Works on the token
// stream, so spacing, case and everything that is not a reference stay exactly as the user typed it.

import { colName, colOf, MAX_COLS, MAX_ROWS, rowOf, toKey, type CellKey } from './address.ts';
import { lex, type ColRangeParts, type RefParts } from './lexer.ts';

interface Rewriter {
  ref(r: RefParts): RefParts | null;
  range(a: RefParts, b: RefParts): [RefParts, RefParts] | null;
  cols(c: ColRangeParts): ColRangeParts | null;
}

const fmtRef = (r: RefParts): string => `${r.colAbs ? '$' : ''}${colName(r.col)}${r.rowAbs ? '$' : ''}${r.row + 1}`;
const fmtCols = (c: ColRangeParts): string => `${c.c1Abs ? '$' : ''}${colName(c.c1)}:${c.c2Abs ? '$' : ''}${colName(c.c2)}`;

export function rewrite(raw: string, w: Rewriter): string {
  if (raw.length < 2 || !raw.startsWith('=')) return raw;
  const body = raw.slice(1);
  const toks = lex(body);
  let out = '';
  let last = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'ref') {
      const colon = toks[i + 1];
      const end = toks[i + 2];
      if (colon?.t === ':' && end?.t === 'ref') {
        const res = w.range(t.v, end.v);
        out += body.slice(last, t.start) + (res ? `${fmtRef(res[0])}:${fmtRef(res[1])}` : '#REF!');
        last = end.end;
        i += 2;
        continue;
      }
      const res = w.ref(t.v);
      out += body.slice(last, t.start) + (res ? fmtRef(res) : '#REF!');
      last = t.end;
    } else if (t.t === 'cols') {
      const res = w.cols(t.v);
      out += body.slice(last, t.start) + (res ? fmtCols(res) : '#REF!');
      last = t.end;
    }
  }
  return '=' + out + body.slice(last);
}

const inRows = (r: number): boolean => r >= 0 && r < MAX_ROWS;
const inCols = (c: number): boolean => c >= 0 && c < MAX_COLS;

/** The formula as it should read after being copied dr rows down and dc columns right. */
export function shiftFormula(raw: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return raw;
  const ref = (r: RefParts): RefParts | null => {
    const row = r.rowAbs ? r.row : r.row + dr;
    const col = r.colAbs ? r.col : r.col + dc;
    return inRows(row) && inCols(col) ? { ...r, row, col } : null;
  };
  return rewrite(raw, {
    ref,
    range: (a, b) => {
      const x = ref(a);
      const y = ref(b);
      return x && y ? [x, y] : null;
    },
    cols: (c) => {
      const c1 = c.c1Abs ? c.c1 : c.c1 + dc;
      const c2 = c.c2Abs ? c.c2 : c.c2 + dc;
      return inCols(c1) && inCols(c2) ? { ...c, c1, c2 } : null;
    },
  });
}

export interface StructuralOp {
  kind: 'insert' | 'delete';
  axis: 'row' | 'col';
  at: number;
  count: number;
}

/** Where a single row/column index goes, or null if it was deleted or pushed off the sheet. */
function moveIndex(i: number, op: StructuralOp, limit: number): number | null {
  if (op.kind === 'insert') {
    if (i < op.at) return i;
    return i + op.count < limit ? i + op.count : null;
  }
  const end = op.at + op.count - 1;
  if (i < op.at) return i;
  if (i > end) return i - op.count;
  return null;
}

/** Where a span [lo, hi] goes. Deleting part of a span shrinks it; inserting inside it grows it. */
function moveSpan(lo: number, hi: number, op: StructuralOp, limit: number): [number, number] | null {
  if (op.kind === 'insert') {
    const nlo = lo >= op.at ? lo + op.count : lo;
    const nhi = hi >= op.at ? Math.min(hi + op.count, limit - 1) : hi;
    if (nlo >= limit) return null;
    return [nlo, nhi];
  }
  const end = op.at + op.count - 1;
  if (lo >= op.at && hi <= end) return null;
  const nlo = lo < op.at ? lo : lo > end ? lo - op.count : op.at;
  const nhi = hi < op.at ? hi : hi > end ? hi - op.count : op.at - 1;
  return nhi < nlo ? null : [nlo, nhi];
}

/** Rewrites a formula for a row/column insert or delete. Absolute references move too, as in Excel. */
export function structuralFormula(raw: string, op: StructuralOp): string {
  const rows = op.axis === 'row';
  const limit = rows ? MAX_ROWS : MAX_COLS;
  return rewrite(raw, {
    ref: (r) => {
      const i = moveIndex(rows ? r.row : r.col, op, limit);
      if (i === null) return null;
      return rows ? { ...r, row: i } : { ...r, col: i };
    },
    range: (a, b) => {
      const ka = rows ? a.row : a.col;
      const kb = rows ? b.row : b.col;
      const span = moveSpan(Math.min(ka, kb), Math.max(ka, kb), op, limit);
      if (!span) return null;
      const [lo, hi] = ka <= kb ? span : [span[1], span[0]];
      return rows ? [{ ...a, row: lo }, { ...b, row: hi }] : [{ ...a, col: lo }, { ...b, col: hi }];
    },
    cols: (c) => {
      if (rows) return c;
      const span = moveSpan(Math.min(c.c1, c.c2), Math.max(c.c1, c.c2), op, limit);
      if (!span) return null;
      return c.c1 <= c.c2 ? { ...c, c1: span[0], c2: span[1] } : { ...c, c1: span[1], c2: span[0] };
    },
  });
}

/** The whole sheet's contents after a structural change: cells move and every formula is rewritten. */
export function applyStructural(entries: Iterable<readonly [CellKey, string]>, op: StructuralOp): Map<CellKey, string> {
  const out = new Map<CellKey, string>();
  const rows = op.axis === 'row';
  for (const [k, raw] of entries) {
    const row = rowOf(k);
    const col = colOf(k);
    const moved = moveIndex(rows ? row : col, op, rows ? MAX_ROWS : MAX_COLS);
    if (moved === null) continue;
    out.set(rows ? toKey(moved, col) : toKey(row, moved), structuralFormula(raw, op));
  }
  return out;
}

/** The writes that turn `before` into `after`, with '' for cells that become blank. */
export function diff(before: ReadonlyMap<CellKey, string>, after: ReadonlyMap<CellKey, string>): Array<[CellKey, string]> {
  const out: Array<[CellKey, string]> = [];
  for (const [k, raw] of after) if (before.get(k) !== raw) out.push([k, raw]);
  for (const k of before.keys()) if (!after.has(k)) out.push([k, '']);
  return out;
}
