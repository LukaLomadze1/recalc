// The function library. Each entry has the metadata the formula bar shows while you type, and an
// implementation that receives its arguments unevaluated, so IF, IFERROR and CHOOSE can be lazy.

import type { Range } from './address.ts';
import type { Call, RangeVal, Value } from './evaluate.ts';
import type { Expr } from './parser.ts';
import {
  CellError,
  checkNumber,
  compare,
  displayValue,
  ERR,
  isError,
  textToNumber,
  toBool,
  toNumber,
  toText,
  type Scalar,
} from './values.ts';

export type Category = 'Math' | 'Statistics' | 'Logic' | 'Text' | 'Lookup' | 'Conditional' | 'Information' | 'Finance';

export interface FnDef {
  name: string;
  args: string;
  desc: string;
  category: Category;
  min: number;
  max: number;
  impl: (c: Call) => Scalar;
}

const isRangeVal = (v: Value): v is RangeVal =>
  typeof v === 'object' && v !== null && !(v instanceof CellError) && v.kind === 'range';

// ---------------------------------------------------------------------------------------------
// Argument helpers

/**
 * Visits every value the arguments supply. Values that came from a reference or range are flagged,
 * because Excel treats them differently: SUM(A1) ignores text in A1, but SUM("abc") is an error.
 */
function eachValue(c: Call, cb: (v: Scalar, fromRef: boolean) => void, args: Expr[] = c.args): void {
  for (const a of args) {
    if (a.t === 'ref') {
      cb(c.ctx.get(a.row, a.col), true);
      continue;
    }
    const v = c.ev(a);
    if (isRangeVal(v)) c.ctx.forEachOccupied(v.r, (x) => cb(x, true));
    else cb(v, false);
  }
}

/** The numbers in the arguments, with SUM's rules. Errors propagate. */
function numbers(c: Call, args?: Expr[]): number[] {
  const out: number[] = [];
  eachValue(
    c,
    (v, fromRef) => {
      if (typeof v === 'number') out.push(v);
      else if (isError(v)) throw v;
      else if (!fromRef && v !== null) out.push(toNumber(v));
    },
    args,
  );
  return out;
}

function num(c: Call, i: number, fallback?: number): number {
  const a = c.args[i];
  if (a === undefined || a.t === 'empty') {
    if (fallback === undefined) throw new CellError('#VALUE!', 'A required argument is missing.');
    return fallback;
  }
  return toNumber(c.scalar(a));
}

function text(c: Call, i: number, fallback?: string): string {
  const a = c.args[i];
  if (a === undefined || a.t === 'empty') {
    if (fallback === undefined) throw new CellError('#VALUE!', 'A required argument is missing.');
    return fallback;
  }
  return toText(c.scalar(a));
}

function bool(c: Call, i: number, fallback: boolean): boolean {
  const a = c.args[i];
  if (a === undefined || a.t === 'empty') return fallback;
  return toBool(c.scalar(a));
}

function scalarArg(c: Call, i: number): Scalar {
  const a = c.args[i];
  if (a === undefined || a.t === 'empty') return null;
  return c.scalar(a);
}

/** Evaluates without letting an error escape, for IFERROR and the IS* functions. */
function attempt(c: Call, e: Expr): Scalar {
  try {
    const v = c.ev(e);
    if (!isRangeVal(v)) return v;
    const { r1, c1, r2, c2 } = v.r;
    if (r1 === r2 && c1 === c2) return c.ctx.get(r1, c1);
    return new CellError('#VALUE!', 'A range cannot be a value on its own here.');
  } catch (err) {
    if (err instanceof CellError) return err;
    throw err;
  }
}

/** A range argument. A single reference counts as a 1×1 range. */
function rangeArg(c: Call, i: number): Range {
  const a = c.args[i];
  if (a?.t === 'ref') return { r1: a.row, c1: a.col, r2: a.row, c2: a.col };
  const v = a ? c.ev(a) : null;
  if (isRangeVal(v)) return v.r;
  if (isError(v)) throw v;
  throw new CellError('#VALUE!', 'This argument must be a range, such as A1:B10.');
}

const height = (r: Range): number => r.r2 - r.r1 + 1;
const width = (r: Range): number => r.c2 - r.c1 + 1;

/**
 * How many rows and columns of offsets are worth visiting when scanning ranges of shape h×w side by
 * side. Past the used area every cell is blank, so a scan of A:A stops at the last used row.
 */
function scanLimit(c: Call, ranges: Range[], h: number, w: number): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const r of ranges) {
    rows = Math.max(rows, c.ctx.usedRows() - r.r1);
    cols = Math.max(cols, c.ctx.usedCols() - r.c1);
  }
  return { rows: Math.max(0, Math.min(h, rows)), cols: Math.max(0, Math.min(w, cols)) };
}

// ---------------------------------------------------------------------------------------------
// Criteria, as used by SUMIF, COUNTIF and friends: 5, ">5", "<>done", "a*", "".

type Matcher = (v: Scalar) => boolean;

function wildcard(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, 'is');
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function criteria(crit: Scalar): Matcher {
  if (isError(crit)) throw crit;
  if (typeof crit === 'number') return (v) => (typeof v === 'number' ? v === crit : typeof v === 'string' && textToNumber(v) === crit);
  if (typeof crit === 'boolean') return (v) => v === crit;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(crit ?? '')!;
  const op = m[1] ?? '=';
  const operand = m[2];
  const n = operand.trim() === '' ? null : textToNumber(operand);
  if (n !== null) {
    switch (op) {
      case '=':
        return (v) => (typeof v === 'number' ? v === n : typeof v === 'string' && textToNumber(v) === n);
      case '<>':
        return (v) => !(typeof v === 'number' && v === n);
      case '<':
        return (v) => typeof v === 'number' && v < n;
      case '>':
        return (v) => typeof v === 'number' && v > n;
      case '<=':
        return (v) => typeof v === 'number' && v <= n;
      default:
        return (v) => typeof v === 'number' && v >= n;
    }
  }
  const up = operand.toUpperCase();
  if ((up === 'TRUE' || up === 'FALSE') && (op === '=' || op === '<>')) {
    const b = up === 'TRUE';
    return op === '=' ? (v) => v === b : (v) => v !== b;
  }
  if (operand === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
  }
  if (op === '=' || op === '<>') {
    const re = wildcard(operand);
    const eq: Matcher = (v) => typeof v === 'string' && re.test(v);
    return op === '=' ? eq : (v) => !eq(v);
  }
  const lower = operand.toLowerCase();
  return (v) => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    if (op === '<') return s < lower;
    if (op === '>') return s > lower;
    if (op === '<=') return s <= lower;
    return s >= lower;
  };
}

