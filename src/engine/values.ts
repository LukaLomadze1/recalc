// What a cell can hold, and the coercion rules between types. The rules follow Excel's where it has one.

export type ErrorCode =
  | '#DIV/0!'
  | '#N/A'
  | '#NAME?'
  | '#REF!'
  | '#VALUE!'
  | '#NUM!'
  | '#NULL!'
  | '#CYCLE!'
  | '#ERROR!';

export class CellError {
  readonly code: ErrorCode;
  readonly why: string;
  /** For #CYCLE!: the keys of the cells that form the loop. */
  readonly cycle: readonly number[] | null;
  constructor(code: ErrorCode, why: string, cycle: readonly number[] | null = null) {
    this.code = code;
    this.why = why;
    this.cycle = cycle;
  }
  toString(): string {
    return this.code;
  }
}

const DEFAULT_WHY: Record<ErrorCode, string> = {
  '#DIV/0!': 'Division by zero.',
  '#N/A': 'The value was not found.',
  '#NAME?': 'Unknown function or name.',
  '#REF!': 'The reference points outside the sheet, or at cells that were deleted.',
  '#VALUE!': 'An argument has the wrong type.',
  '#NUM!': 'The result is not a usable number.',
  '#NULL!': 'Empty intersection.',
  '#CYCLE!': 'This cell depends on itself, directly or through other cells.',
  '#ERROR!': 'The formula could not be parsed.',
};

/** One shared instance per code, so errors can be compared with ===. */
export const ERR = Object.fromEntries(
  (Object.keys(DEFAULT_WHY) as ErrorCode[]).map((code) => [code, new CellError(code, DEFAULT_WHY[code])]),
) as Record<ErrorCode, CellError>;

export const ERROR_CODES = Object.keys(DEFAULT_WHY) as ErrorCode[];

/** null is a blank cell. */
export type Scalar = number | string | boolean | null | CellError;

export const isError = (v: unknown): v is CellError => v instanceof CellError;

// ---------------------------------------------------------------------------------------------
// Number display. Excel's "General" format: up to about 11 significant characters, no float noise.

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return exponential(n);
  // toPrecision(15) removes binary noise such as 0.1 + 0.2 = 0.30000000000000004.
  const clean = Number(n.toPrecision(15));
  const s = String(clean);
  if (s.includes('e')) return exponential(clean);
  if (s.replace('-', '').replace('.', '').length <= 11) return s;
  // Too long: trim decimals to fit in roughly eleven characters, as General does.
  const intDigits = Math.floor(Math.log10(abs)) + 1;
  const decimals = Math.max(0, 10 - Math.max(intDigits, 0));
  return String(Number(clean.toFixed(Math.min(decimals, 100))));
}

function exponential(n: number): string {
  const [mantissa, exp] = n.toExponential(5).split('e');
  const m = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
  const e = Number(exp);
  return `${m}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

export function displayValue(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isError(v)) return v.code;
  return v;
}

// ---------------------------------------------------------------------------------------------
// Coercion. Each function throws a CellError when the value cannot be converted, which the
// evaluator catches at the top of the formula and stores as the cell's value.

const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;

export function textToNumber(s: string): number | null {
  if (!NUMERIC_TEXT.test(s)) return null;
  return Number(s);
}

export function toNumber(v: Scalar): number {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isError(v)) throw v;
  const n = textToNumber(v);
  if (n === null) throw new CellError('#VALUE!', `Expected a number, got the text "${v}".`);
  return n;
}

export function toText(v: Scalar): string {
  if (typeof v === 'string') return v;
  if (isError(v)) throw v;
  return displayValue(v);
}

export function toBool(v: Scalar): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (isError(v)) throw v;
  const up = v.toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  throw new CellError('#VALUE!', `Expected TRUE or FALSE, got the text "${v}".`);
}

/** A finite number or a #NUM! error. */
export function checkNumber(n: number): number {
  if (!Number.isFinite(n)) throw ERR['#NUM!'];
  return n;
}

const TYPE_RANK = { number: 0, string: 1, boolean: 2 } as const;

/**
 * Excel's ordering for comparison operators: numbers < text < booleans; text is compared
 * case-insensitively; a blank takes the type of the other side.
 */
export function compare(a: Scalar, b: Scalar): number {
  if (isError(a)) throw a;
  if (isError(b)) throw b;
  if (a === null && b === null) return 0;
  if (a === null) a = blankLike(b);
  if (b === null) b = blankLike(a);
  const ta = TYPE_RANK[typeof a as 'number' | 'string' | 'boolean'];
  const tb = TYPE_RANK[typeof b as 'number' | 'string' | 'boolean'];
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (typeof a === 'number') return Math.sign(a - (b as number));
  if (typeof a === 'boolean') return Number(a) - Number(b as boolean);
  const la = (a as string).toLowerCase();
  const lb = (b as string).toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

function blankLike(other: Scalar): Scalar {
  if (typeof other === 'string') return '';
  if (typeof other === 'boolean') return false;
  return 0;
}

/** What a typed entry (not a formula) means: a number, a boolean, or text. */
export function parseLiteral(raw: string): Scalar {
  if (raw === '') return null;
  if (raw.startsWith("'")) return raw.slice(1);
  const n = textToNumber(raw);
  if (n !== null) return n;
  const up = raw.trim().toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  return raw;
}
