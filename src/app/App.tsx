import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { addr, colName, MAX_COLS, MAX_ROWS, normalize, parseAddress, parseRange, rangeLabel, toKey, type Coord, type Range } from '../engine/address.ts';
import { parseCSV, toCSV } from '../engine/csv.ts';
import { FUNCTION_LIST, type FnDef } from '../engine/functions.ts';
import type { RecalcReport } from '../engine/sheet.ts';
import type { StructuralOp } from '../engine/transform.ts';
import { displayValue } from '../engine/values.ts';
import { Assist } from './Assist.tsx';
import { ContextMenu, Help, StatusBar, Toast, Toolbar, type ContextItem } from './Chrome.tsx';
import { FormulaInput } from './FormulaInput.tsx';
import { activeCall, autoClose, canInsertRef, completionAt, highlight } from './formulaTokens.ts';
import { Grid, type GridHandle, type HeaderKind } from './Grid.tsx';
import { Inspector } from './Inspector.tsx';
import { clearWrites, copyClip, fillWrites, jump, MAX_CLIP_CELLS, parseClipboardText, pasteWrites, selectionStats, type Clip } from './ops.ts';
import { resetMeasureCache, type Arrows, type Ripple } from './render.ts';
import { EXAMPLES, type Example } from './samples.ts';
import { decodeDoc, encodeDoc, HASH_KEY, readHash } from './share.ts';
import { at, selRange, Workbook, type Change, type Selection, type SheetDoc } from './workbook.ts';

interface Editing {
  row: number;
  col: number;
  text: string;
  caret: number;
  /** 'enter': typed straight into a cell, arrows commit. 'edit': F2 or double-click, arrows move the caret. */
  mode: 'enter' | 'edit';
  source: 'cell' | 'bar';
  /** The reference inserted by clicking a cell while writing a formula, so a second click replaces it. */
  point: { start: number; end: number; anchor: Coord } | null;
}

const SAVE_KEY = 'recalc:sheet:v1';
const THEME_KEY = 'recalc:theme';
const SAVE_LIMIT = 40_000;
const SHARE_LIMIT = 6_000;
const CHAR_W = 7.6;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or quota: the sheet simply is not remembered.
  }
}