/**
 * The shared engine behind every *IF / *IFS function. pairs[i] is [criteria range, matcher].
 * Calls onMatch(row offset, col offset) for each position where every criterion holds, and returns
 * how many matching positions lie past the used area (they are all blank, so they match or not together).
 */
function scanCriteria(c: Call, pairs: Array<[Range, Matcher]>, extra: Range[], onMatch: (i: number, j: number) => void): number {
  const h = height(pairs[0][0]);
  const w = width(pairs[0][0]);
  for (const [r] of pairs) {
    if (height(r) !== h || width(r) !== w) throw new CellError('#VALUE!', 'All criteria ranges must be the same size.');
  }
  // Usually some criterion rejects blank cells (">5", "Paid"), and then only the occupied cells of
  // that range can match, so walk those instead of every position: COUNTIF(A:A, ">5") stays cheap.
  const driver = pairs.find(([, match]) => !match(null));
  if (driver) {
    const d = driver[0];
    c.ctx.forEachOccupied(d, (_v, row, col) => {
      const i = row - d.r1;
      const j = col - d.c1;
      for (const [r, match] of pairs) if (!match(c.ctx.get(r.r1 + i, r.c1 + j))) return;
      onMatch(i, j);
    });
    return 0;
  }
  const lim = scanLimit(c, [...pairs.map((p) => p[0]), ...extra], h, w);
  for (let i = 0; i < lim.rows; i++) {
    for (let j = 0; j < lim.cols; j++) {
      let ok = true;
      for (const [r, match] of pairs) {
        if (!match(c.ctx.get(r.r1 + i, r.c1 + j))) {
          ok = false;
          break;
        }
      }
      if (ok) onMatch(i, j);
    }
  }
  const allBlankMatch = pairs.every(([, match]) => match(null));
  return allBlankMatch ? h * w - lim.rows * lim.cols : 0;
}

function ifsPairs(c: Call, from: number): Array<[Range, Matcher]> {
  if ((c.args.length - from) % 2 !== 0) throw new CellError('#VALUE!', 'Criteria come in pairs: a range and a condition.');
  const pairs: Array<[Range, Matcher]> = [];
  for (let i = from; i < c.args.length; i += 2) pairs.push([rangeArg(c, i), criteria(scalarArg(c, i + 1))]);
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// Lookup helpers

/** Equality for exact lookups: case-insensitive text with wildcards, numbers and booleans by value. */
function lookupEquals(target: Scalar, wild: boolean): Matcher {
  // A blank lookup value looks for 0, as in Excel; it never matches blank cells.
  if (target === null) return (v) => v === 0;
  if (typeof target === 'string') {
    if (wild && /[*?~]/.test(target)) {
      const re = wildcard(target);
      return (v) => typeof v === 'string' && re.test(v);
    }
    const t = target.toLowerCase();
    return (v) => typeof v === 'string' && v.toLowerCase() === t;
  }
  return (v) => v === target;
}

const sameType = (a: Scalar, b: Scalar): boolean => typeof a === typeof b && a !== null && b !== null;

/**
 * The occupied cells of a single row or column, in order, as (offset, value). Blank cells can never
 * match a lookup, so they are skipped rather than visited.
 */
function lineCells(c: Call, line: Range, cb: (k: number, v: Scalar) => boolean | void): void {
  const vertical = line.c1 === line.c2;
  c.ctx.forEachOccupied(line, (v, row, col) => cb(vertical ? row - line.r1 : col - line.c1, v));
}

/** Offset along a line, or -1. mode: 0 exact, 1 largest <= target (sorted ascending), -1 smallest >= target (sorted descending). */
function findInLine(c: Call, line: Range, target: Scalar, mode: number): number {
  let found = -1;
  if (mode === 0) {
    const eq = lookupEquals(target, true);
    lineCells(c, line, (k, v) => {
      if (!eq(v)) return false;
      found = k;
      return true;
    });
    return found;
  }
  lineCells(c, line, (k, v) => {
    if (!sameType(v, target)) return false;
    const cmp = compare(v, target);
    if (cmp === 0 || (mode === 1 ? cmp < 0 : cmp > 0)) found = k;
    return cmp === 0 || (mode === 1 ? cmp > 0 : cmp < 0);
  });
  return found;
}

const colLine = (r: Range, k = 0): Range => ({ r1: r.r1, r2: r.r2, c1: r.c1 + k, c2: r.c1 + k });
const rowLine = (r: Range, k = 0): Range => ({ r1: r.r1 + k, r2: r.r1 + k, c1: r.c1, c2: r.c2 });

// ---------------------------------------------------------------------------------------------
// Rounding, statistics and finance helpers

function roundTo(n: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const d = Math.trunc(digits);
  const sign = Math.sign(n);
  const abs = Math.abs(n);
  // Shift by exponent notation rather than multiplying, so 1.005 rounds to 1.01 as people expect.
  const shifted = Number(`${abs}e${d}`);
  const base = Number.isFinite(shifted) ? shifted : abs * 10 ** d;
  const fixed = Number(base.toPrecision(15));
  const r = mode === 'half' ? Math.round(fixed) : mode === 'up' ? Math.ceil(fixed) : Math.floor(fixed);
  const back = Number(`${r}e${-d}`);
  return sign * (Number.isFinite(back) ? back : r / 10 ** d);
}

function mean(xs: number[]): number {
  if (xs.length === 0) throw ERR['#DIV/0!'];
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[], sample: boolean): number {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) throw ERR['#DIV/0!'];
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (sample ? n - 1 : n);
}

