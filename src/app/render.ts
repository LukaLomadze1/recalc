// Draws the visible part of the sheet onto a canvas. A DOM grid of a million rows is not an option,
// and even a virtualised one re-creates hundreds of nodes per scroll frame; the canvas redraws only
// what is on screen, usually 30–40 rows, in well under a millisecond.

import { colName, type CellKey, type Coord, type Range } from '../engine/address.ts';
import type { Sheet } from '../engine/sheet.ts';
import { displayValue, formatNumber, isError, type Scalar } from '../engine/values.ts';
import { HEADER_H, ROW_H, ROW_HEADER_W, visibleCells, type Viewport } from './geometry.ts';
import { withAlpha, type Theme } from './theme.ts';

export interface Arrows {
  target: Coord;
  precRefs: Coord[];
  precRanges: Range[];
  deps: Coord[];
}

export interface Ripple {
  index: Map<CellKey, number>;
  count: number;
  start: number;
}

export interface RenderInput {
  sheet: Sheet;
  xs: Float64Array;
  view: Viewport;
  width: number;
  height: number;
  dpr: number;
  sel: Range;
  active: Coord;
  editing: Coord | null;
  refs: Array<{ r: Range; color: number }>;
  copy: { r: Range; cut: boolean } | null;
  fill: Range | null;
  arrows: Arrows | null;
  showFormulaMarks: boolean;
  ripple: Ripple | null;
  now: number;
  theme: Theme;
}

const FADE_MS = 700;
/** Each cell lights up a fixed step after the one evaluated before it, so the order is visible on screen. */
const STEP_MS = 5;
const MAX_DELAY_MS = 1400;
const rippleDelay = (i: number): number => Math.min(i * STEP_MS, MAX_DELAY_MS);
export const rippleDone = (r: Ripple, now: number): boolean => now > r.start + rippleDelay(r.count) + FADE_MS;

const widthCache = new Map<string, number>();
function measure(ctx: CanvasRenderingContext2D, s: string): number {
  let w = widthCache.get(s);
  if (w === undefined) {
    if (widthCache.size > 20_000) widthCache.clear();
    w = ctx.measureText(s).width;
    widthCache.set(s, w);
  }
  return w;
}
export const resetMeasureCache = (): void => widthCache.clear();

/** A number that fits in `room` pixels: fewer decimals first, then #### like Excel. */
function fitNumber(ctx: CanvasRenderingContext2D, n: number, room: number): string {
  const full = formatNumber(n);
  if (measure(ctx, full) <= room) return full;
  for (let digits = 9; digits >= 1; digits--) {
    const s = formatNumber(Number(n.toPrecision(digits)));
    if (measure(ctx, s) <= room && Math.abs(n) < 10 ** digits) return s;
  }
  const hash = measure(ctx, '#');
  return '#'.repeat(Math.max(1, Math.floor(room / hash)));
}

