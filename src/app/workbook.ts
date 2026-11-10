// The document behind the UI: the sheet, column widths, undo/redo, and a version number React
// subscribes to. Every change goes through apply(), so every change can be undone.

import { addr, MAX_COLS, normalize, parseAddress, toKey, type CellKey, type Coord, type Range } from '../engine/address.ts';
import { Sheet, type RecalcReport } from '../engine/sheet.ts';
import { applyStructural, diff, type StructuralOp } from '../engine/transform.ts';
import { columnOffsets, DEFAULT_COL_W } from './geometry.ts';

export interface Selection {
  anchor: Coord;
  focus: Coord;
}
export const selRange = (s: Selection): Range => normalize(s.anchor, s.focus);
export const at = (row: number, col: number): Selection => ({ anchor: { row, col }, focus: { row, col } });

/** A sheet as stored in localStorage, in a share link, or in an example. Addresses keep it readable. */
export interface SheetDoc {
  name: string;
  cells: Array<[string, string]>;
  widths?: Array<[number, number]>;
}

interface HistoryEntry {
  label: string;
  changes: Array<[CellKey, string, string]>; // key, before, after
  widths?: { before: Array<[number, number]>; after: Array<[number, number]> };
  selBefore: Selection;
  selAfter: Selection;
}

export interface Change {
  kind: 'load' | 'edit';
  label: string;
  report: RecalcReport;
  selection: Selection;
}

const HISTORY_LIMIT = 200;

export class Workbook {
  readonly sheet = new Sheet();
  name = 'Untitled';
  widths = new Map<number, number>();
  xs = columnOffsets(this.widths);
  lastChange: Change | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get canUndo(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get canRedo(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  load(doc: SheetDoc): RecalcReport {
    const entries: Array<[CellKey, string]> = [];
    for (const [a, raw] of doc.cells) {
      const c = parseAddress(a);
      if (c && raw !== '') entries.push([toKey(c.row, c.col), raw]);
    }
    const report = this.sheet.load(entries);
    this.name = doc.name;
    this.widths = new Map(doc.widths ?? []);
    this.xs = columnOffsets(this.widths);
    this.undoStack = [];
    this.redoStack = [];
    this.lastChange = { kind: 'load', label: `Opening ${doc.name}`, report, selection: at(0, 0) };
    this.bump();
    return report;
  }

  toDoc(): SheetDoc {
    const cells: Array<[string, string]> = [];
    for (const [k, raw] of this.sheet.entries()) cells.push([addr(Math.floor(k / MAX_COLS), k % MAX_COLS), raw]);
    return { name: this.name, cells, widths: this.widths.size ? [...this.widths] : undefined };
  }

  /** Writes cells as one undoable step. Writes that change nothing are dropped. */
  apply(writes: Iterable<readonly [CellKey, string]>, label: string, selBefore: Selection, selAfter: Selection): Change | null {
    const last = new Map<CellKey, string>();
    for (const [k, raw] of writes) last.set(k, raw);
    const changes: Array<[CellKey, string, string]> = [];
    for (const [k, raw] of last) {
      const before = this.sheet.raw(k);
      if (before !== raw) changes.push([k, before, raw]);
    }
    if (changes.length === 0) return null;
    this.undoStack.push({ label, changes, selBefore, selAfter });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    return this.commit(changes.map(([k, , after]) => [k, after]), label, selAfter);
  }

  undo(): Change | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    if (e.widths) this.setWidths(e.widths.before);
    return this.commit(e.changes.map(([k, before]) => [k, before]), `Undo`, e.selBefore);
  }

  redo(): Change | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(e);
    if (e.widths) this.setWidths(e.widths.after);
    return this.commit(e.changes.map(([k, , after]) => [k, after]), `Redo`, e.selAfter);
  }

  /** Inserts or deletes rows or columns: moves cells, rewrites every formula, shifts column widths. */
  structural(op: StructuralOp, label: string, sel: Selection): Change | null {
    const before = new Map(this.sheet.entries());
    const after = applyStructural(before, op);
    const writes = diff(before, after);
    let widths: HistoryEntry['widths'];
    if (op.axis === 'col' && this.widths.size) {
      const old = [...this.widths];
      const moved: Array<[number, number]> = [];
      for (const [c, w] of old) {
        if (op.kind === 'insert') moved.push([c >= op.at ? c + op.count : c, w]);
        else if (c < op.at) moved.push([c, w]);
        else if (c >= op.at + op.count) moved.push([c - op.count, w]);
      }
      widths = { before: old, after: moved };
      this.setWidths(moved);
    }
    const changes: Array<[CellKey, string, string]> = writes.map(([k, raw]) => [k, before.get(k) ?? '', raw]);
    this.undoStack.push({ label, changes, widths, selBefore: sel, selAfter: sel });
    this.redoStack = [];
    return this.commit(writes, label, sel);
  }

  setWidth(col: number, w: number): void {
    if (w === DEFAULT_COL_W) this.widths.delete(col);
    else this.widths.set(col, Math.round(w));
    this.xs = columnOffsets(this.widths);
    this.bump();
  }

  private setWidths(list: Array<[number, number]>): void {
    this.widths = new Map(list);
    this.xs = columnOffsets(this.widths);
  }

  private commit(writes: Array<[CellKey, string]>, label: string, selection: Selection): Change {
    const report = this.sheet.set(writes);
    this.lastChange = { kind: 'edit', label, report, selection };
    this.bump();
    return this.lastChange;
  }
}