function median(xs: number[]): number {
  if (xs.length === 0) throw ERR['#NUM!'];
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pmt(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (nper === 0) throw ERR['#NUM!'];
  if (rate === 0) return -(pv + fv) / nper;
  const g = (1 + rate) ** nper;
  return -(rate * (fv + pv * g)) / ((1 + rate * type) * (g - 1));
}

function fvOf(rate: number, nper: number, payment: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + payment * nper);
  const g = (1 + rate) ** nper;
  return -(pv * g + (payment * (1 + rate * type) * (g - 1)) / rate);
}

function pvOf(rate: number, nper: number, payment: number, fv: number, type: number): number {
  if (rate === 0) return -(fv + payment * nper);
  const g = (1 + rate) ** nper;
  return -(fv + (payment * (1 + rate * type) * (g - 1)) / rate) / g;
}

/** Newton's method with a numerical derivative. Throws #NUM! if it does not converge. */
function solve(f: (x: number) => number, guess: number): number {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x);
    if (Math.abs(y) < 1e-10) return x;
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const dy = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(dy) || dy === 0) break;
    const nx = x - y / dy;
    if (!Number.isFinite(nx)) break;
    if (Math.abs(nx - x) < 1e-12) return nx;
    x = nx;
  }
  throw new CellError('#NUM!', 'The calculation did not converge. Try a different guess.');
}

