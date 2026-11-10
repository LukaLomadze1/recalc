// Random sheets and random edit sequences. After every edit, every value the incremental engine holds
// is compared with what the naive evaluator computes from scratch.
//
// The cells live on a sparse grid of hand-picked coordinates rather than a dense block: rows 255/256
// straddle a range-index bucket boundary, and row 20000 / column BS make ranges tall or wide enough
// to land in the other two parts of the index. A dense 6×5 block would never leave bucket 0.

import { addr, colName, toKey, type CellKey } from './address.ts';
import { naiveValues } from './naive.ts';
import { Rng } from './rng.ts';
import { Sheet, type Bug } from './sheet.ts';
import { applyStructural, diff, type StructuralOp } from './transform.ts';
import { displayValue, isError, type Scalar } from './values.ts';

const ROWS = [0, 1, 2, 255, 256, 20000];
const COLS = [0, 1, 2, 70];
const CRITERIA = ['">2"', '"a*"', '"<>"', '""', '1', '"TRUE"', '"<=b"'];
const STRINGS = ['"a"', '"B"', '"ab"', '""', '"1"'];

class FormulaGen {
  private readonly rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }

  ref(): string {
    const r = this.rng;
    const s = `${r.chance(0.2) ? '$' : ''}${colName(r.pick(COLS))}${r.chance(0.2) ? '$' : ''}${r.pick(ROWS) + 1}`;
    return s;
  }

  range(): string {
    const r = this.rng;
    if (r.chance(0.12)) {
      const a = colName(r.pick(COLS));
      const b = colName(r.pick(COLS));
      return `${a}:${b}`;
    }
    return `${this.ref()}:${this.ref()}`;
  }

  /** A single row or column segment, for MATCH and XLOOKUP. */
  line(): [string, string] {
    const r = this.rng;
    const a = r.pick(ROWS);
    const b = r.pick(ROWS);
    const c1 = colName(r.pick(COLS));
    const c2 = colName(r.pick(COLS));
    return [`${c1}${Math.min(a, b) + 1}:${c1}${Math.max(a, b) + 1}`, `${c2}${Math.min(a, b) + 1}:${c2}${Math.max(a, b) + 1}`];
  }

  expr(depth: number): string {
    const r = this.rng;
    if (depth <= 0 || r.chance(0.3)) {
      const k = r.int(0, 9);
      if (k < 4) return this.ref();
      if (k < 7) return String(r.chance(0.8) ? r.int(0, 9) : r.int(-5, 50) / 4);
      if (k < 8) return r.pick(STRINGS);
      return r.chance(0.5) ? 'TRUE' : 'FALSE';
    }
    const d = depth - 1;
    switch (r.int(0, 21)) {
      case 0:
      case 1:
      case 2:
        return `${this.expr(d)}${r.pick(['+', '-', '*', '/', '^', '&', '=', '<', '>', '<>', '<=', '>='])}${this.expr(d)}`;
      case 3:
        return `-${this.expr(d)}`;
      case 4:
        return `(${this.expr(d)})%`;
      case 5:
        return `${r.pick(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'PRODUCT'])}(${this.args(d)})`;
      case 6:
        return `IF(${this.expr(d)},${this.expr(d)},${this.expr(d)})`;
      case 7:
        return `IFERROR(${this.expr(d)},${this.expr(d)})`;
      case 8:
        return `${r.pick(['AND', 'OR'])}(${this.args(d)})`;
      case 9:
        return `CONCAT(${this.args(d)})`;
      case 10:
        return `${r.pick(['LEN', 'ABS', 'NOT', 'ISBLANK', 'ISNUMBER'])}(${this.expr(d)})`;
      case 11:
        return `ROUND(${this.expr(d)},${r.int(-1, 2)})`;
      case 12:
        return `MOD(${this.expr(d)},${this.expr(d)})`;
      case 13:
        return `VLOOKUP(${this.expr(d)},${this.range()},${r.int(1, 2)},${r.chance(0.5) ? 'TRUE' : 'FALSE'})`;
      case 14:
        return `INDEX(${this.range()},${r.int(1, 3)},${r.int(1, 2)})`;
      case 15:
        return `MATCH(${this.expr(d)},${this.line()[0]},${r.pick([-1, 0, 1])})`;
      case 16:
        return `SUMIF(${this.range()},${r.pick(CRITERIA)}${r.chance(0.5) ? ',' + this.range() : ''})`;
      case 17:
        return `COUNTIF(${this.range()},${r.pick(CRITERIA)})`;
      case 18:
        return r.chance(0.5) ? `ROW()+COLUMN()` : `ROW(${this.ref()})`;
      case 19:
        return `TEXTJOIN(",",${r.chance(0.5) ? 'TRUE' : 'FALSE'},${this.line()[0]})`;
      case 20: {
        const [a, b] = this.line();
        return `XLOOKUP(${this.expr(d)},${a},${b},"none",${r.pick([0, -1, 1])})`;
      }
      default: {
        const [a, b] = this.line();
        return `SUMPRODUCT(${a},${b})`;
      }
    }
  }

  private args(depth: number): string {
    const n = this.rng.int(1, 3);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.rng.chance(0.5) ? this.range() : this.expr(depth));
    return out.join(',');
  }

  content(): string {
    const r = this.rng;
    const k = r.next();
    if (k < 0.12) return '';
    if (k < 0.32) return r.pick(['0', '1', '2', '3', '-1', '2.5', 'a', 'B', 'ab', 'TRUE', 'FALSE']);
    if (k < 0.34) return '=1+'; // a parse error now and then
    return '=' + this.expr(r.int(1, 3));
  }
}