const clampCoord = (row: number, col: number): Coord => ({
  row: Math.max(0, Math.min(MAX_ROWS - 1, row)),
  col: Math.max(0, Math.min(MAX_COLS - 1, col)),
});
const plural = (n: number, word: string): string => `${new Intl.NumberFormat('en-US').format(n)} ${word}${n === 1 ? '' : 's'}`;
const fmtMs = (x: number): string => (x < 1 ? `${x.toFixed(2)} ms` : x < 100 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const isFullCols = (r: Range): boolean => r.r1 === 0 && r.r2 === MAX_ROWS - 1;
const isFullRows = (r: Range): boolean => r.c1 === 0 && r.c2 === MAX_COLS - 1;

function initialDark(): boolean {
  const saved = storageGet(THEME_KEY);
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function App() {
  const wb = useMemo(() => new Workbook(), []);
  const version = useSyncExternalStore(wb.subscribe, wb.getVersion);
  const gridRef = useRef<GridHandle>(null);
  const cellInputRef = useRef<HTMLInputElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rippleRef = useRef<Ripple | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const [sel, setSel] = useState<Selection>(at(0, 0));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [xray, setXray] = useState(true);
  const [clip, setClip] = useState<Clip | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [help, setHelp] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [dark, setDark] = useState(initialDark);
  const [themeVersion, setThemeVersion] = useState(0);
  const [assistIndex, setAssistIndex] = useState(0);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const live = useRef({ sel, editing, clip, xray });
  live.current = { sel, editing, clip, xray };

  // ------------------------------------------------------------------------------------------
  // Feedback

  const toastTimer = useRef(0);
  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const startRipple = useCallback((report: RecalcReport) => {
    if (!live.current.xray || report.order.length === 0) {
      rippleRef.current = null;
      return;
    }
    const index = new Map<number, number>();
    report.order.forEach((k, i) => index.set(k, i));
    rippleRef.current = { index, count: report.order.length, start: performance.now() };
    gridRef.current?.redraw();
  }, []);

  const afterChange = useCallback(
    (change: Change | null) => {
      if (change) startRipple(change.report);
    },
    [startRipple],
  );

  const select = useCallback((s: Selection, scrollTo: Coord | null = s.focus) => {
    setSel(s);
    if (scrollTo) gridRef.current?.scrollIntoView(scrollTo);
  }, []);

  // ------------------------------------------------------------------------------------------
  // Opening documents

  const openDoc = useCallback(
    (doc: SheetDoc, start: string | null) => {
      setEditing(null);
      setClip(null);
      const report = wb.load(doc);
      const c = (start && parseAddress(start)) || { row: 0, col: 0 };
      setSel(at(c.row, c.col));
      requestAnimationFrame(() => gridRef.current?.scrollIntoView(c));
      startRipple(report);
      return report;
    },
    [wb, startRipple],
  );

  const openExample = useCallback(
    (ex: Example) => {
      const report = openDoc(ex.build(), ex.start);
      setHint(ex.hint ?? null);
      if (ex.id === 'stress') say(`Loaded ${plural(wb.sheet.size, 'cell')} and computed ${plural(report.order.length, 'formula')} in ${fmtMs(report.ms)}`);
    },
    [openDoc, say, wb],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const shared = readHash();
      if (shared) {
        try {
          const doc = await decodeDoc(shared);
          if (cancelled) return;
          openDoc(doc, null);
          say(`Opened “${doc.name}” from a share link`);
          history.replaceState(null, '', location.pathname + location.search);
          setReady(true);
          return;
        } catch {
          say('That share link is damaged, so the last sheet was opened instead.');
        }
      }
      const saved = storageGet(SAVE_KEY);
      if (saved && !cancelled) {
        try {
          const parsed = JSON.parse(saved) as SheetDoc | { example: string };
          if ('example' in parsed) {
            const ex = EXAMPLES.find((e) => e.id === parsed.example);
            if (ex) openExample(ex);
          } else openDoc(parsed, null);
          setReady(true);
          return;
        } catch {
          // Fall through to the default example.
        }
      }
      if (!cancelled) {
        openExample(EXAMPLES[0]);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openDoc, openExample, say]);

  // Remember the sheet in this browser.
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      if (wb.sheet.size > SAVE_LIMIT) {
        const ex = EXAMPLES.find((e) => e.title === wb.name);
        if (ex) storageSet(SAVE_KEY, JSON.stringify({ example: ex.id }));
        return;
      }
      storageSet(SAVE_KEY, JSON.stringify(wb.toDoc()));
    }, 400);
    return () => clearTimeout(id);
  }, [version, ready, wb]);

  // ------------------------------------------------------------------------------------------
  // Theme

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    setThemeVersion((v) => v + 1);
  }, [dark]);

  useEffect(() => {
    document.fonts?.ready.then(() => {
      resetMeasureCache();
      setThemeVersion((v) => v + 1);
    });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      if (!storageGet(THEME_KEY)) setDark(e.matches);
    };
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  // ------------------------------------------------------------------------------------------
  // Editing

  const beginEdit = useCallback(
    (text: string | null, mode: Editing['mode'], source: Editing['source']) => {
      const { row, col } = live.current.sel.anchor;
      const t = text ?? wb.sheet.raw(toKey(row, col));
      pendingCaret.current = t.length;
      setEditing({ row, col, text: t, caret: t.length, mode, source, point: null });
      setAssistIndex(0);
      setHint(null);
    },
    [wb],
  );

  const editKey = editing ? `${editing.row},${editing.col},${editing.source}` : '';
  useLayoutEffect(() => {
    if (!editKey) return;
    const e = live.current.editing!;
    const input = e.source === 'cell' ? cellInputRef.current : barInputRef.current;
    if (input && document.activeElement !== input) input.focus({ preventScroll: true });
  }, [editKey]);

  // Put the caret where a programmatic edit (pointing, completion) left it.
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !editing) return;
    const input = editing.source === 'cell' ? cellInputRef.current : barInputRef.current;
    if (input) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [editing]);

  const commit = useCallback(
    (move: [number, number] | null) => {
      const e = live.current.editing;
      if (!e) return;
      const text = autoClose(e.text);
      const next = move ? clampCoord(e.row + move[0], e.col + move[1]) : { row: e.row, col: e.col };
      setEditing(null);
      const change = wb.apply([[toKey(e.row, e.col), text]], `Changing ${addr(e.row, e.col)}`, live.current.sel, at(next.row, next.col));
      afterChange(change);
      select(at(next.row, next.col));
      gridRef.current?.focus();
    },
    [wb, afterChange, select],
  );

  const cancel = useCallback(() => {
    setEditing(null);
    gridRef.current?.focus();
  }, []);

  const completion = editing ? completionAt(editing.text, editing.caret) : null;
  const call = editing && !completion ? activeCall(editing.text, editing.caret) : null;

  const acceptCompletion = (fn: FnDef): void => {
    const e = live.current.editing;
    const c = e && completionAt(e.text, e.caret);
    if (!e || !c) return;
    const text = e.text.slice(0, c.start) + fn.name + '(' + e.text.slice(e.caret);
    const caret = c.start + fn.name.length + 1;
    pendingCaret.current = caret;
    setEditing({ ...e, text, caret, point: null, mode: 'edit' });
    setAssistIndex(0);
  };

  const insertPoint = (a: Coord, b: Coord): void => {
    const label = a.row === b.row && a.col === b.col ? addr(a.row, a.col) : rangeLabel(normalize(a, b));
    setEditing((e) => {
      if (!e) return e;
      const reuse = e.point !== null && e.caret === e.point.end;
      const start = reuse ? e.point!.start : e.caret;
      const end = reuse ? e.point!.end : e.caret;
      const text = e.text.slice(0, start) + label + e.text.slice(end);
      pendingCaret.current = start + label.length;
      return { ...e, text, caret: start + label.length, point: { start, end: start + label.length, anchor: a } };
    });
  };

  const onEditKey = (ev: KeyboardEvent<HTMLInputElement>): void => {
    const e = live.current.editing;
    if (!e) return;
    if (completion) {
      const n = completion.matches.length;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        setAssistIndex((i) => (i + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        acceptCompletion(completion.matches[Math.min(assistIndex, n - 1)]);
        return;
      }
    }
    switch (ev.key) {
      case 'Enter':
        ev.preventDefault();
        commit(ev.shiftKey ? [-1, 0] : [1, 0]);
        return;
      case 'Tab':
        ev.preventDefault();
        commit(ev.shiftKey ? [0, -1] : [0, 1]);
        return;
      case 'Escape':
        ev.preventDefault();
        cancel();
        return;
      case 'F2':
        ev.preventDefault();
        setEditing({ ...e, mode: e.mode === 'enter' ? 'edit' : 'enter' });
        return;
    }
    const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (dirs[ev.key] && e.mode === 'enter' && e.source === 'cell' && !e.text.startsWith('=')) {
      ev.preventDefault();
      commit(dirs[ev.key]);
    }
  };

  // ------------------------------------------------------------------------------------------
  // Commands

  const move = (d: [number, number], extend: boolean, toEdge: boolean): void => {
    const s = live.current.sel;
    const from = extend ? s.focus : s.anchor;
    const to = toEdge ? jump(wb.sheet, from, d[0], d[1]) : clampCoord(from.row + d[0], from.col + d[1]);
    select(extend ? { anchor: s.anchor, focus: to } : at(to.row, to.col), to);
  };

  const clearSelection = (): void => {
    const s = live.current.sel;
    const r = selRange(s);
    const writes = clearWrites(wb.sheet, r);
    if (writes.length) afterChange(wb.apply(writes, `Clearing ${rangeLabel(r)}`, s, s));
  };

  const fill = (source: Range, target: Range, series: boolean, label: string): void => {
    const s = live.current.sel;
    const a = s.anchor;
    const focus = { row: a.row === target.r1 ? target.r2 : target.r1, col: a.col === target.c1 ? target.c2 : target.c1 };
    const next = { anchor: a, focus };
    afterChange(wb.apply(fillWrites(wb.sheet, source, target, series), label, s, next));
    setSel(next);
  };

  const fillDirection = (down: boolean): void => {
    const r = selRange(live.current.sel);
    if (down) {
      if (r.r1 === r.r2) {
        if (r.r1 > 0) fill({ ...r, r1: r.r1 - 1, r2: r.r1 - 1 }, { ...r, r1: r.r1 - 1 }, false, `Filling down into ${rangeLabel(r)}`);
      } else fill({ ...r, r2: r.r1 }, r, false, `Filling down into ${rangeLabel(r)}`);
    } else if (r.c1 === r.c2) {
      if (r.c1 > 0) fill({ ...r, c1: r.c1 - 1, c2: r.c1 - 1 }, { ...r, c1: r.c1 - 1 }, false, `Filling right into ${rangeLabel(r)}`);
    } else fill({ ...r, c2: r.c1 }, r, false, `Filling right into ${rangeLabel(r)}`);
  };

  const makeClip = (cut: boolean): Clip | null => {
    const r = selRange(live.current.sel);
    if ((r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1) > MAX_CLIP_CELLS) {
      say(`That selection is too large to copy (the limit is ${plural(MAX_CLIP_CELLS, 'cell')}).`);
      return null;
    }
    const c = copyClip(wb.sheet, r, cut);
    setClip(c);
    return c;
  };

  const doPaste = (text: string | null): void => {
    const s = live.current.sel;
    const dest = selRange(s);
    const c = live.current.clip;
    let writes: Array<[number, string]>;
    let area: Range;
    let label: string;
    if (c && (text === null || text === c.text)) {
      ({ writes, area } = pasteWrites(c.raws, dest, { row: c.r.r1, col: c.r.c1 }, !c.cut));
      if (c.cut) {
        // Moving: clear the source first; the pasted cells then overwrite any overlap.
        const clears = clearWrites(wb.sheet, c.r);
        writes = [...clears, ...writes];
        setClip(null);
      }
      label = c.cut ? `Moving ${rangeLabel(c.r)} to ${rangeLabel(area)}` : `Pasting into ${rangeLabel(area)}`;
    } else if (text) {
      const block = parseClipboardText(text);
      if (block.length * Math.max(...block.map((r) => r.length)) > MAX_CLIP_CELLS) {
        say('That is too much to paste at once.');
        return;
      }
      ({ writes, area } = pasteWrites(block, dest, null, false));
      label = `Pasting into ${rangeLabel(area)}`;
    } else return;
    const next = { anchor: { row: area.r1, col: area.c1 }, focus: { row: area.r2, col: area.c2 } };
    afterChange(wb.apply(writes, label, s, next));
    setSel(next);
  };

  const structural = (kind: StructuralOp['kind'], axis: StructuralOp['axis']): void => {
    const s = live.current.sel;
    const r = selRange(s);
    const op: StructuralOp = axis === 'row' ? { kind, axis, at: r.r1, count: r.r2 - r.r1 + 1 } : { kind, axis, at: r.c1, count: r.c2 - r.c1 + 1 };
    if ((axis === 'row' && isFullCols(r)) || (axis === 'col' && isFullRows(r))) return;
    const what = axis === 'row' ? (op.count === 1 ? `row ${op.at + 1}` : `rows ${op.at + 1}–${op.at + op.count}`) : op.count === 1 ? `column ${colName(op.at)}` : `columns ${colName(op.at)}–${colName(op.at + op.count - 1)}`;
    const label = kind === 'insert' ? `Inserting ${plural(op.count, axis === 'row' ? 'row' : 'column')} at ${what.split(' ')[1]}` : `Deleting ${what}`;
    setClip(null);
    afterChange(wb.structural(op, label, s));
    say(`${label}: references across the sheet were rewritten`);
  };

  const undo = (): void => {
    const c = wb.undo();
    if (c) {
      afterChange(c);
      select(c.selection);
    }
  };
  const redo = (): void => {
    const c = wb.redo();
    if (c) {
      afterChange(c);
      select(c.selection);
    }
  };

  // Clipboard events go through the document, so the system clipboard works with Ctrl+C/X/V.
  const actions = useRef({ makeClip, doPaste });
  actions.current = { makeClip, doPaste };
  useEffect(() => {
    const gridFocused = (): boolean => document.activeElement === gridRef.current?.element() && !live.current.editing;
    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      if (!gridFocused()) return;
      const c = actions.current.makeClip(cut);
      if (!c) return;
      e.clipboardData?.setData('text/plain', c.text);
      e.preventDefault();
    };
    const copy = (e: ClipboardEvent): void => onCopy(e, false);
    const cut = (e: ClipboardEvent): void => onCopy(e, true);
    const paste = (e: ClipboardEvent): void => {
      if (!gridFocused()) return;
      e.preventDefault();
      actions.current.doPaste(e.clipboardData?.getData('text/plain') ?? '');
    };
    document.addEventListener('copy', copy);
    document.addEventListener('cut', cut);
    document.addEventListener('paste', paste);
    return () => {
      document.removeEventListener('copy', copy);
      document.removeEventListener('cut', cut);
      document.removeEventListener('paste', paste);
    };
  }, []);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (live.current.editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const s = live.current.sel;
    const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (dirs[e.key]) {
      e.preventDefault();
      move(dirs[e.key], e.shiftKey, mod);
      return;
    }
    const handled = (): void => e.preventDefault();
    switch (e.key) {
      case 'Tab':
        handled();
        return move([0, e.shiftKey ? -1 : 1], false, false);
      case 'Enter':
        handled();
        return move([e.shiftKey ? -1 : 1, 0], false, false);
      case 'Home':
        handled();
        return select(mod ? at(0, 0) : at(s.anchor.row, 0));
      case 'End':
        if (mod) {
          handled();
          return select(at(Math.max(0, wb.sheet.usedRows - 1), Math.max(0, wb.sheet.usedCols - 1)));
        }
        return;
      case 'PageDown':
      case 'PageUp': {
        handled();
        const n = gridRef.current?.pageRows() ?? 20;
        return move([e.key === 'PageDown' ? n : -n, 0], e.shiftKey, false);
      }
      case 'F2':
        handled();
        return beginEdit(null, 'edit', 'cell');
      case 'Delete':
      case 'Backspace':
        handled();
        return clearSelection();
      case 'Escape':
        setClip(null);
        return;
    }
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        handled();
        return e.shiftKey ? redo() : undo();
      }
      if (k === 'y') {
        handled();
        return redo();
      }
      if (k === 'a') {
        handled();
        return select({ anchor: { row: 0, col: 0 }, focus: { row: MAX_ROWS - 1, col: MAX_COLS - 1 } }, null);
      }
      if (k === 'd' || k === 'r') {
        handled();
        return fillDirection(k === 'd');
      }
      if (e.key === '+' || (e.key === '=' && e.shiftKey)) {
        handled();
        const r = selRange(s);
        return structural('insert', isFullCols(r) ? 'col' : 'row');
      }
      if (e.key === '-') {
        handled();
        const r = selRange(s);
        return structural('delete', isFullCols(r) ? 'col' : 'row');
      }
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      handled();
      beginEdit(e.key, 'enter', 'cell');
    }
  };

  // ------------------------------------------------------------------------------------------
  // Grid pointer callbacks

  const onCellDown = (c: Coord, shift: boolean): boolean => {
    setMenu(null);
    const e = live.current.editing;
    if (e) {
      if (e.text.startsWith('=') && (e.point || canInsertRef(e.text, e.caret))) {
        insertPoint(c, c);
        return true;
      }
      commit(null);
    }
    setSel((s) => (shift ? { anchor: s.anchor, focus: c } : at(c.row, c.col)));
    return false;
  };

  const onCellDrag = (c: Coord, pointing: boolean): void => {
    if (pointing) {
      const p = live.current.editing?.point;
      if (p) insertPoint(p.anchor, c);
      return;
    }
    setSel((s) => (s.focus.row === c.row && s.focus.col === c.col ? s : { anchor: s.anchor, focus: c }));
  };

  const onHeaderDown = (kind: HeaderKind, index: number, shift: boolean): void => {
    if (live.current.editing) commit(null);
    if (kind === 'all') return select({ anchor: { row: 0, col: 0 }, focus: { row: MAX_ROWS - 1, col: MAX_COLS - 1 } }, null);
    setSel((s) => {
      if (kind === 'col') return { anchor: { row: 0, col: shift ? s.anchor.col : index }, focus: { row: MAX_ROWS - 1, col: index } };
      return { anchor: { row: shift ? s.anchor.row : index, col: 0 }, focus: { row: index, col: MAX_COLS - 1 } };
    });
  };

  const onHeaderDrag = (kind: HeaderKind, index: number): void => {
    setSel((s) => (kind === 'col' ? { anchor: s.anchor, focus: { row: MAX_ROWS - 1, col: index } } : { anchor: s.anchor, focus: { row: index, col: MAX_COLS - 1 } }));
  };

  const onContextMenu = (x: number, y: number, target: { kind: 'cell'; c: Coord } | { kind: HeaderKind; index: number }): void => {
    if (live.current.editing) commit(null);
    let s = live.current.sel;
    const r0 = selRange(s);
    if (target.kind === 'cell') {
      const { c } = target;
      if (c.row < r0.r1 || c.row > r0.r2 || c.col < r0.c1 || c.col > r0.c2) s = at(c.row, c.col);
    } else if (target.kind === 'col') {
      if (!(isFullCols(r0) && target.index >= r0.c1 && target.index <= r0.c2)) s = { anchor: { row: 0, col: target.index }, focus: { row: MAX_ROWS - 1, col: target.index } };
    } else if (target.kind === 'row') {
      if (!(isFullRows(r0) && target.index >= r0.r1 && target.index <= r0.r2)) s = { anchor: { row: target.index, col: 0 }, focus: { row: target.index, col: MAX_COLS - 1 } };
    }
    setSel(s);
    live.current.sel = s;
    const r = selRange(s);
    const rows = r.r2 - r.r1 + 1;
    const cols = r.c2 - r.c1 + 1;
    const items: ContextItem[] = [
      { label: 'Cut', hint: 'Ctrl+X', onSelect: () => writeClipboard(makeClip(true)) },
      { label: 'Copy', hint: 'Ctrl+C', onSelect: () => writeClipboard(makeClip(false)) },
      { label: 'Paste', hint: 'Ctrl+V', onSelect: () => doPaste(null), disabled: !live.current.clip },
    ];
    if (!isFullCols(r)) {
      items.push(
        { label: `Insert ${plural(rows, 'row')} above`, hint: 'Ctrl+Shift+=', onSelect: () => structural('insert', 'row'), separator: true },
        { label: rows === 1 ? `Delete row ${r.r1 + 1}` : `Delete rows ${r.r1 + 1}–${r.r2 + 1}`, onSelect: () => structural('delete', 'row'), danger: true },
      );
    }
    if (!isFullRows(r)) {
      items.push(
        { label: `Insert ${plural(cols, 'column')} left`, onSelect: () => structural('insert', 'col'), separator: isFullCols(r) },
        { label: cols === 1 ? `Delete column ${colName(r.c1)}` : `Delete columns ${colName(r.c1)}–${colName(r.c2)}`, onSelect: () => structural('delete', 'col'), danger: true },
      );
    }
    items.push({ label: 'Clear contents', hint: 'Delete', onSelect: clearSelection, separator: true });
    setMenu({ x, y, items });
  };

  const writeClipboard = (c: Clip | null): void => {
    if (c) navigator.clipboard?.writeText(c.text).catch(() => undefined);
  };

  // ------------------------------------------------------------------------------------------
  // File menu

  const confirmReplace = (): boolean => !wb.canUndo || window.confirm('This replaces the current sheet. Continue?');

  const onOpenCSV = (): void => fileRef.current?.click();
  const onFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const rows = parseCSV(text);
    const cells: Array<[string, string]> = [];
    for (let i = 0; i < rows.length && i < MAX_ROWS; i++)
      for (let j = 0; j < rows[i].length && j < MAX_COLS; j++) if (rows[i][j] !== '') cells.push([addr(i, j), rows[i][j]]);
    if (cells.length > 500_000) {
      say('That file has more than 500,000 values, which is more than this demo will open.');
      return;
    }
    const report = openDoc({ name: file.name.replace(/\.(csv|tsv|txt)$/i, ''), cells }, null);
    setHint(null);
    say(`Opened ${plural(cells.length, 'cell')} in ${fmtMs(report.ms)}`);
  };

  const onExportCSV = (): void => {
    const rows: string[][] = [];
    for (let r = 0; r < wb.sheet.usedRows; r++) {
      const row: string[] = [];
      for (let c = 0; c < wb.sheet.usedCols; c++) row.push(displayValue(wb.sheet.valueAt(r, c)));
      rows.push(row);
    }
    const url = URL.createObjectURL(new Blob([toCSV(rows)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wb.name || 'sheet'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onShare = async (): Promise<void> => {
    if (wb.sheet.size > SHARE_LIMIT) {
      say(`Share links hold up to ${plural(SHARE_LIMIT, 'cell')}. Export a CSV for bigger sheets.`);
      return;
    }
    const url = `${location.origin}${location.pathname}#${HASH_KEY}=${await encodeDoc(wb.toDoc())}`;
    try {
      await navigator.clipboard.writeText(url);
      say(`Link copied (${(url.length / 1024).toFixed(1)} KB). The sheet is inside the link; no server involved.`);
    } catch {
      history.replaceState(null, '', url);
      say('Copy the link from the address bar.');
    }
  };

  // ------------------------------------------------------------------------------------------
  // Derived view state

  const active = sel.anchor;
  const activeKey = toKey(active.row, active.col);
  const range = selRange(sel);
  const selLabel = range.r1 === range.r2 && range.c1 === range.c2 ? addr(active.row, active.col) : rangeLabel(range);

  const refs = useMemo(() => (editing && editing.text.startsWith('=') ? highlight(editing.text).refs : []), [editing]);

  const arrows = useMemo<Arrows | null>(() => {
    if (!xray || editing) return null;
    const p = wb.sheet.precedentsOf(activeKey);
    const precRefs: Coord[] = p.refs.map((k) => ({ row: Math.floor(k / MAX_COLS), col: k % MAX_COLS }));
    const precRanges: Range[] = [];
    for (const r of p.ranges) {
      if (r.r1 === r.r2 && r.c1 === r.c2) precRefs.push({ row: r.r1, col: r.c1 });
      else precRanges.push(r);
    }
    const deps = wb.sheet.dependentsOf(activeKey).map((k) => ({ row: Math.floor(k / MAX_COLS), col: k % MAX_COLS }));
    if (!precRefs.length && !precRanges.length && !deps.length) return null;
    return { target: active, precRefs, precRanges, deps };
  }, [xray, editing, wb, activeKey, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => (range.r1 === range.r2 && range.c1 === range.c2 ? null : selectionStats(wb.sheet, range)), [wb, range.r1, range.r2, range.c1, range.c2, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = wb.lastChange;
  const summary = change
    ? change.report.order.length
      ? `${change.label}: ${plural(change.report.order.length, 'formula')} recomputed in ${fmtMs(change.report.ms)}`
      : `${change.label}: nothing else needed recomputing`
    : 'Ready';

  const activeRaw = wb.sheet.raw(activeKey);
  const editorText = editing?.text ?? '';
  const colW = wb.xs[(editing?.col ?? 0) + 1] - wb.xs[editing?.col ?? 0];
  const editorWidth = Math.max(colW + 1, Math.min(640, (editorText.length + 2) * CHAR_W + 12));
  const assistEl = editing ? (editing.source === 'cell' ? cellInputRef.current : barInputRef.current) : null;
  const assistAnchor = assistEl ? assistEl.getBoundingClientRect() : null;

  const editor = editing ? (
    editing.source === 'cell' ? (
      <FormulaInput
        inputRef={cellInputRef}
        value={editing.text}
        label={`Editing ${addr(editing.row, editing.col)}`}
        className="fi-cell"
        onChange={(text, caret) => {
          setEditing((e) => e && { ...e, text, caret, point: null });
          setAssistIndex(0);
        }}
        onCaret={(caret) => setEditing((e) => (e && e.caret !== caret ? { ...e, caret, point: e.point && caret === e.point.end ? e.point : null } : e))}
        onKeyDown={onEditKey}
      />
    ) : (
      <FormulaInput inputRef={mirrorRef} value={editing.text} label="" className="fi-cell fi-mirror-only" readOnly />
    )
  ) : null;

  return (
    <div className="app">
      <Toolbar
        name={wb.name}
        examples={EXAMPLES}
        canUndo={wb.canUndo}
        canRedo={wb.canRedo}
        xray={xray}
        dark={dark}
        onExample={(ex) => confirmReplace() && openExample(ex)}
        onNew={() => {
          if (!confirmReplace()) return;
          openDoc({ name: 'Untitled', cells: [] }, null);
          setHint(null);
        }}
        onOpenCSV={onOpenCSV}
        onExportCSV={onExportCSV}
        onShare={onShare}
        onUndo={undo}
        onRedo={redo}
        onXray={(on) => {
          setXray(on);
          if (!on) rippleRef.current = null;
        }}
        onTheme={() => {
          const next = !dark;
          setDark(next);
          storageSet(THEME_KEY, next ? 'dark' : 'light');
        }}
        onHelp={() => setHelp(true)}
      />

      <div className="formula-bar">
        <input
          className="name-box"
          aria-label="Name box: type a cell or range to go there"
          value={nameBox ?? selLabel}
          onFocus={(e) => {
            setNameBox(selLabel);
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setNameBox(e.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setNameBox(null);
              gridRef.current?.focus();
            }
            if (e.key !== 'Enter') return;
            const r = parseRange(nameBox ?? '');
            if (!r) {
              say(`“${nameBox}” is not a cell or range. Try B12 or A1:C10.`);
              return;
            }
            setNameBox(null);
            select({ anchor: { row: r.r1, col: r.c1 }, focus: { row: r.r2, col: r.c2 } }, { row: r.r1, col: r.c1 });
            gridRef.current?.focus();
          }}
        />
        <span className="fx" aria-hidden="true">
          ƒx
        </span>
        <FormulaInput
          inputRef={barInputRef}
          className="fi-bar"
          label="Formula bar"
          placeholder={activeRaw ? '' : 'Type a value, or = to start a formula'}
          value={editing ? editing.text : activeRaw}
          onFocus={() => {
            if (!live.current.editing) beginEdit(null, 'edit', 'bar');
            else if (live.current.editing.source === 'cell') setEditing((e) => e && { ...e, source: 'bar' });
          }}
          onChange={(text, caret) => {
            setEditing((e) => (e ? { ...e, text, caret, point: null } : e));
            setAssistIndex(0);
          }}
          onCaret={(caret) => setEditing((e) => (e && e.caret !== caret ? { ...e, caret, point: e.point && caret === e.point.end ? e.point : null } : e))}
          onKeyDown={onEditKey}
        />
      </div>

      <main className={`workspace${xray ? '' : ' no-xray'}`}>
        <Grid
          ref={gridRef}
          wb={wb}
          version={version}
          sel={sel}
          editingAt={editing ? { row: editing.row, col: editing.col } : null}
          refs={refs}
          clip={clip}
          arrows={arrows}
          showFormulaMarks={xray}
          rippleRef={rippleRef}
          themeVersion={themeVersion}
          editor={editor}
          editorWidth={editorWidth}
          label={`${wb.name}. Selected ${selLabel}${activeRaw ? `, ${displayValue(wb.sheet.value(activeKey))}` : ', empty'}.`}
          onCellDown={onCellDown}
          onCellDrag={onCellDrag}
          onHeaderDown={onHeaderDown}
          onHeaderDrag={onHeaderDrag}
          onFill={(t) => fill(range, t, true, `Filling ${rangeLabel(t)}`)}
          onDoubleClick={(c) => {
            select(at(c.row, c.col));
            live.current.sel = at(c.row, c.col);
            beginEdit(null, 'edit', 'cell');
          }}
          onContextMenu={onContextMenu}
          onKeyDown={onGridKey}
        />
        {xray && (
          <Inspector
            sheet={wb.sheet}
            version={version}
            active={active}
            change={change}
            hint={hint}
            onDismissHint={() => setHint(null)}
            onJump={(c) => {
              select(at(c.row, c.col));
              gridRef.current?.focus();
            }}
          />
        )}
      </main>

      <StatusBar summary={summary} stats={stats} />

      <Assist
        anchor={assistAnchor}
        completions={completion?.matches ?? null}
        active={Math.min(assistIndex, (completion?.matches.length ?? 1) - 1)}
        call={call}
        onPick={acceptCompletion}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {help && <Help onClose={() => setHelp(false)} functionCount={FUNCTION_LIST.length} />}
      <Toast text={toast} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {editing ? '' : `${selLabel}${activeRaw ? `, ${displayValue(wb.sheet.value(activeKey))}` : ', empty'}`}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && confirmReplace()) void onFile(f);
        }}
      />
    </div>
  );
}