function formatText(v: Scalar, format: string): string {
  if (typeof v !== 'number') {
    const n = typeof v === 'string' ? textToNumber(v) : null;
    if (n === null) return toText(v);
    v = n;
  }
  const m = /^([^#0,.%]*)([#0,]*)(?:\.([0#]+))?(%?)([^#0,.%]*)$/.exec(format);
  if (!m || (m[2] === '' && m[3] === undefined)) return displayValue(v);
  const [, prefix, intPart, decPart = '', pct, suffix] = m;
  let n = pct ? v * 100 : v;
  const decimals = decPart.length;
  n = roundTo(n, decimals, 'half');
  const neg = n < 0;
  let [ip, dp = ''] = Math.abs(n).toFixed(decimals).split('.');
  const minInt = (intPart.replace(/[#,]/g, '').length);
  ip = ip.padStart(minInt, '0');
  if (minInt === 0 && ip === '0') ip = decimals > 0 ? '' : '0';
  if (intPart.includes(',')) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decPart.includes('#')) dp = dp.replace(/0+$/, '');
  return `${neg ? '-' : ''}${prefix}${ip}${dp ? '.' + dp : ''}${pct}${suffix}`;
}

// ---------------------------------------------------------------------------------------------
// The library

const defs: FnDef[] = [];
function def(name: string, args: string, category: Category, min: number, max: number, desc: string, impl: (c: Call) => Scalar): void {
  defs.push({ name, args, category, min, max, desc, impl });
}
const MANY = Infinity;

// Math ----------------------------------------------------------------------------------------
def('SUM', 'number1, [number2], …', 'Math', 1, MANY, 'Adds its arguments.', (c) => numbers(c).reduce((a, b) => a + b, 0));
def('PRODUCT', 'number1, [number2], …', 'Math', 1, MANY, 'Multiplies its arguments.', (c) => {
  const xs = numbers(c);
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a * b, 1);
});
def('SUMPRODUCT', 'array1, [array2], …', 'Math', 1, MANY, 'Multiplies matching cells of same-size ranges and adds the products.', (c) => {
  const ranges = c.args.map((_, i) => rangeArg(c, i));
  const h = height(ranges[0]);
  const w = width(ranges[0]);
  if (ranges.some((r) => height(r) !== h || width(r) !== w)) throw new CellError('#VALUE!', 'SUMPRODUCT needs ranges of the same size.');
  const lim = scanLimit(c, ranges, h, w);
  let total = 0;
  for (let i = 0; i < lim.rows; i++) {
    for (let j = 0; j < lim.cols; j++) {
      let p = 1;
      for (const r of ranges) {
        const v = c.ctx.get(r.r1 + i, r.c1 + j);
        if (isError(v)) throw v;
        p *= typeof v === 'number' ? v : 0;
      }
      total += p;
    }
  }
  return total;
});
def('ABS', 'number', 'Math', 1, 1, 'Absolute value.', (c) => Math.abs(num(c, 0)));
def('ROUND', 'number, [digits]', 'Math', 1, 2, 'Rounds half away from zero to a number of digits.', (c) => roundTo(num(c, 0), num(c, 1, 0), 'half'));
def('ROUNDUP', 'number, [digits]', 'Math', 1, 2, 'Rounds away from zero.', (c) => roundTo(num(c, 0), num(c, 1, 0), 'up'));
def('ROUNDDOWN', 'number, [digits]', 'Math', 1, 2, 'Rounds towards zero.', (c) => roundTo(num(c, 0), num(c, 1, 0), 'down'));
def('INT', 'number', 'Math', 1, 1, 'Rounds down to the nearest integer.', (c) => Math.floor(num(c, 0)));
def('TRUNC', 'number, [digits]', 'Math', 1, 2, 'Cuts off the decimals.', (c) => roundTo(num(c, 0), num(c, 1, 0), 'down'));
def('MOD', 'number, divisor', 'Math', 2, 2, 'Remainder, with the sign of the divisor.', (c) => {
  const n = num(c, 0);
  const d = num(c, 1);
  if (d === 0) throw ERR['#DIV/0!'];
  return n - d * Math.floor(n / d);
});
def('POWER', 'number, power', 'Math', 2, 2, 'Raises a number to a power.', (c) => {
  const x = num(c, 0);
  const y = num(c, 1);
  if (x === 0 && y === 0) throw ERR['#NUM!'];
  if (x === 0 && y < 0) throw ERR['#DIV/0!'];
  return checkNumber(x ** y);
});
def('SQRT', 'number', 'Math', 1, 1, 'Square root.', (c) => {
  const n = num(c, 0);
  if (n < 0) throw new CellError('#NUM!', 'Square root of a negative number.');
  return Math.sqrt(n);
});
def('EXP', 'number', 'Math', 1, 1, 'e raised to a power.', (c) => checkNumber(Math.exp(num(c, 0))));
def('LN', 'number', 'Math', 1, 1, 'Natural logarithm.', (c) => {
  const n = num(c, 0);
  if (n <= 0) throw ERR['#NUM!'];
  return Math.log(n);
});
def('LOG', 'number, [base]', 'Math', 1, 2, 'Logarithm, base 10 unless given.', (c) => {
  const n = num(c, 0);
  const b = num(c, 1, 10);
  if (n <= 0 || b <= 0) throw ERR['#NUM!'];
  if (b === 1) throw ERR['#DIV/0!'];
  return Math.log(n) / Math.log(b);
});
def('LOG10', 'number', 'Math', 1, 1, 'Base-10 logarithm.', (c) => {
  const n = num(c, 0);
  if (n <= 0) throw ERR['#NUM!'];
  return Math.log10(n);
});
def('PI', '', 'Math', 0, 0, 'The number π.', () => Math.PI);
def('SIGN', 'number', 'Math', 1, 1, '1, 0 or -1.', (c) => Math.sign(num(c, 0)));
def('CEILING', 'number, [significance]', 'Math', 1, 2, 'Rounds up to a multiple of significance.', (c) => {
  const n = num(c, 0);
  const s = num(c, 1, 1);
  if (s === 0) return 0;
  return roundTo(Math.ceil(Number((n / s).toPrecision(15))) * s, 12, 'half');
});
def('FLOOR', 'number, [significance]', 'Math', 1, 2, 'Rounds down to a multiple of significance.', (c) => {
  const n = num(c, 0);
  const s = num(c, 1, 1);
  if (s === 0) throw ERR['#DIV/0!'];
  return roundTo(Math.floor(Number((n / s).toPrecision(15))) * s, 12, 'half');
});
def('FACT', 'number', 'Math', 1, 1, 'Factorial.', (c) => {
  const n = Math.floor(num(c, 0));
  if (n < 0) throw ERR['#NUM!'];
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return checkNumber(r);
});

// Statistics -----------------------------------------------------------------------------------
def('AVERAGE', 'number1, [number2], …', 'Statistics', 1, MANY, 'Arithmetic mean.', (c) => mean(numbers(c)));
def('MIN', 'number1, [number2], …', 'Statistics', 1, MANY, 'Smallest number.', (c) => {
  const xs = numbers(c);
  return xs.length === 0 ? 0 : xs.reduce((a, b) => (b < a ? b : a));
});
def('MAX', 'number1, [number2], …', 'Statistics', 1, MANY, 'Largest number.', (c) => {
  const xs = numbers(c);
  return xs.length === 0 ? 0 : xs.reduce((a, b) => (b > a ? b : a));
});
def('MEDIAN', 'number1, [number2], …', 'Statistics', 1, MANY, 'Middle value.', (c) => median(numbers(c)));
def('COUNT', 'value1, [value2], …', 'Statistics', 1, MANY, 'Counts numbers.', (c) => {
  let n = 0;
  eachValue(c, (v, fromRef) => {
    if (typeof v === 'number') n++;
    else if (!fromRef && (typeof v === 'boolean' || (typeof v === 'string' && textToNumber(v) !== null))) n++;
  });
  return n;
});
def('COUNTA', 'value1, [value2], …', 'Statistics', 1, MANY, 'Counts non-blank values.', (c) => {
  let n = 0;
  for (const a of c.args) {
    if (a.t === 'empty') continue;
    if (a.t === 'ref') {
      if (c.ctx.get(a.row, a.col) !== null) n++;
      continue;
    }
    let v: Value;
    try {
      v = c.ev(a);
    } catch (err) {
      if (err instanceof CellError) {
        n++;
        continue;
      }
      throw err;
    }
    if (isRangeVal(v)) c.ctx.forEachOccupied(v.r, () => {
      n++;
    });
    else if (v !== null) n++;
  }
  return n;
});
def('COUNTBLANK', 'range', 'Statistics', 1, 1, 'Counts blank cells (and empty text).', (c) => {
  const r = rangeArg(c, 0);
  let filled = 0;
  c.ctx.forEachOccupied(r, (v) => {
    if (v !== '') filled++;
  });
  return height(r) * width(r) - filled;
});
def('STDEV', 'number1, [number2], …', 'Statistics', 1, MANY, 'Sample standard deviation.', (c) => Math.sqrt(variance(numbers(c), true)));
def('STDEV.S', 'number1, [number2], …', 'Statistics', 1, MANY, 'Sample standard deviation.', (c) => Math.sqrt(variance(numbers(c), true)));
def('STDEV.P', 'number1, [number2], …', 'Statistics', 1, MANY, 'Population standard deviation.', (c) => Math.sqrt(variance(numbers(c), false)));
def('VAR', 'number1, [number2], …', 'Statistics', 1, MANY, 'Sample variance.', (c) => variance(numbers(c), true));
def('VAR.S', 'number1, [number2], …', 'Statistics', 1, MANY, 'Sample variance.', (c) => variance(numbers(c), true));
def('VAR.P', 'number1, [number2], …', 'Statistics', 1, MANY, 'Population variance.', (c) => variance(numbers(c), false));
def('LARGE', 'array, k', 'Statistics', 2, 2, 'The k-th largest number.', (c) => {
  const xs = numbers(c, [c.args[0]]).sort((a, b) => b - a);
  const k = Math.ceil(num(c, 1));
  if (k < 1 || k > xs.length) throw ERR['#NUM!'];
  return xs[k - 1];
});
def('SMALL', 'array, k', 'Statistics', 2, 2, 'The k-th smallest number.', (c) => {
  const xs = numbers(c, [c.args[0]]).sort((a, b) => a - b);
  const k = Math.ceil(num(c, 1));
  if (k < 1 || k > xs.length) throw ERR['#NUM!'];
  return xs[k - 1];
});
def('RANK', 'number, ref, [order]', 'Statistics', 2, 3, 'Rank of a number in a list; 0 = descending (default), 1 = ascending.', (c) => {
  const x = num(c, 0);
  const xs = numbers(c, [c.args[1]]);
  const asc = num(c, 2, 0) !== 0;
  if (!xs.includes(x)) throw ERR['#N/A'];
  return 1 + xs.filter((v) => (asc ? v < x : v > x)).length;
});

// Logic ---------------------------------------------------------------------------------------
def('IF', 'condition, [if_true], [if_false]', 'Logic', 1, 3, 'Chooses between two values.', (c) => {
  const cond = toBool(scalarArg(c, 0));
  const pick = cond ? 1 : 2;
  const a = c.args[pick];
  if (a === undefined) return cond;
  if (a.t === 'empty') return 0;
  return c.scalar(a);
});
def('IFS', 'condition1, value1, [condition2, value2], …', 'Logic', 2, MANY, 'The value for the first condition that is TRUE.', (c) => {
  if (c.args.length % 2) throw new CellError('#VALUE!', 'IFS needs condition/value pairs.');
  for (let i = 0; i < c.args.length; i += 2) if (toBool(scalarArg(c, i))) return scalarArg(c, i + 1);
  throw new CellError('#N/A', 'None of the conditions is TRUE.');
});
def('IFERROR', 'value, value_if_error', 'Logic', 2, 2, 'A fallback when the value is an error.', (c) => {
  const v = attempt(c, c.args[0]);
  return isError(v) ? scalarArg(c, 1) : v;
});
def('IFNA', 'value, value_if_na', 'Logic', 2, 2, 'A fallback when the value is #N/A.', (c) => {
  const v = attempt(c, c.args[0]);
  return isError(v) && v.code === '#N/A' ? scalarArg(c, 1) : v;
});
function logical(c: Call, combine: (acc: boolean[], v: boolean) => void): boolean[] {
  const acc: boolean[] = [];
  eachValue(c, (v, fromRef) => {
    if (isError(v)) throw v;
    if (typeof v === 'boolean' || typeof v === 'number') combine(acc, toBool(v));
    else if (!fromRef && typeof v === 'string') combine(acc, toBool(v));
  });
  if (acc.length === 0) throw new CellError('#VALUE!', 'There are no TRUE/FALSE values to combine.');
  return acc;
}
def('AND', 'logical1, [logical2], …', 'Logic', 1, MANY, 'TRUE if every argument is TRUE.', (c) => logical(c, (a, v) => a.push(v)).every(Boolean));
def('OR', 'logical1, [logical2], …', 'Logic', 1, MANY, 'TRUE if any argument is TRUE.', (c) => logical(c, (a, v) => a.push(v)).some(Boolean));
def('XOR', 'logical1, [logical2], …', 'Logic', 1, MANY, 'TRUE if an odd number of arguments are TRUE.', (c) => logical(c, (a, v) => a.push(v)).filter(Boolean).length % 2 === 1);
def('NOT', 'logical', 'Logic', 1, 1, 'Reverses TRUE and FALSE.', (c) => !toBool(scalarArg(c, 0)));
def('TRUE', '', 'Logic', 0, 0, 'The value TRUE.', () => true);
def('FALSE', '', 'Logic', 0, 0, 'The value FALSE.', () => false);
def('CHOOSE', 'index, value1, [value2], …', 'Logic', 2, MANY, 'Picks a value by position.', (c) => {
  const i = Math.floor(num(c, 0));
  if (i < 1 || i >= c.args.length) throw new CellError('#VALUE!', `CHOOSE has no option number ${i}.`);
  return scalarArg(c, i);
});
def('SWITCH', 'expression, value1, result1, …, [default]', 'Logic', 3, MANY, 'Compares a value against a list and returns the matching result.', (c) => {
  const x = scalarArg(c, 0);
  const n = c.args.length - 1;
  for (let i = 1; i + 1 < c.args.length; i += 2) {
    const v = scalarArg(c, i);
    if (sameType(x, v) && compare(x, v) === 0) return scalarArg(c, i + 1);
  }
  if (n % 2 === 1) return scalarArg(c, c.args.length - 1);
  throw new CellError('#N/A', 'No case matched and there is no default.');
});

// Text ----------------------------------------------------------------------------------------
function joinAll(c: Call, args: Expr[], sep: string, skipEmpty: boolean): string {
  const parts: string[] = [];
  const push = (x: Scalar): void => {
    if (isError(x)) throw x;
    const s = toText(x);
    if (!(skipEmpty && s === '')) parts.push(s);
  };
  for (const a of args) {
    const v = a.t === 'ref' ? c.ctx.get(a.row, a.col) : c.ev(a);
    if (!isRangeVal(v)) {
      push(v);
      continue;
    }
    const r = v.r;
    if (skipEmpty || sep === '') {
      // Blank cells add nothing, so only the occupied ones need visiting.
      c.ctx.forEachOccupied(r, push);
      continue;
    }
    // TEXTJOIN with ignore_empty FALSE puts a delimiter around every blank, so every position counts.
    if (height(r) * width(r) > 32767) throw new CellError('#VALUE!', 'The result would be longer than 32,767 characters.');
    for (let i = r.r1; i <= r.r2; i++) for (let j = r.c1; j <= r.c2; j++) push(c.ctx.get(i, j));
  }
  return parts.join(sep);
}
def('CONCAT', 'text1, [text2], …', 'Text', 1, MANY, 'Joins text, including whole ranges.', (c) => joinAll(c, c.args, '', false));
def('CONCATENATE', 'text1, [text2], …', 'Text', 1, MANY, 'Joins text.', (c) => joinAll(c, c.args, '', false));
def('TEXTJOIN', 'delimiter, ignore_empty, text1, …', 'Text', 3, MANY, 'Joins text with a delimiter between items.', (c) => joinAll(c, c.args.slice(2), text(c, 0), bool(c, 1, true)));
def('LEN', 'text', 'Text', 1, 1, 'Number of characters.', (c) => text(c, 0).length);
def('UPPER', 'text', 'Text', 1, 1, 'Converts to upper case.', (c) => text(c, 0).toUpperCase());
def('LOWER', 'text', 'Text', 1, 1, 'Converts to lower case.', (c) => text(c, 0).toLowerCase());
def('PROPER', 'text', 'Text', 1, 1, 'Capitalises each word.', (c) => text(c, 0).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()));
def('LEFT', 'text, [count]', 'Text', 1, 2, 'The first characters.', (c) => {
  const n = num(c, 1, 1);
  if (n < 0) throw ERR['#VALUE!'];
  return text(c, 0).slice(0, Math.floor(n));
});
def('RIGHT', 'text, [count]', 'Text', 1, 2, 'The last characters.', (c) => {
  const n = Math.floor(num(c, 1, 1));
  if (n < 0) throw ERR['#VALUE!'];
  const s = text(c, 0);
  return n === 0 ? '' : s.slice(-n);
});
def('MID', 'text, start, count', 'Text', 3, 3, 'Characters from the middle.', (c) => {
  const start = Math.floor(num(c, 1));
  const n = Math.floor(num(c, 2));
  if (start < 1 || n < 0) throw ERR['#VALUE!'];
  return text(c, 0).substr(start - 1, n);
});
def('TRIM', 'text', 'Text', 1, 1, 'Removes extra spaces.', (c) => text(c, 0).trim().replace(/ {2,}/g, ' '));
def('REPT', 'text, times', 'Text', 2, 2, 'Repeats text.', (c) => {
  const n = Math.floor(num(c, 1));
  if (n < 0 || n > 32767) throw ERR['#VALUE!'];
  return text(c, 0).repeat(n);
});
def('SUBSTITUTE', 'text, old, new, [instance]', 'Text', 3, 4, 'Replaces occurrences of some text.', (c) => {
  const s = text(c, 0);
  const from = text(c, 1);
  const to = text(c, 2);
  if (from === '') return s;
  if (c.args[3] === undefined || c.args[3].t === 'empty') return s.split(from).join(to);
  const nth = Math.floor(num(c, 3));
  if (nth < 1) throw ERR['#VALUE!'];
  let idx = -1;
  for (let k = 0; k < nth; k++) {
    idx = s.indexOf(from, idx + 1);
    if (idx < 0) return s;
  }
  return s.slice(0, idx) + to + s.slice(idx + from.length);
});
def('FIND', 'find, within, [start]', 'Text', 2, 3, 'Position of text, case-sensitive.', (c) => {
  const start = Math.floor(num(c, 2, 1));
  const within = text(c, 1);
  if (start < 1 || start > within.length + 1) throw ERR['#VALUE!'];
  const i = within.indexOf(text(c, 0), start - 1);
  if (i < 0) throw new CellError('#VALUE!', 'The text was not found.');
  return i + 1;
});
def('SEARCH', 'find, within, [start]', 'Text', 2, 3, 'Position of text, ignoring case; * and ? are wildcards.', (c) => {
  const start = Math.floor(num(c, 2, 1));
  const within = text(c, 1);
  if (start < 1 || start > within.length + 1) throw ERR['#VALUE!'];
  const pattern = wildcard(text(c, 0)).source.slice(1, -1);
  const m = new RegExp(pattern, 'is').exec(within.slice(start - 1));
  if (!m) throw new CellError('#VALUE!', 'The text was not found.');
  return m.index + start;
});
def('EXACT', 'text1, text2', 'Text', 2, 2, 'TRUE if two texts are identical, case included.', (c) => text(c, 0) === text(c, 1));
def('VALUE', 'text', 'Text', 1, 1, 'Converts text to a number.', (c) => {
  const v = scalarArg(c, 0);
  return toNumber(typeof v === 'string' ? v.replace(/,/g, '') : v);
});
def('TEXT', 'value, format', 'Text', 2, 2, 'Formats a number, e.g. "0.00", "#,##0", "0%".', (c) => formatText(scalarArg(c, 0), text(c, 1)));

// Lookup --------------------------------------------------------------------------------------
def('VLOOKUP', 'lookup_value, table, column, [approximate]', 'Lookup', 3, 4, 'Finds a value in the first column of a table and returns a cell from the same row.', (c) => {
  const target = scalarArg(c, 0);
  const t = rangeArg(c, 1);
  const col = Math.floor(num(c, 2));
  if (col < 1) throw ERR['#VALUE!'];
  if (col > width(t)) throw new CellError('#REF!', `The table has only ${width(t)} columns.`);
  const approx = bool(c, 3, true);
  const i = findInLine(c, colLine(t), target, approx ? 1 : 0);
  if (i < 0) throw new CellError('#N/A', `${displayValue(target)} was not found.`);
  return c.ctx.get(t.r1 + i, t.c1 + col - 1);
});
def('HLOOKUP', 'lookup_value, table, row, [approximate]', 'Lookup', 3, 4, 'Finds a value in the first row of a table and returns a cell from the same column.', (c) => {
  const target = scalarArg(c, 0);
  const t = rangeArg(c, 1);
  const row = Math.floor(num(c, 2));
  if (row < 1) throw ERR['#VALUE!'];
  if (row > height(t)) throw new CellError('#REF!', `The table has only ${height(t)} rows.`);
  const approx = bool(c, 3, true);
  const i = findInLine(c, rowLine(t), target, approx ? 1 : 0);
  if (i < 0) throw new CellError('#N/A', `${displayValue(target)} was not found.`);
  return c.ctx.get(t.r1 + row - 1, t.c1 + i);
});
def('MATCH', 'lookup_value, range, [match_type]', 'Lookup', 2, 3, 'Position of a value in a row or column. 0 = exact, 1 = largest ≤, -1 = smallest ≥.', (c) => {
  const target = scalarArg(c, 0);
  const r = rangeArg(c, 1);
  const vertical = width(r) === 1;
  if (!vertical && height(r) !== 1) throw new CellError('#N/A', 'MATCH needs a single row or column.');
  const mode = Math.sign(num(c, 2, 1));
  const i = findInLine(c, vertical ? colLine(r) : rowLine(r), target, mode);
  if (i < 0) throw new CellError('#N/A', `${displayValue(target)} was not found.`);
  return i + 1;
});
def('INDEX', 'range, row, [column]', 'Lookup', 2, 3, 'The cell at a row and column inside a range.', (c) => {
  const r = rangeArg(c, 0);
  let row = Math.floor(num(c, 1));
  let col = Math.floor(num(c, 2, 1));
  if (height(r) === 1 && (c.args[2] === undefined || c.args[2].t === 'empty')) {
    col = row;
    row = 1;
  }
  if (row < 1 || col < 1) throw new CellError('#VALUE!', 'INDEX positions start at 1.');
  if (row > height(r) || col > width(r)) throw new CellError('#REF!', 'The position is outside the range.');
  return c.ctx.get(r.r1 + row - 1, r.c1 + col - 1);
});
def('XLOOKUP', 'lookup_value, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]', 'Lookup', 3, 6, 'Finds a value and returns the matching cell from another range. match_mode: 0 exact, -1 next smaller, 1 next larger, 2 wildcard.', (c) => {
  const target = scalarArg(c, 0);
  const look = rangeArg(c, 1);
  const ret = rangeArg(c, 2);
  const vertical = width(look) === 1;
  if (!vertical && height(look) !== 1) throw new CellError('#VALUE!', 'The lookup range must be a single row or column.');
  const len = vertical ? height(look) : width(look);
  if ((vertical ? height(ret) : width(ret)) !== len) throw new CellError('#VALUE!', 'The lookup and return ranges must be the same length.');
  const mode = Math.trunc(num(c, 4, 0));
  const reverse = num(c, 5, 1) < 0;
  const occupied: Array<[number, Scalar]> = [];
  lineCells(c, look, (k, v) => {
    occupied.push([k, v]);
  });
  if (reverse) occupied.reverse();
  const eq = lookupEquals(target, mode === 2);
  let found = -1;
  let bestVal: Scalar = null;
  for (const [k, v] of occupied) {
    if (eq(v)) {
      found = k;
      break;
    }
    if ((mode === -1 || mode === 1) && sameType(v, target)) {
      const cmp = compare(v, target);
      const better = bestVal === null || (mode === -1 ? compare(v, bestVal) > 0 : compare(v, bestVal) < 0);
      if ((mode === -1 ? cmp < 0 : cmp > 0) && better) {
        bestVal = v;
        found = k;
      }
    }
  }
  if (found < 0) {
    if (c.args[3] !== undefined && c.args[3].t !== 'empty') return c.scalar(c.args[3]);
    throw new CellError('#N/A', `${displayValue(target)} was not found.`);
  }
  return vertical ? c.ctx.get(ret.r1 + found, ret.c1) : c.ctx.get(ret.r1, ret.c1 + found);
});
def('ROW', '[reference]', 'Lookup', 0, 1, 'Row number of a reference, or of this cell.', (c) => {
  const a = c.args[0];
  if (a === undefined || a.t === 'empty') return c.ctx.row + 1;
  return rangeArg(c, 0).r1 + 1;
});
def('COLUMN', '[reference]', 'Lookup', 0, 1, 'Column number of a reference, or of this cell.', (c) => {
  const a = c.args[0];
  if (a === undefined || a.t === 'empty') return c.ctx.col + 1;
  return rangeArg(c, 0).c1 + 1;
});
def('ROWS', 'range', 'Lookup', 1, 1, 'Number of rows in a range.', (c) => height(rangeArg(c, 0)));
def('COLUMNS', 'range', 'Lookup', 1, 1, 'Number of columns in a range.', (c) => width(rangeArg(c, 0)));

// Conditional ---------------------------------------------------------------------------------
def('SUMIF', 'range, criteria, [sum_range]', 'Conditional', 2, 3, 'Adds the cells that meet a condition, e.g. ">100" or "Paid".', (c) => {
  const r = rangeArg(c, 0);
  const match = criteria(scalarArg(c, 1));
  const s = c.args[2] && c.args[2].t !== 'empty' ? rangeArg(c, 2) : r;
  let total = 0;
  scanCriteria(c, [[r, match]], [s], (i, j) => {
    const v = c.ctx.get(s.r1 + i, s.c1 + j);
    if (isError(v)) throw v;
    if (typeof v === 'number') total += v;
  });
  return total;
});
def('COUNTIF', 'range, criteria', 'Conditional', 2, 2, 'Counts the cells that meet a condition.', (c) => {
  let n = 0;
  const blanks = scanCriteria(c, [[rangeArg(c, 0), criteria(scalarArg(c, 1))]], [], () => n++);
  return n + blanks;
});
def('AVERAGEIF', 'range, criteria, [average_range]', 'Conditional', 2, 3, 'Averages the cells that meet a condition.', (c) => {
  const r = rangeArg(c, 0);
  const s = c.args[2] && c.args[2].t !== 'empty' ? rangeArg(c, 2) : r;
  const xs: number[] = [];
  scanCriteria(c, [[r, criteria(scalarArg(c, 1))]], [s], (i, j) => {
    const v = c.ctx.get(s.r1 + i, s.c1 + j);
    if (isError(v)) throw v;
    if (typeof v === 'number') xs.push(v);
  });
  return mean(xs);
});
function ifsCollect(c: Call): number[] {
  const target = rangeArg(c, 0);
  const pairs = ifsPairs(c, 1);
  if (height(target) !== height(pairs[0][0]) || width(target) !== width(pairs[0][0]))
    throw new CellError('#VALUE!', 'The value range and criteria ranges must be the same size.');
  const xs: number[] = [];
  scanCriteria(c, pairs, [target], (i, j) => {
    const v = c.ctx.get(target.r1 + i, target.c1 + j);
    if (isError(v)) throw v;
    if (typeof v === 'number') xs.push(v);
  });
  return xs;
}
def('SUMIFS', 'sum_range, criteria_range1, criteria1, …', 'Conditional', 3, MANY, 'Adds the cells that meet every condition.', (c) => ifsCollect(c).reduce((a, b) => a + b, 0));
def('AVERAGEIFS', 'average_range, criteria_range1, criteria1, …', 'Conditional', 3, MANY, 'Averages the cells that meet every condition.', (c) => mean(ifsCollect(c)));
def('MAXIFS', 'max_range, criteria_range1, criteria1, …', 'Conditional', 3, MANY, 'Largest value among the cells that meet every condition.', (c) => {
  const xs = ifsCollect(c);
  return xs.length ? Math.max(...xs) : 0;
});
def('MINIFS', 'min_range, criteria_range1, criteria1, …', 'Conditional', 3, MANY, 'Smallest value among the cells that meet every condition.', (c) => {
  const xs = ifsCollect(c);
  return xs.length ? Math.min(...xs) : 0;
});
def('COUNTIFS', 'criteria_range1, criteria1, …', 'Conditional', 2, MANY, 'Counts the cells that meet every condition.', (c) => {
  let n = 0;
  const blanks = scanCriteria(c, ifsPairs(c, 0), [], () => n++);
  return n + blanks;
});

// Information ---------------------------------------------------------------------------------
def('ISBLANK', 'value', 'Information', 1, 1, 'TRUE if the cell is empty.', (c) => attempt(c, c.args[0]) === null);
def('ISNUMBER', 'value', 'Information', 1, 1, 'TRUE for a number.', (c) => typeof attempt(c, c.args[0]) === 'number');
def('ISTEXT', 'value', 'Information', 1, 1, 'TRUE for text.', (c) => typeof attempt(c, c.args[0]) === 'string');
def('ISLOGICAL', 'value', 'Information', 1, 1, 'TRUE for TRUE or FALSE.', (c) => typeof attempt(c, c.args[0]) === 'boolean');
def('ISERROR', 'value', 'Information', 1, 1, 'TRUE for any error.', (c) => isError(attempt(c, c.args[0])));
def('ISNA', 'value', 'Information', 1, 1, 'TRUE for #N/A.', (c) => {
  const v = attempt(c, c.args[0]);
  return isError(v) && v.code === '#N/A';
});
def('NA', '', 'Information', 0, 0, 'The #N/A error, for "no value yet".', () => {
  throw ERR['#N/A'];
});

// Finance -------------------------------------------------------------------------------------
def('PMT', 'rate, periods, present_value, [future_value], [type]', 'Finance', 3, 5, 'Payment per period for a loan with a fixed rate.', (c) => pmt(num(c, 0), num(c, 1), num(c, 2), num(c, 3, 0), num(c, 4, 0) ? 1 : 0));
def('FV', 'rate, periods, payment, [present_value], [type]', 'Finance', 3, 5, 'Future value of an investment.', (c) => fvOf(num(c, 0), num(c, 1), num(c, 2), num(c, 3, 0), num(c, 4, 0) ? 1 : 0));
def('PV', 'rate, periods, payment, [future_value], [type]', 'Finance', 3, 5, 'Present value of a series of payments.', (c) => pvOf(num(c, 0), num(c, 1), num(c, 2), num(c, 3, 0), num(c, 4, 0) ? 1 : 0));
def('NPER', 'rate, payment, present_value, [future_value], [type]', 'Finance', 3, 5, 'Number of periods to pay off a loan.', (c) => {
  const r = num(c, 0);
  const p = num(c, 1);
  const pv = num(c, 2);
  const fv = num(c, 3, 0);
  const t = num(c, 4, 0) ? 1 : 0;
  if (r === 0) {
    if (p === 0) throw ERR['#NUM!'];
    return -(pv + fv) / p;
  }
  const a = p * (1 + r * t) - fv * r;
  const b = p * (1 + r * t) + pv * r;
  if (a / b <= 0) throw ERR['#NUM!'];
  return Math.log(a / b) / Math.log(1 + r);
});
def('RATE', 'periods, payment, present_value, [future_value], [type], [guess]', 'Finance', 3, 6, 'Interest rate per period, found by iteration.', (c) => {
  const n = num(c, 0);
  const p = num(c, 1);
  const pv = num(c, 2);
  const fv = num(c, 3, 0);
  const t = num(c, 4, 0) ? 1 : 0;
  return solve((r) => (Math.abs(r) < 1e-12 ? pv + p * n + fv : pv * (1 + r) ** n + (p * (1 + r * t) * ((1 + r) ** n - 1)) / r + fv), num(c, 5, 0.1));
});
def('NPV', 'rate, value1, [value2], …', 'Finance', 2, MANY, 'Net present value of future cash flows.', (c) => {
  const r = num(c, 0);
  return numbers(c, c.args.slice(1)).reduce((acc, v, i) => acc + v / (1 + r) ** (i + 1), 0);
});
def('IRR', 'values, [guess]', 'Finance', 1, 2, 'Internal rate of return of a series of cash flows.', (c) => {
  const flows = numbers(c, [c.args[0]]);
  if (!flows.some((v) => v > 0) || !flows.some((v) => v < 0)) throw new CellError('#NUM!', 'IRR needs at least one positive and one negative cash flow.');
  return solve((r) => flows.reduce((acc, v, i) => acc + v / (1 + r) ** i, 0), num(c, 1, 0.1));
});

export const FUNCTIONS: ReadonlyMap<string, FnDef> = new Map(defs.map((d) => [d.name, d]));
export const FUNCTION_LIST: readonly FnDef[] = [...defs].sort((a, b) => a.name.localeCompare(b.name));
