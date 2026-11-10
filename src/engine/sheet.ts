// The sheet: cell storage, the dependency graph, and incremental recalculation.
//
// When cells change, only the formulas downstream of them are recomputed. One pass of Tarjan's
// strongly-connected-components algorithm, started from the edited cells and following
// "is read by" edges, does three jobs at once:
//   1. it finds every formula that is downstream of the edit (and nothing else),
//   2. it emits them in reverse topological order, so reversing the output is a valid evaluation order,
//   3. any component with more than one cell, or a cell that reads itself, is a cycle.
// The traversal is iterative, so a chain of 100,000 running totals does not overflow the stack.

import { colOf, MAX_COLS, rowOf, toKey, keyAddr, type CellKey, type Range } from './address.ts';
import { evaluate, type EvalContext } from './evaluate.ts';
import { parse, ParseError, precedents, type Expr } from './parser.ts';
import { RangeIndex } from './rangeIndex.ts';
import { CellError, parseLiteral, type Scalar } from './values.ts';

export const MAX_FORMULA_LENGTH = 8192;

export interface Cell {
  raw: string;
  expr: Expr | null;
  parseError: ParseError | null;
  value: Scalar;
  refs: CellKey[];
  ranges: Range[];
}

export interface RecalcReport {
  /** The cells that were written. */
  edited: CellKey[];
  /** The formula cells that were recomputed, in the order they were evaluated. */
  order: CellKey[];
  /** Each circular reference found, as the list of cells in it. */
  cycles: CellKey[][];
  ms: number;
  /** Formulas on the sheet after the change, so the order length can be read as "x of y". */
  formulas: number;
}

const SMALL_AREA = 4096;

/**
 * Deliberate bugs, switched on only by the fuzzer's self-test to prove it can catch each one.
 * A fuzzer that has never failed has proven nothing.
 */
export type Bug =
  | 'ignore-ranges' // edits inside a range do not reach the formulas that read the range
  | 'wrong-order' // formulas are evaluated in the order Tarjan emits them, not reversed
  | 'self-loop' // a cell that reads itself is not reported as a cycle
  | 'lowlink' // Tarjan forgets to pass a child's low-link up to its parent, splitting cycles
  | 'first-bucket-only'; // a range is indexed only in the first 256-row bucket it touches

export const BUGS: readonly Bug[] = ['ignore-ranges', 'wrong-order', 'self-loop', 'lowlink', 'first-bucket-only'];

export class Sheet {
  private readonly cells = new Map<CellKey, Cell>();
  private readonly colRows = new Map<number, Set<number>>();
  /** precedent cell → formulas that reference it directly. */
  private readonly deps = new Map<CellKey, Set<CellKey>>();
  private readonly rangeIndex: RangeIndex;
  private readonly bug: Bug | null;
  private rowsUsed = 0;
  private colsUsed = 0;
  private formulas = 0;
  private edges = 0;

  constructor(bug: Bug | null = null) {
    this.bug = bug;
    this.rangeIndex = new RangeIndex(bug === 'first-bucket-only');
  }

  // ------------------------------------------------------------------------------------------
  // Reading

  get size(): number {
    return this.cells.size;
  }
  get formulaCount(): number {
    return this.formulas;
  }
  get usedRows(): number {
    return this.rowsUsed;
  }
  get usedCols(): number {
    return this.colsUsed;
  }

  cell(key: CellKey): Cell | undefined {
    return this.cells.get(key);
  }
  raw(key: CellKey): string {
    return this.cells.get(key)?.raw ?? '';
  }
  value(key: CellKey): Scalar {
    return this.cells.get(key)?.value ?? null;
  }
  valueAt(row: number, col: number): Scalar {
    return this.cells.get(row * MAX_COLS + col)?.value ?? null;
  }

  /** Every non-blank cell as [key, raw]. */
  *entries(): IterableIterator<[CellKey, string]> {
    for (const [k, c] of this.cells) yield [k, c.raw];
  }

