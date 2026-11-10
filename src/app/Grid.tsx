// The grid: a canvas behind a transparent native scroller. The scroller gives real scrollbars, wheel,
// trackpad and touch momentum for free; the canvas draws whatever the scroll position says is visible.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from 'react';
import { MAX_COLS, MAX_ROWS, normalize, type Coord, type Range } from '../engine/address.ts';
import { displayValue } from '../engine/values.ts';
import {
  colAt,
  DEFAULT_COL_W,
  HEADER_H,
  MIN_COL_W,
  ROW_H,
  ROW_HEADER_W,
  rowAt,
  SCROLL_H,
  scrollToSheetY,
  sheetYToScroll,
  type Viewport,
} from './geometry.ts';
import type { Clip } from './ops.ts';
import { render, rippleDone, type Arrows, type Ripple } from './render.ts';
import { readTheme, type Theme } from './theme.ts';
import { selRange, type Selection, type Workbook } from './workbook.ts';

export interface GridHandle {
  scrollIntoView(c: Coord): void;
  focus(): void;
  redraw(): void;
  pageRows(): number;
  element(): HTMLDivElement | null;
}

export type HeaderKind = 'col' | 'row' | 'all';

interface Props {
  wb: Workbook;
  version: number;
  sel: Selection;
  editingAt: Coord | null;
  refs: Array<{ r: Range; color: number }>;
  clip: Clip | null;
  arrows: Arrows | null;
  showFormulaMarks: boolean;
  rippleRef: { current: Ripple | null };
  themeVersion: number;
  editor: ReactNode;
  editorWidth: number;
  label: string;
  /** Returns true if the press was used to point at a cell while editing a formula. */
  onCellDown(c: Coord, shift: boolean): boolean;
  onCellDrag(c: Coord, pointing: boolean): void;
  onHeaderDown(kind: HeaderKind, index: number, shift: boolean): void;
  onHeaderDrag(kind: HeaderKind, index: number): void;
  onFill(target: Range): void;
  onDoubleClick(c: Coord): void;
  onContextMenu(x: number, y: number, target: { kind: 'cell'; c: Coord } | { kind: HeaderKind; index: number }): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
}

type Drag =
  | { kind: 'cells'; pointing: boolean }
  | { kind: 'header'; header: HeaderKind }
  | { kind: 'fill'; source: Range; target: Range }
  | { kind: 'resize'; col: number; startX: number; startW: number }
  | { kind: 'tap'; x: number; y: number; c: Coord; shift: boolean };

const RESIZE_SLOP = 4;

