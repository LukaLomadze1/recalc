// The reference implementation the fuzzer compares the real engine against.
//
// It is deliberately simple and slow: no dependency graph, no range index, no incremental anything.
// Every call recomputes the whole sheet from the raw text, expands every range into the concrete cells
// it covers, finds cycles by asking "can this cell reach itself?", and evaluates by plain memoised
// recursion. If the fast engine and this one ever disagree, the fast engine is wrong.

import { colOf, rowOf, toKey, type CellKey, type Range } from './address.ts';
import { evaluate, type EvalContext } from './evaluate.ts';
import { parse, ParseError, precedents, type Expr } from './parser.ts';
import { MAX_FORMULA_LENGTH } from './sheet.ts';
import { CellError, parseLiteral, type Scalar } from './values.ts';

export function naiveValues(raws: ReadonlyMap<CellKey, string>): Map<CellKey, Scalar> {
  const keys = [...raws.keys()].sort((a, b) => a - b);
  const inRange = (r: Range): CellKey[] =>
    keys.filter((k) => rowOf(k) >= r.r1 && rowOf(k) <= r.r2 && colOf(k) >= r.c1 && colOf(k) <= r.c2);

  const exprs = new Map<CellKey, Expr>();
  const fixed = new Map<CellKey, Scalar>();
  for (const [k, raw] of raws) {
    if (raw.length > 1 && raw.startsWith('=')) {
      try {
        if (raw.length > MAX_FORMULA_LENGTH) throw new ParseError('too long', 0);
        exprs.set(k, parse(raw.slice(1)));
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        fixed.set(k, new CellError('#ERROR!', e.message));
      }
    } else fixed.set(k, parseLiteral(raw));
  }

  const reads = new Map<CellKey, CellKey[]>();
  for (const [k, e] of exprs) {
    const p = precedents(e);
    reads.set(k, [...p.cells.map((c) => toKey(c.row, c.col)), ...p.ranges.flatMap(inRange)]);
  }

  const reachesItself = (start: CellKey): boolean => {
    const seen = new Set<CellKey>();
    const todo = [...(reads.get(start) ?? [])];
    while (todo.length) {
      const k = todo.pop()!;
      if (k === start) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      todo.push(...(reads.get(k) ?? []));
    }
    return false;
  };

  let usedRows = 0;
  let usedCols = 0;
  for (const k of keys) {
    usedRows = Math.max(usedRows, rowOf(k) + 1);
    usedCols = Math.max(usedCols, colOf(k) + 1);
  }

  const memo = new Map<CellKey, Scalar>();
  const value = (k: CellKey): Scalar => {
    if (fixed.has(k)) return fixed.get(k)!;
    const e = exprs.get(k);
    if (!e) return null;
    if (memo.has(k)) return memo.get(k)!;
    let v: Scalar;
    if (reachesItself(k)) v = new CellError('#CYCLE!', 'cycle');
    else {
      const ctx: EvalContext = {
        row: rowOf(k),
        col: colOf(k),
        get: (row, col) => value(toKey(row, col)),
        forEachOccupied: (r, cb) => {
          for (const x of inRange(r)) if (cb(value(x), rowOf(x), colOf(x)) === true) return;
        },
        usedRows: () => usedRows,
        usedCols: () => usedCols,
      };
      v = evaluate(e, ctx);
    }
    memo.set(k, v);
    return v;
  };

  const out = new Map<CellKey, Scalar>();
  for (const k of keys) out.set(k, value(k));
  return out;
}