  /** The non-blank cells in a range, row-major. Returning true from cb stops the walk. */
  forEachOccupied(r: Range, cb: (v: Scalar, row: number, col: number) => boolean | void): void {
    const r2 = Math.min(r.r2, this.rowsUsed - 1);
    const c2 = Math.min(r.c2, this.colsUsed - 1);
    if (r2 < r.r1 || c2 < r.c1) return;
    const area = (r2 - r.r1 + 1) * (c2 - r.c1 + 1);
    // Two strategies: walk every position (cheap per cell, wasted on blanks), or collect the occupied
    // cells from the column sets and sort them (cost per occupied cell, plus a sort). Walking wins
    // unless the range is mostly blank, so count how full the columns are before choosing.
    let occupied = 0;
    if (area > SMALL_AREA) for (let col = r.c1; col <= c2; col++) occupied += this.colRows.get(col)?.size ?? 0;
    if (area <= SMALL_AREA || area <= occupied * 4) {
      for (let row = r.r1; row <= r2; row++) {
        for (let col = r.c1; col <= c2; col++) {
          const cell = this.cells.get(row * MAX_COLS + col);
          if (cell && cb(cell.value, row, col) === true) return;
        }
      }
      return;
    }
    // Large range: collect from the per-column occupancy sets, then sort keys into row-major order.
    const keys: number[] = [];
    for (let col = r.c1; col <= c2; col++) {
      const rows = this.colRows.get(col);
      if (!rows) continue;
      for (const row of rows) if (row >= r.r1 && row <= r2) keys.push(row * MAX_COLS + col);
    }
    const sorted = Float64Array.from(keys).sort();
    for (const k of sorted) if (cb(this.cells.get(k)!.value, rowOf(k), colOf(k)) === true) return;
  }

  /** The cells and ranges a formula reads. */
  precedentsOf(key: CellKey): { refs: CellKey[]; ranges: Range[] } {
    const c = this.cells.get(key);
    return { refs: c?.refs ?? [], ranges: c?.ranges ?? [] };
  }

  /** The formulas that read this cell directly, through a reference or a range. */
  dependentsOf(key: CellKey): CellKey[] {
    const out = new Set<CellKey>();
    this.forEachDependent(key, (k) => out.add(k));
    return [...out];
  }

  /** How many formulas would recompute if this cell changed. */
  downstreamCount(key: CellKey, limit = 1_000_000): number {
    const seen = new Set<CellKey>();
    const stack = [key];
    while (stack.length && seen.size < limit) {
      const k = stack.pop()!;
      this.forEachDependent(k, (d) => {
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      });
    }
    return seen.size;
  }

  graphStats(): { cells: number; formulas: number; refEdges: number; ranges: number; rangeShapes: ReturnType<RangeIndex['stats']> } {
    return { cells: this.cells.size, formulas: this.formulas, refEdges: this.edges, ranges: this.rangeIndex.size, rangeShapes: this.rangeIndex.stats() };
  }

  // ------------------------------------------------------------------------------------------
  // Writing

  /** Writes cells ('' clears one) and recomputes everything downstream. */
  set(changes: Iterable<readonly [CellKey, string]>): RecalcReport {
    const t0 = performance.now();
    const edited: CellKey[] = [];
    for (const [key, raw] of changes) {
      const old = this.cells.get(key);
      if (old) this.unlink(key, old);
      if (raw === '') {
        this.cells.delete(key);
        const rows = this.colRows.get(colOf(key));
        rows?.delete(rowOf(key));
        if (rows && rows.size === 0) this.colRows.delete(colOf(key));
      } else {
        const cell = build(raw);
        this.cells.set(key, cell);
        this.link(key, cell);
        const row = rowOf(key);
        const col = colOf(key);
        let rows = this.colRows.get(col);
        if (!rows) this.colRows.set(col, (rows = new Set()));
        rows.add(row);
        if (row >= this.rowsUsed) this.rowsUsed = row + 1;
        if (col >= this.colsUsed) this.colsUsed = col + 1;
      }
      edited.push(key);
    }
    const { order, cycles } = this.recalc(edited);
    return { edited, order, cycles, ms: performance.now() - t0, formulas: this.formulas };
  }

  /** Replaces the whole sheet. */
  load(entries: Iterable<readonly [CellKey, string]>): RecalcReport {
    this.clear();
    return this.set(entries);
  }

  clear(): void {
    this.cells.clear();
    this.colRows.clear();
    this.deps.clear();
    this.rangeIndex.clear();
    this.rowsUsed = 0;
    this.colsUsed = 0;
    this.formulas = 0;
    this.edges = 0;
  }

  // ------------------------------------------------------------------------------------------
  // Internals

  private link(key: CellKey, cell: Cell): void {
    if (!cell.expr && !cell.parseError) return;
    this.formulas++;
    for (const p of cell.refs) {
      let s = this.deps.get(p);
      if (!s) this.deps.set(p, (s = new Set()));
      s.add(key);
      this.edges++;
    }
    for (const r of cell.ranges) this.rangeIndex.add(key, r);
  }