export function render(ctx: CanvasRenderingContext2D, p: RenderInput): void {
  const { xs, view, theme: t, sheet } = p;
  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
  ctx.fillStyle = t.gridBg;
  ctx.fillRect(0, 0, p.width, p.height);

  const vis = visibleCells(xs, { ...view, w: p.width - ROW_HEADER_W, h: p.height - HEADER_H });
  const ox = ROW_HEADER_W - view.x;
  const oy = HEADER_H - view.y;
  const cellX = (c: number): number => ox + xs[c];
  const cellY = (r: number): number => oy + r * ROW_H;
  const rect = (r: Range): [number, number, number, number] => [cellX(r.c1), cellY(r.r1), xs[r.c2 + 1] - xs[r.c1], (r.r2 - r.r1 + 1) * ROW_H];
  const px = (v: number): number => Math.round(v * p.dpr) / p.dpr;

  ctx.save();
  ctx.beginPath();
  ctx.rect(ROW_HEADER_W, HEADER_H, p.width - ROW_HEADER_W, p.height - HEADER_H);
  ctx.clip();

  // Recalculation ripple: cells light up in the order the engine evaluated them.
  if (p.ripple) {
    const rp = p.ripple;
    for (let r = vis.r1; r <= vis.r2; r++) {
      for (let c = vis.c1; c <= vis.c2; c++) {
        const i = rp.index.get(r * 16384 + c);
        if (i === undefined) continue;
        const age = p.now - rp.start - rippleDelay(i);
        if (age < 0 || age > FADE_MS) continue;
        const a = 1 - age / FADE_MS;
        ctx.fillStyle = withAlpha(t.ripple, 0.55 * a * a);
        ctx.fillRect(cellX(c), cellY(r), xs[c + 1] - xs[c], ROW_H);
      }
    }
  }

  // Selection tint (the active cell stays clear, as in Excel).
  const sel = p.sel;
  if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) {
    ctx.fillStyle = t.accentSoft;
    ctx.fillRect(...rect(clampRange(sel, vis)));
    ctx.fillStyle = t.gridBg;
    ctx.fillRect(cellX(p.active.col), cellY(p.active.row), xs[p.active.col + 1] - xs[p.active.col], ROW_H);
  }

  for (const ref of p.refs) {
    ctx.fillStyle = withAlpha(t.refs[ref.color], 0.09);
    ctx.fillRect(...rect(clampRange(ref.r, vis)));
  }

  // X-ray: tint what the selected cell reads (blue) and what reads it (orange).
  if (p.arrows) {
    const a = p.arrows;
    const tint = (c: Coord, color: string): void => {
      if (c.row < vis.r1 || c.row > vis.r2 || c.col < vis.c1 || c.col > vis.c2) return;
      ctx.fillStyle = withAlpha(color, 0.1);
      ctx.fillRect(cellX(c.col), cellY(c.row), xs[c.col + 1] - xs[c.col], ROW_H);
      ctx.fillStyle = color;
      ctx.fillRect(cellX(c.col), cellY(c.row), 2, ROW_H);
    };
    for (const r of a.precRanges) {
      ctx.fillStyle = withAlpha(t.prec, 0.07);
      ctx.fillRect(...rect(clampRange(r, vis)));
    }
    for (const c of a.precRefs) tint(c, t.prec);
    for (const c of a.deps) tint(c, t.dep);
  }

  // Grid lines.
  ctx.fillStyle = t.line;
  const right = Math.min(p.width, cellX(vis.c2 + 1));
  const bottom = Math.min(p.height, cellY(vis.r2 + 1));
  const lw = 1 / p.dpr;
  for (let c = vis.c1; c <= vis.c2 + 1; c++) ctx.fillRect(px(cellX(c)) - lw, HEADER_H, lw, bottom - HEADER_H);
  for (let r = vis.r1; r <= vis.r2 + 1; r++) ctx.fillRect(ROW_HEADER_W, px(cellY(r)) - lw, right - ROW_HEADER_W, lw);

  // Formula marks, in X-ray mode: a small corner tick on every cell that holds a formula.
  if (p.showFormulaMarks) {
    ctx.fillStyle = t.formulaMark;
    for (let r = vis.r1; r <= vis.r2; r++) {
      for (let c = vis.c1; c <= vis.c2; c++) {
        const cell = sheet.cell(r * 16384 + c);
        if (!cell || (!cell.expr && !cell.parseError)) continue;
        const x = cellX(c);
        const y = cellY(r);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Values.
  ctx.font = t.cellFont;
  ctx.textBaseline = 'middle';
  for (let r = vis.r1; r <= vis.r2; r++) {
    const y = cellY(r) + ROW_H / 2 + 0.5;
    for (let c = vis.c1; c <= vis.c2; c++) {
      const v: Scalar = sheet.valueAt(r, c);
      if (v === null) continue;
      if (p.editing && p.editing.row === r && p.editing.col === c) continue;
      const x = cellX(c);
      const w = xs[c + 1] - xs[c];
      if (typeof v === 'number') {
        ctx.fillStyle = t.ink;
        ctx.textAlign = 'right';
        ctx.fillText(fitNumber(ctx, v, w - 10), x + w - 5, y);
        continue;
      }
      if (typeof v === 'boolean' || isError(v)) {
        ctx.fillStyle = isError(v) ? t.error : t.ink;
        ctx.textAlign = 'center';
        ctx.fillText(displayValue(v), x + w / 2, y);
        continue;
      }
      if (v === '') continue;
      ctx.fillStyle = t.ink;
      ctx.textAlign = 'left';
      const tw = measure(ctx, v);
      if (tw <= w - 10) {
        ctx.fillText(v, x + 5, y);
        continue;
      }
      // Long text spills into empty cells to the right, and is clipped at the first non-empty one.
      let room = w;
      for (let k = c + 1; k <= vis.c2 + 1 && room < tw + 10 && sheet.valueAt(r, k) === null; k++) room += xs[k + 1] - xs[k];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, cellY(r), room - 2, ROW_H);
      ctx.clip();
      ctx.fillText(v, x + 5, y);
      ctx.restore();
    }
  }

  // Outlines of the ranges the formula being edited refers to.
  for (const ref of p.refs) {
    ctx.strokeStyle = t.refs[ref.color];
    ctx.lineWidth = 1.5;
    const [x, y, w, h] = rect(clampRange(ref.r, vis, 2));
    ctx.strokeRect(px(x) + 0.75, px(y) + 0.75, w - 1.5, h - 1.5);
  }

  if (p.copy) {
    ctx.save();
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -(p.now / 40) % 9;
    const [x, y, w, h] = rect(clampRange(p.copy.r, vis, 2));
    ctx.strokeRect(px(x) + 1, px(y) + 1, w - 2, h - 2);
    ctx.restore();
  }

  if (p.fill) {
    ctx.save();
    ctx.strokeStyle = t.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    const [x, y, w, h] = rect(clampRange(p.fill, vis, 2));
    ctx.strokeRect(px(x) + 0.5, px(y) + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  // Selection border and fill handle.
  {
    const [x, y, w, h] = rect(clampRange(sel, vis, 2));
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(px(x), px(y), w, h);
    if (!p.editing) {
      ctx.fillStyle = t.gridBg;
      ctx.fillRect(px(x + w) - 4.5, px(y + h) - 4.5, 9, 9);
      ctx.fillStyle = t.accent;
      ctx.fillRect(px(x + w) - 3.5, px(y + h) - 3.5, 7, 7);
    }
  }

  if (p.arrows) drawArrows(ctx, p, cellX, cellY, rect);
  ctx.restore();

  drawHeaders(ctx, p, vis, cellX, cellY);
}

function clampRange(r: Range, vis: { r1: number; r2: number; c1: number; c2: number }, pad = 1): Range {
  return {
    r1: Math.max(r.r1, vis.r1 - pad),
    r2: Math.min(r.r2, vis.r2 + pad),
    c1: Math.max(r.c1, vis.c1 - pad),
    c2: Math.min(r.c2, vis.c2 + pad),
  };
}

function drawHeaders(
  ctx: CanvasRenderingContext2D,
  p: RenderInput,
  vis: { r1: number; r2: number; c1: number; c2: number },
  cellX: (c: number) => number,
  cellY: (r: number) => number,
): void {
  const { xs, theme: t, sel } = p;
  const lw = 1 / p.dpr;
  ctx.font = t.headerFont;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const fullCols = sel.r1 === 0 && sel.r2 === 1_048_575;
  const fullRows = sel.c1 === 0 && sel.c2 === 16_383;

  // Column header band.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ROW_HEADER_W, 0, p.width - ROW_HEADER_W, HEADER_H);
  ctx.clip();
  ctx.fillStyle = t.header;
  ctx.fillRect(ROW_HEADER_W, 0, p.width - ROW_HEADER_W, HEADER_H);
  for (let c = vis.c1; c <= vis.c2; c++) {
    const x = cellX(c);
    const w = xs[c + 1] - xs[c];
    const on = c >= sel.c1 && c <= sel.c2;
    if (on) {
      ctx.fillStyle = fullCols ? t.accent : t.headerActive;
      ctx.fillRect(x, 0, w, HEADER_H);
      ctx.fillStyle = t.accent;
      ctx.fillRect(x, HEADER_H - 2, w, 2);
    }
    ctx.fillStyle = on ? (fullCols ? t.gridBg : t.headerActiveInk) : t.headerInk;
    ctx.fillText(colName(c), x + w / 2, HEADER_H / 2 + 0.5);
    ctx.fillStyle = t.lineStrong;
    ctx.fillRect(Math.round((x + w) * p.dpr) / p.dpr - lw, 5, lw, HEADER_H - 10);
  }
  ctx.fillStyle = t.lineStrong;
  ctx.fillRect(ROW_HEADER_W, HEADER_H - lw, p.width, lw);
  ctx.restore();

  // Row header band.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_H, ROW_HEADER_W, p.height - HEADER_H);
  ctx.clip();
  ctx.fillStyle = t.header;
  ctx.fillRect(0, HEADER_H, ROW_HEADER_W, p.height - HEADER_H);
  for (let r = vis.r1; r <= vis.r2; r++) {
    const y = cellY(r);
    const on = r >= sel.r1 && r <= sel.r2;
    if (on) {
      ctx.fillStyle = fullRows ? t.accent : t.headerActive;
      ctx.fillRect(0, y, ROW_HEADER_W, ROW_H);
      ctx.fillStyle = t.accent;
      ctx.fillRect(ROW_HEADER_W - 2, y, 2, ROW_H);
    }
    ctx.fillStyle = on ? (fullRows ? t.gridBg : t.headerActiveInk) : t.headerInk;
    ctx.fillText(String(r + 1), ROW_HEADER_W / 2, y + ROW_H / 2 + 0.5);
    ctx.fillStyle = t.line;
    ctx.fillRect(4, Math.round((y + ROW_H) * p.dpr) / p.dpr - lw, ROW_HEADER_W - 8, lw);
  }
  ctx.fillStyle = t.lineStrong;
  ctx.fillRect(ROW_HEADER_W - lw, HEADER_H, lw, p.height);
  ctx.restore();

  // Corner.
  ctx.fillStyle = t.header;
  ctx.fillRect(0, 0, ROW_HEADER_W, HEADER_H);
  ctx.fillStyle = t.lineStrong;
  ctx.fillRect(ROW_HEADER_W - lw, 0, lw, HEADER_H);
  ctx.fillRect(0, HEADER_H - lw, ROW_HEADER_W, lw);
  ctx.beginPath();
  ctx.moveTo(ROW_HEADER_W - 6, HEADER_H - 14);
  ctx.lineTo(ROW_HEADER_W - 6, HEADER_H - 6);
  ctx.lineTo(ROW_HEADER_W - 14, HEADER_H - 6);
  ctx.closePath();
  ctx.fillStyle = t.lineStrong;
  ctx.fill();
}

/** Arrows to the nearest few cells only; the rest are tinted. A fan of 300 arrows hides the numbers. */
const MAX_ARROWS = 6;

function drawArrows(
  ctx: CanvasRenderingContext2D,
  p: RenderInput,
  cellX: (c: number) => number,
  cellY: (r: number) => number,
  rect: (r: Range) => [number, number, number, number],
): void {
  const { arrows: a, theme: t, xs } = p;
  if (!a) return;
  const center = (c: Coord): [number, number] => [cellX(c.col) + (xs[c.col + 1] - xs[c.col]) / 2, cellY(c.row) + ROW_H / 2];
  const [tx, ty] = center(a.target);
  const onScreen = (x: number, y: number): boolean => x > -200 && y > -200 && x < p.width + 200 && y < p.height + 200;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';

  // Ranges a formula reads: outline them, then point from their nearest edge.
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = t.prec;
  for (const r of a.precRanges.slice(0, MAX_ARROWS)) {
    const [x, y, w, h] = rect(r);
    if (h > 2_000_000) continue; // whole columns: the outline is not useful
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }
  ctx.setLineDash([]);
  let drawn = 0;
  for (const r of a.precRanges) {
    if (drawn >= MAX_ARROWS) break;
    const [x, y, w, h] = rect(r);
    const sx = Math.max(x, Math.min(tx, x + w));
    const sy = Math.max(y, Math.min(ty, y + h));
    if (sx === tx && sy === ty) continue; // the target is inside the range (a cycle): no arrow to draw
    if (!onScreen(sx, sy) && !onScreen(tx, ty)) continue;
    arrow(ctx, sx, sy, tx, ty, t.prec, t.gridBg);
    drawn++;
  }
  const near = (list: Coord[]): Coord[] =>
    list.length <= MAX_ARROWS
      ? list
      : [...list].sort((m, n) => Math.hypot(m.row - a.target.row, m.col - a.target.col) - Math.hypot(n.row - a.target.row, n.col - a.target.col)).slice(0, MAX_ARROWS);
  for (const c of near(a.precRefs)) {
    if (drawn >= MAX_ARROWS) break;
    const [sx, sy] = center(c);
    if (!onScreen(sx, sy) && !onScreen(tx, ty)) continue;
    arrow(ctx, sx, sy, tx, ty, t.prec, t.gridBg);
    drawn++;
  }
  drawn = 0;
  for (const c of near(a.deps)) {
    if (drawn >= MAX_ARROWS) break;
    const [dx, dy] = center(c);
    if (!onScreen(dx, dy)) continue;
    arrow(ctx, tx, ty, dx, dy, t.dep, t.gridBg);
    drawn++;
  }
  ctx.restore();
}

/** A gently curved arrow with a dot at its tail and a head at its tip. */
function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, halo: string): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  // Curve to one side so arrows along the same row or column do not sit on top of each other.
  const bend = Math.min(40, len * 0.18);
  const mx = (x1 + x2) / 2 - (dy / len) * bend;
  const my = (y1 + y2) / 2 + (dx / len) * bend;
  // Stop short of the centre so the head sits near the cell edge.
  const back = Math.min(9, len / 3);
  const ex = x2 - ((x2 - mx) / Math.hypot(x2 - mx, y2 - my)) * back;
  const ey = y2 - ((y2 - my) / Math.hypot(x2 - mx, y2 - my)) * back;

  for (const [stroke, width] of [
    [halo, 4],
    [color, 1.6],
  ] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
  const ang = Math.atan2(ey - my, ex - mx);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ex + Math.cos(ang) * 4, ey + Math.sin(ang) * 4);
  ctx.lineTo(ex + Math.cos(ang + 2.5) * 7, ey + Math.sin(ang + 2.5) * 7);
  ctx.lineTo(ex + Math.cos(ang - 2.5) * 7, ey + Math.sin(ang - 2.5) * 7);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x1, y1, 2.6, 0, Math.PI * 2);
  ctx.fill();
}
