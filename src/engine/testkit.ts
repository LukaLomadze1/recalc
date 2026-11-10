// Helpers for tests: build a sheet from { A1: '1', B1: '=A1*2' } and read values by address.

import { parseAddress, toKey, type CellKey } from './address.ts';
import { Sheet } from './sheet.ts';
import { displayValue, isError, type Scalar } from './values.ts';

export function keyOf(a1: string): CellKey {
  const c = parseAddress(a1);
  if (!c) throw new Error(`bad address ${a1}`);
  return toKey(c.row, c.col);
}

export function sheetOf(cells: Record<string, string>): Sheet {
  const s = new Sheet();
  s.set(Object.entries(cells).map(([a, raw]) => [keyOf(a), raw] as const));
  return s;
}

/** The value of one cell; errors come back as their code, so tests can compare with toBe. */
export function val(s: Sheet, a1: string): Exclude<Scalar, object> | string {
  const v = s.value(keyOf(a1));
  return isError(v) ? v.code : v;
}

/** Evaluates one formula on an otherwise empty sheet (or on the given cells). */
export function calc(formula: string, cells: Record<string, string> = {}): Exclude<Scalar, object> | string {
  const s = sheetOf({ ...cells, ZZ1000: formula.startsWith('=') ? formula : '=' + formula });
  return val(s, 'ZZ1000');
}

export const shown = (s: Sheet, a1: string): string => displayValue(s.value(keyOf(a1)));