  private unlink(key: CellKey, cell: Cell): void {
    if (!cell.expr && !cell.parseError) return;
    this.formulas--;
    for (const p of cell.refs) {
      const s = this.deps.get(p);
      if (!s) continue;
      s.delete(key);
      this.edges--;
      if (s.size === 0) this.deps.delete(p);
    }
    if (cell.ranges.length) this.rangeIndex.removeOwner(key);
  }

  private forEachDependent(key: CellKey, cb: (k: CellKey) => void): void {
    const s = this.deps.get(key);
    if (s) for (const k of s) cb(k);
    if (this.bug !== 'ignore-ranges') this.rangeIndex.query(rowOf(key), colOf(key), cb);
  }

  private recalc(roots: CellKey[]): { order: CellKey[]; cycles: CellKey[][] } {
    // Iterative Tarjan. index/low are per-visit numbers; stack holds the current candidate component.
    const index = new Map<CellKey, number>();
    const low = new Map<CellKey, number>();
    const onStack = new Set<CellKey>();
    const selfLoop = new Set<CellKey>();
    const stack: CellKey[] = [];
    const emitted: CellKey[][] = [];
    let counter = 0;

    interface Frame {
      v: CellKey;
      next: CellKey[];
      i: number;
    }
    const neighbours = (v: CellKey): CellKey[] => {
      const out: CellKey[] = [];
      this.forEachDependent(v, (k) => out.push(k));
      return out;
    };
    const visit = (v: CellKey, frames: Frame[]): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      frames.push({ v, next: neighbours(v), i: 0 });
    };

    for (const root of roots) {
      if (index.has(root)) continue;
      const frames: Frame[] = [];
      visit(root, frames);
      while (frames.length) {
        const f = frames[frames.length - 1];
        if (f.i < f.next.length) {
          const w = f.next[f.i++];
          if (w === f.v && this.bug !== 'self-loop') selfLoop.add(w);
          if (!index.has(w)) visit(w, frames);
          else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
          continue;
        }
        frames.pop();
        if (low.get(f.v) === index.get(f.v)) {
          const comp: CellKey[] = [];
          let w: CellKey;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== f.v);
          emitted.push(comp);
        }
        if (frames.length && this.bug !== 'lowlink') {
          const parent = frames[frames.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(f.v)!));
        }
      }
    }

    // Tarjan emits a component only after everything downstream of it, so walk the list backwards.
    const order: CellKey[] = [];
    const cycles: CellKey[][] = [];
    const ctx: EvalContext = {
      row: 0,
      col: 0,
      get: (row, col) => this.cells.get(row * MAX_COLS + col)?.value ?? null,
      forEachOccupied: (r, cb) => this.forEachOccupied(r, cb),
      usedRows: () => this.rowsUsed,
      usedCols: () => this.colsUsed,
    };
    for (let n = 0; n < emitted.length; n++) {
      const comp = emitted[this.bug === 'wrong-order' ? n : emitted.length - 1 - n];
      if (comp.length > 1 || selfLoop.has(comp[0])) {
        const members = comp.slice().sort((a, b) => a - b);
        const names = members.slice(0, 6).map(keyAddr).join(', ') + (members.length > 6 ? `, and ${members.length - 6} more` : '');
        const err =
          members.length === 1
            ? new CellError('#CYCLE!', `${names} refers to itself.`, members)
            : new CellError('#CYCLE!', `Circular reference between ${members.length} cells: ${names}.`, members);
        for (const k of members) {
          const cell = this.cells.get(k);
          if (cell?.expr) {
            cell.value = err;
            order.push(k);
          }
        }
        cycles.push(members);
        continue;
      }
      const k = comp[0];
      const cell = this.cells.get(k);
      if (!cell?.expr) continue;
      ctx.row = rowOf(k);
      ctx.col = colOf(k);
      cell.value = evaluate(cell.expr, ctx);
      order.push(k);
    }
    return { order, cycles };
  }
}

function build(raw: string): Cell {
  if (raw.length > 1 && raw.startsWith('=')) {
    try {
      if (raw.length > MAX_FORMULA_LENGTH) throw new ParseError(`Formulas are limited to ${MAX_FORMULA_LENGTH} characters.`, 0);
      const expr = parse(raw.slice(1));
      const p = precedents(expr);
      return { raw, expr, parseError: null, value: null, refs: p.cells.map((c) => toKey(c.row, c.col)), ranges: p.ranges };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return { raw, expr: null, parseError: e, value: new CellError('#ERROR!', e.message), refs: [], ranges: [] };
    }
  }
  return { raw, expr: null, parseError: null, value: parseLiteral(raw), refs: [], ranges: [] };
}