export const Grid = forwardRef<GridHandle, Props>(function Grid(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const view = useRef<Viewport>({ x: 0, y: 0, w: 0, h: 0 });
  const theme = useRef<Theme | null>(null);
  const frame = useRef(0);
  const drag = useRef<Drag | null>(null);
  const fillPreview = useRef<Range | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const p = propsRef.current;
    if (!canvas || !theme.current || size.current.w === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const now = performance.now();
    let ripple = p.rippleRef.current;
    if (ripple && rippleDone(ripple, now)) {
      p.rippleRef.current = null;
      ripple = null;
    }
    const sel = selRange(p.sel);
    render(ctx, {
      sheet: p.wb.sheet,
      xs: p.wb.xs,
      view: view.current,
      width: size.current.w,
      height: size.current.h,
      dpr: size.current.dpr,
      sel,
      active: p.sel.anchor,
      editing: p.editingAt,
      refs: p.refs,
      copy: p.clip ? { r: p.clip.r, cut: p.clip.cut } : null,
      fill: fillPreview.current,
      arrows: p.arrows,
      showFormulaMarks: p.showFormulaMarks,
      ripple,
      now,
      theme: theme.current,
    });
    positionEditor();
    // Keep animating while something moves: the ripple, or the marching ants around a copy.
    if (ripple || p.clip) frame.current = requestAnimationFrame(draw);
  }, []);  

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  function positionEditor(): void {
    const el = editorRef.current;
    const at = propsRef.current.editingAt;
    if (!el || !at) return;
    const xs = propsRef.current.wb.xs;
    const x = ROW_HEADER_W + xs[at.col] - view.current.x;
    const y = HEADER_H + at.row * ROW_H - view.current.y;
    const left = Math.max(ROW_HEADER_W, x);
    el.style.transform = `translate(${left}px, ${Math.max(HEADER_H, y)}px)`;
    el.style.minWidth = `${Math.min(xs[at.col + 1] - xs[at.col] + 1, size.current.w - left)}px`;
    el.style.maxWidth = `${Math.max(40, size.current.w - left)}px`;
  }

  // Size the canvas to the scroller's client area, at device resolution.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current!;
    const canvas = canvasRef.current!;
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = scroller.clientWidth;
      const h = scroller.clientHeight;
      size.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      syncView();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(scroller);
    resize();
    return () => ro.disconnect();
  }, [draw]);  

  useEffect(() => {
    theme.current = readTheme(document.documentElement);
    schedule();
  }, [props.themeVersion, schedule]);

  // Place the editor before the browser paints, so it never flashes at the corner.
  useLayoutEffect(() => {
    positionEditor();
  }, [props.editingAt, props.editorWidth]);  

  // Anything React knows about changed: redraw on the next frame.
  useEffect(schedule, [props.version, props.sel, props.editingAt, props.refs, props.clip, props.arrows, props.showFormulaMarks, schedule]);

  function syncView(): void {
    const s = scrollerRef.current!;
    const viewH = size.current.h - HEADER_H;
    view.current = { x: s.scrollLeft, y: scrollToSheetY(s.scrollTop, viewH), w: size.current.w - ROW_HEADER_W, h: viewH };
  }

  const onScroll = (): void => {
    syncView();
    schedule();
  };

  useImperativeHandle(ref, () => ({
    scrollIntoView(c: Coord) {
      const s = scrollerRef.current;
      if (!s) return;
      const xs = propsRef.current.wb.xs;
      const v = view.current;
      const top = c.row * ROW_H;
      const bottom = top + ROW_H;
      let y = v.y;
      if (top < v.y) y = top;
      else if (bottom > v.y + v.h) y = bottom - v.h;
      if (y !== v.y) s.scrollTop = sheetYToScroll(y, v.h);
      const left = xs[c.col];
      const right = xs[c.col + 1];
      if (left < v.x) s.scrollLeft = left;
      else if (right > v.x + v.w) s.scrollLeft = Math.min(left, right - v.w);
      syncView();
      schedule();
    },
    focus() {
      scrollerRef.current?.focus({ preventScroll: true });
    },
    redraw: schedule,
    pageRows: () => Math.max(1, Math.floor(view.current.h / ROW_H) - 1),
    element: () => scrollerRef.current,
  }));

  // ------------------------------------------------------------------------------------------
  // Pointer input

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = scrollerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const cellAt = (x: number, y: number): Coord => ({
    row: rowAt(view.current.y + y - HEADER_H),
    col: colAt(propsRef.current.wb.xs, view.current.x + x - ROW_HEADER_W),
  });
  /** The column whose right edge is under x in the header, if any. */
  const resizeEdge = (x: number): number | null => {
    const xs = propsRef.current.wb.xs;
    const sx = view.current.x + x - ROW_HEADER_W;
    const c = colAt(xs, sx);
    if (Math.abs(xs[c + 1] - sx) <= RESIZE_SLOP) return c;
    if (c > 0 && Math.abs(xs[c] - sx) <= RESIZE_SLOP) return c - 1;
    return null;
  };
  const onFillHandle = (x: number, y: number): boolean => {
    const p = propsRef.current;
    if (p.editingAt) return false;
    const r = selRange(p.sel);
    const hx = ROW_HEADER_W + p.wb.xs[r.c2 + 1] - view.current.x;
    const hy = HEADER_H + (r.r2 + 1) * ROW_H - view.current.y;
    return Math.abs(x - hx) <= 6 && Math.abs(y - hy) <= 6;
  };

  const inClient = (x: number, y: number): boolean => {
    const s = scrollerRef.current!;
    return x >= 0 && y >= 0 && x < s.clientWidth && y < s.clientHeight;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    if (!inClient(x, y)) return; // on a scrollbar
    const p = propsRef.current;
    const scroller = scrollerRef.current!;
    if (!p.editingAt) scroller.focus({ preventScroll: true });

    if (x < ROW_HEADER_W && y < HEADER_H) {
      p.onHeaderDown('all', 0, false);
      return;
    }
    if (y < HEADER_H) {
      const edge = resizeEdge(x);
      if (edge !== null) {
        const xs = p.wb.xs;
        drag.current = { kind: 'resize', col: edge, startX: x, startW: xs[edge + 1] - xs[edge] };
      } else {
        const col = cellAt(x, HEADER_H).col;
        p.onHeaderDown('col', col, e.shiftKey);
        drag.current = { kind: 'header', header: 'col' };
      }
      scroller.setPointerCapture(e.pointerId);
      return;
    }
    if (x < ROW_HEADER_W) {
      p.onHeaderDown('row', cellAt(ROW_HEADER_W, y).row, e.shiftKey);
      drag.current = { kind: 'header', header: 'row' };
      scroller.setPointerCapture(e.pointerId);
      return;
    }
    if (onFillHandle(x, y)) {
      const source = selRange(p.sel);
      drag.current = { kind: 'fill', source, target: source };
      fillPreview.current = source;
      scroller.setPointerCapture(e.pointerId);
      return;
    }
    const c = cellAt(x, y);
    if (e.pointerType === 'touch') {
      // On touch, a drag scrolls; only a tap selects.
      drag.current = { kind: 'tap', x, y, c, shift: e.shiftKey };
      return;
    }
    const pointing = p.onCellDown(c, e.shiftKey);
    drag.current = { kind: 'cells', pointing };
    scroller.setPointerCapture(e.pointerId);
  };

  const dragTo = (x: number, y: number): void => {
    const d = drag.current;
    const p = propsRef.current;
    if (!d) return;
    const cx = Math.max(ROW_HEADER_W + 1, Math.min(x, size.current.w - 1));
    const cy = Math.max(HEADER_H + 1, Math.min(y, size.current.h - 1));
    if (d.kind === 'cells') p.onCellDrag(cellAt(cx, cy), d.pointing);
    else if (d.kind === 'header') {
      const c = cellAt(cx, cy);
      p.onHeaderDrag(d.header, d.header === 'col' ? c.col : c.row);
    } else if (d.kind === 'fill') {
      const c = cellAt(cx, cy);
      const s = d.source;
      // Fill along whichever axis the pointer has moved further from the selection.
      const down = c.row > s.r2 ? c.row - s.r2 : c.row < s.r1 ? s.r1 - c.row : 0;
      const across = c.col > s.c2 ? c.col - s.c2 : c.col < s.c1 ? s.c1 - c.col : 0;
      let t: Range = s;
      if (down >= across && down > 0) t = { ...s, r1: Math.min(s.r1, c.row), r2: Math.max(s.r2, c.row) };
      else if (across > 0) t = { ...s, c1: Math.min(s.c1, c.col), c2: Math.max(s.c2, c.col) };
      d.target = t;
      fillPreview.current = t;
      schedule();
    } else if (d.kind === 'resize') {
      const w = Math.max(MIN_COL_W, Math.min(1200, d.startW + x - d.startX));
      p.wb.setWidth(d.col, w);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      // Hover cursor.
      const s = scrollerRef.current!;
      const cursor = y < HEADER_H && x > ROW_HEADER_W && resizeEdge(x) !== null ? 'col-resize' : onFillHandle(x, y) ? 'crosshair' : y > HEADER_H && x > ROW_HEADER_W ? 'cell' : 'default';
      if (s.style.cursor !== cursor) s.style.cursor = cursor;
      return;
    }
    if (d.kind === 'tap') {
      if (Math.hypot(x - d.x, y - d.y) > 8) drag.current = null;
      return;
    }
    lastPointer.current = { x, y };
    dragTo(x, y);
    // Drag past an edge to keep scrolling.
    const edgeX = x < ROW_HEADER_W ? x - ROW_HEADER_W : x > size.current.w ? x - size.current.w : 0;
    const edgeY = y < HEADER_H ? y - HEADER_H : y > size.current.h ? y - size.current.h : 0;
    if ((edgeX || edgeY) && d.kind !== 'resize' && !autoScroll.current) {
      autoScroll.current = window.setInterval(() => {
        const lp = lastPointer.current;
        const s = scrollerRef.current;
        if (!lp || !s || !drag.current) return;
        const ex = lp.x < ROW_HEADER_W ? lp.x - ROW_HEADER_W : lp.x > size.current.w ? lp.x - size.current.w : 0;
        const ey = lp.y < HEADER_H ? lp.y - HEADER_H : lp.y > size.current.h ? lp.y - size.current.h : 0;
        s.scrollLeft += Math.sign(ex) * Math.min(60, Math.abs(ex));
        s.scrollTop += Math.sign(ey) * Math.min(60, Math.abs(ey));
        syncView();
        dragTo(lp.x, lp.y);
      }, 40);
    } else if (!edgeX && !edgeY && autoScroll.current) {
      clearInterval(autoScroll.current);
      autoScroll.current = 0;
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (autoScroll.current) {
      clearInterval(autoScroll.current);
      autoScroll.current = 0;
    }
    if (scrollerRef.current?.hasPointerCapture(e.pointerId)) scrollerRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    const p = propsRef.current;
    if (d.kind === 'tap') {
      p.onCellDown(d.c, d.shift);
    } else if (d.kind === 'fill') {
      fillPreview.current = null;
      const s = d.source;
      const t = d.target;
      if (t.r1 !== s.r1 || t.r2 !== s.r2 || t.c1 !== s.c1 || t.c2 !== s.c2) p.onFill(t);
      schedule();
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    if (!inClient(x, y)) return;
    const p = propsRef.current;
    if (y < HEADER_H && x > ROW_HEADER_W) {
      const edge = resizeEdge(x);
      if (edge !== null) autofit(edge);
      return;
    }
    if (y > HEADER_H && x > ROW_HEADER_W) p.onDoubleClick(cellAt(x, y));
  };

  /** Double-click a column edge: fit the widest value in the column. */
  function autofit(col: number): void {
    const p = propsRef.current;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !theme.current) return;
    ctx.font = theme.current.cellFont;
    let widest = 0;
    let seen = 0;
    p.wb.sheet.forEachOccupied({ r1: 0, r2: MAX_ROWS - 1, c1: col, c2: col }, (v) => {
      widest = Math.max(widest, ctx.measureText(displayValue(v)).width);
      return ++seen > 20_000;
    });
    p.wb.setWidth(col, widest === 0 ? DEFAULT_COL_W : Math.min(600, Math.max(MIN_COL_W, Math.ceil(widest + 16))));
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    if (!inClient(x, y)) return;
    e.preventDefault();
    const p = propsRef.current;
    if (y < HEADER_H && x > ROW_HEADER_W) p.onContextMenu(e.clientX, e.clientY, { kind: 'col', index: cellAt(x, HEADER_H).col });
    else if (x < ROW_HEADER_W && y > HEADER_H) p.onContextMenu(e.clientX, e.clientY, { kind: 'row', index: cellAt(ROW_HEADER_W, y).row });
    else if (x > ROW_HEADER_W && y > HEADER_H) p.onContextMenu(e.clientX, e.clientY, { kind: 'cell', c: cellAt(x, y) });
  };

  const xs = props.wb.xs;
  return (
    <div
      className="grid-wrap"
      ref={wrapRef}
      onScroll={(e) => {
        // Belt and braces for browsers without overflow: clip.
        e.currentTarget.scrollLeft = 0;
        e.currentTarget.scrollTop = 0;
      }}
    >
      <canvas ref={canvasRef} className="grid-canvas" aria-hidden="true" />
      <div
        ref={scrollerRef}
        className="grid-scroller"
        tabIndex={0}
        role="grid"
        aria-label={props.label}
        aria-rowcount={MAX_ROWS}
        aria-colcount={MAX_COLS}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onMouseDown={(e) => {
          // While editing, a click on the grid must not take focus away from the editor.
          if (propsRef.current.editingAt) e.preventDefault();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={props.onKeyDown}
      >
        <div className="grid-spacer" style={{ width: ROW_HEADER_W + xs[MAX_COLS], height: HEADER_H + SCROLL_H }} />
      </div>
      {props.editingAt && (
        <div ref={editorRef} className="cell-editor" style={{ width: props.editorWidth }}>
          {props.editor}
        </div>
      )}
    </div>
  );
});

export const rangeFrom = (a: Coord, b: Coord): Range => normalize(a, b);