export interface FuzzFailure {
  seed: number;
  step: number;
  cell: string;
  expected: string;
  actual: string;
  /** The edits that led here, replayable by hand. */
  log: string[];
  /** The sheet's contents at the moment of failure. */
  cells: Record<string, string>;
}

const same = (a: Scalar, b: Scalar): boolean => {
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.code === b.code;
  return a === b;
};

/** Runs one random case. Returns null if the engine agreed with the reference at every step. */
export function runCase(seed: number, steps = 30, bug: Bug | null = null): FuzzFailure | null {
  const rng = new Rng(seed);
  const gen = new FormulaGen(rng);
  const sheet = new Sheet(bug);
  const model = new Map<CellKey, string>();
  const log: string[] = [];
  const cells: CellKey[] = [];
  for (const row of ROWS) for (const col of COLS) cells.push(toKey(row, col));

  const write = (changes: Array<[CellKey, string]>, label: string): void => {
    for (const [k, raw] of changes) {
      if (raw === '') model.delete(k);
      else model.set(k, raw);
    }
    sheet.set(changes);
    log.push(label);
  };

  // An initial batch, like opening a file.
  const initial: Array<[CellKey, string]> = [];
  for (const k of cells) if (rng.chance(0.6)) initial.push([k, gen.content()]);
  write(initial, `load ${initial.length} cells`);

  for (let step = 0; step <= steps; step++) {
    if (step > 0) {
      const kind = rng.next();
      if (kind < 0.75) {
        const k = rng.pick(cells);
        const raw = gen.content();
        write([[k, raw]], `${addrOf(k)} ← ${raw === '' ? '(clear)' : raw}`);
      } else if (kind < 0.92) {
        const batch: Array<[CellKey, string]> = [];
        for (let i = rng.int(2, 4); i > 0; i--) batch.push([rng.pick(cells), gen.content()]);
        write(batch, `paste ${batch.map(([k, r]) => `${addrOf(k)}=${r || '(clear)'}`).join('; ')}`);
      } else {
        const op: StructuralOp = {
          kind: rng.chance(0.5) ? 'insert' : 'delete',
          axis: rng.chance(0.6) ? 'row' : 'col',
          at: 0,
          count: 1,
        };
        op.at = op.axis === 'row' ? rng.pick(ROWS) : rng.pick(COLS);
        const after = applyStructural(model, op);
        // The grid of interesting coordinates is fixed, so only keep cells that are still on it.
        for (const k of [...after.keys()]) if (!cells.includes(k)) after.delete(k);
        write(diff(model, after), `${op.kind} ${op.axis} at ${op.axis === 'row' ? op.at + 1 : colName(op.at)}`);
      }
    }
    const expected = naiveValues(model);
    for (const k of cells) {
      const want = expected.get(k) ?? null;
      const got = sheet.value(k);
      if (!same(want, got)) {
        const snapshot = Object.fromEntries([...model].sort((a, b) => a[0] - b[0]).map(([key, raw]) => [addrOf(key), raw]));
        return { seed, step, cell: addrOf(k), expected: displayValue(want), actual: displayValue(got), log, cells: snapshot };
      }
    }
  }
  return null;
}

const addrOf = (k: CellKey): string => addr(Math.floor(k / 16384), k % 16384);
