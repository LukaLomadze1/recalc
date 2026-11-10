// Walks a formula's AST and produces a value. The evaluator knows nothing about the dependency graph:
// it reads other cells through the context, which is what lets the naive reference evaluator in
// naive.ts share it, so the fuzzer tests the graph and not two copies of the arithmetic.

import type { Range } from './address.ts';
import { FUNCTIONS } from './functions.ts';
import type { Expr } from './parser.ts';
import {
  CellError,
  checkNumber,
  compare,
  ERR,
  isError,
  toNumber,
  toText,
  type Scalar,
} from './values.ts';

export interface RangeVal {
  kind: 'range';
  r: Range;
}
export type Value = Scalar | RangeVal;

export const isRange = (v: Value): v is RangeVal =>
  typeof v === 'object' && v !== null && !(v instanceof CellError) && v.kind === 'range';

export interface EvalContext {
  /** The cell being computed, for ROW() and COLUMN() with no argument. */
  row: number;
  col: number;
  get(row: number, col: number): Scalar;
  /** Visits only the non-blank cells inside r, in row-major order. Returning true stops the walk. */
  forEachOccupied(r: Range, cb: (v: Scalar, row: number, col: number) => boolean | void): void;
  /** An upper bound on the used area: no cell at or beyond these is non-blank. */
  usedRows(): number;
  usedCols(): number;
}

export interface Call {
  args: Expr[];
  ctx: EvalContext;
  ev(e: Expr): Value;
  scalar(e: Expr): Scalar;
}

/** Evaluates a parsed formula. Never throws: failures become error values. */
export function evaluate(expr: Expr, ctx: EvalContext): Scalar {
  try {
    const v = toScalar(ev(expr, ctx), ctx);
    return v === null ? 0 : v;
  } catch (e) {
    if (e instanceof CellError) return e;
    if (e instanceof RangeError) return new CellError('#NUM!', 'The formula is too deeply nested to evaluate.');
    throw e;
  }
}

function toScalar(v: Value, ctx: EvalContext): Scalar {
  if (!isRange(v)) return v;
  const { r1, c1, r2, c2 } = v.r;
  if (r1 === r2 && c1 === c2) return ctx.get(r1, c1);
  throw new CellError('#VALUE!', 'A range cannot be a value on its own here. Wrap it in a function such as SUM().');
}

function ev(e: Expr, ctx: EvalContext): Value {
  switch (e.t) {
    case 'num':
    case 'str':
    case 'bool':
      return e.v;
    case 'err':
      return ERR[e.v];
    case 'empty':
      return null;
    case 'ref':
      return ctx.get(e.row, e.col);
    case 'range':
      return { kind: 'range', r: e.r };
    case 'name':
      throw new CellError('#NAME?', `"${e.name}" is not a function or a name this engine knows.`);
    case 'neg':
      return -toNumber(scalar(e.e, ctx));
    case 'pos':
      return scalar(e.e, ctx);
    case 'pct':
      return toNumber(scalar(e.e, ctx)) / 100;
    case 'bin':
      return binary(e.op, scalar(e.a, ctx), scalar(e.b, ctx));
    case 'call':
      return call(e.name, e.args, ctx);
  }
}

function scalar(e: Expr, ctx: EvalContext): Scalar {
  const v = toScalar(ev(e, ctx), ctx);
  if (isError(v)) throw v;
  return v;
}

function binary(op: string, a: Scalar, b: Scalar): Scalar {
  switch (op) {
    case '+':
      return checkNumber(toNumber(a) + toNumber(b));
    case '-':
      return checkNumber(toNumber(a) - toNumber(b));
    case '*':
      return checkNumber(toNumber(a) * toNumber(b));
    case '/': {
      const x = toNumber(a);
      const y = toNumber(b);
      if (y === 0) throw ERR['#DIV/0!'];
      return checkNumber(x / y);
    }
    case '^': {
      const x = toNumber(a);
      const y = toNumber(b);
      if (x === 0 && y === 0) throw new CellError('#NUM!', '0^0 is undefined.');
      if (x === 0 && y < 0) throw ERR['#DIV/0!'];
      return checkNumber(x ** y);
    }
    case '&':
      return toText(a) + toText(b);
    case '=':
      return compare(a, b) === 0;
    case '<>':
      return compare(a, b) !== 0;
    case '<':
      return compare(a, b) < 0;
    case '>':
      return compare(a, b) > 0;
    case '<=':
      return compare(a, b) <= 0;
    case '>=':
      return compare(a, b) >= 0;
  }
  throw ERR['#ERROR!'];
}

function call(name: string, args: Expr[], ctx: EvalContext): Scalar {
  const fn = FUNCTIONS.get(name);
  if (!fn) throw new CellError('#NAME?', `There is no function called ${name}.`);
  if (args.length < fn.min || args.length > fn.max) {
    const want = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min} to ${fn.max}`;
    throw new CellError('#ERROR!', `${name} takes ${want} argument${fn.min === 1 && fn.max === 1 ? '' : 's'}, not ${args.length}.`);
  }
  const c: Call = {
    args,
    ctx,
    ev: (x) => ev(x, ctx),
    scalar: (x) => scalar(x, ctx),
  };
  const out = fn.impl(c);
  if (typeof out === 'number' && !Number.isFinite(out)) throw ERR['#NUM!'];
  return out;
}
