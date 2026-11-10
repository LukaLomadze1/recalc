// Answers "which formulas read a range that contains this cell?" without scanning every range.
//
// A formula like =SUM(A1:A5000) depends on 5,000 cells. Storing 5,000 edges per formula would make
// a sheet of running totals quadratic, so ranges are stored once, in one of three places depending on
// their shape:
//   small ranges   → spatial buckets of 256 rows × 1 column, looked up by the cell's bucket
//   tall ranges    → a list per column (A:A, or A1:B100000), filtered by row on lookup
//   wide ranges    → one list, filtered on lookup (rare: more than 64 columns and many rows)

import { MAX_COLS, type CellKey, type Range } from './address.ts';

const BLOCK_SHIFT = 8; // 256 rows per bucket
const MAX_BUCKETS_PER_RANGE = 64;
const MAX_TALL_COLUMNS = 64;

interface Entry {
  owner: CellKey;
  r: Range;
}

export class RangeIndex {
  private readonly buckets = new Map<number, Set<Entry>>();
  private readonly tall = new Map<number, Set<Entry>>();
  private readonly wide = new Set<Entry>();
  private readonly byOwner = new Map<CellKey, Entry[]>();
  private count = 0;
  private readonly firstBucketOnly: boolean;

  constructor(firstBucketOnly = false) {
    this.firstBucketOnly = firstBucketOnly;
  }

  get size(): number {
    return this.count;
  }

  add(owner: CellKey, r: Range): void {
    const e: Entry = { owner, r };
    this.place(e, true);
    let list = this.byOwner.get(owner);
    if (!list) this.byOwner.set(owner, (list = []));
    list.push(e);
    this.count++;
  }

  clear(): void {
    this.buckets.clear();
    this.tall.clear();
    this.wide.clear();
    this.byOwner.clear();
    this.count = 0;
  }

  removeOwner(owner: CellKey): void {
    const list = this.byOwner.get(owner);
    if (!list) return;
    for (const e of list) this.place(e, false);
    this.count -= list.length;
    this.byOwner.delete(owner);
  }

  /** Calls cb with the owner of every range containing (row, col). An owner may repeat if it has several such ranges. */
  query(row: number, col: number, cb: (owner: CellKey) => void): void {
    const b = this.buckets.get((row >> BLOCK_SHIFT) * MAX_COLS + col);
    if (b) for (const e of b) if (contains(e.r, row, col)) cb(e.owner);
    const t = this.tall.get(col);
    if (t) for (const e of t) if (e.r.r1 <= row && row <= e.r.r2) cb(e.owner);
    for (const e of this.wide) if (contains(e.r, row, col)) cb(e.owner);
  }

  /** How the ranges are distributed, for the inspector. */
  stats(): { bucketed: number; tall: number; wide: number } {
    let bucketed = 0;
    let tall = 0;
    for (const list of this.byOwner.values()) {
      for (const e of list) {
        const kind = shape(e.r);
        if (kind === 'bucket') bucketed++;
        else if (kind === 'tall') tall++;
      }
    }
    return { bucketed, tall, wide: this.wide.size };
  }

  private place(e: Entry, add: boolean): void {
    const { r } = e;
    const kind = shape(r);
    if (kind === 'bucket') {
      const last = this.firstBucketOnly ? r.r1 >> BLOCK_SHIFT : r.r2 >> BLOCK_SHIFT;
      for (let b = r.r1 >> BLOCK_SHIFT; b <= last; b++)
        for (let c = r.c1; c <= r.c2; c++) toggle(this.buckets, b * MAX_COLS + c, e, add);
    } else if (kind === 'tall') {
      for (let c = r.c1; c <= r.c2; c++) toggle(this.tall, c, e, add);
    } else if (add) this.wide.add(e);
    else this.wide.delete(e);
  }
}

function shape(r: Range): 'bucket' | 'tall' | 'wide' {
  const cols = r.c2 - r.c1 + 1;
  const blocks = (r.r2 >> BLOCK_SHIFT) - (r.r1 >> BLOCK_SHIFT) + 1;
  if (cols * blocks <= MAX_BUCKETS_PER_RANGE) return 'bucket';
  if (cols <= MAX_TALL_COLUMNS) return 'tall';
  return 'wide';
}

function toggle(map: Map<number, Set<Entry>>, k: number, e: Entry, add: boolean): void {
  let set = map.get(k);
  if (add) {
    if (!set) map.set(k, (set = new Set()));
    set.add(e);
  } else if (set) {
    set.delete(e);
    if (set.size === 0) map.delete(k);
  }
}

const contains = (r: Range, row: number, col: number): boolean => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
