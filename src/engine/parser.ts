// A Pratt parser for Excel's formula language. It produces a small AST that the evaluator walks
// and the dependency graph reads its references from.

import { MAX_COLS, MAX_ROWS, type Range } from './address.ts';
import { lex, type Token } from './lexer.ts';
import type { ErrorCode } from './values.ts';

export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrorCode }
  | { t: 'ref'; row: number; col: number }
  | { t: 'range'; r: Range }
  | { t: 'neg' | 'pos' | 'pct'; e: Expr }
  | { t: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'name'; name: string }
  | { t: 'empty' };

export class ParseError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(message);
    this.at = at;
  }
}

// Binding power, lowest first. Excel puts unary minus above ^, so -2^2 is 4, and ^ is left-associative.
const INFIX: Record<string, number> = {
  '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '&': 20,
  '+': 30, '-': 30,
  '*': 40, '/': 40,
  '^': 50,
};
const POSTFIX_PCT = 60;
const PREFIX = 70;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private fail(tok: Token, message?: string): never {
    if (tok.t === 'bad') throw new ParseError(tok.v, tok.start);
    if (tok.t === 'eof') throw new ParseError(message ?? 'The formula ends too early.', tok.start);
    throw new ParseError(message ?? `Unexpected "${describe(tok)}".`, tok.start);
  }

  parseFormula(): Expr {
    if (this.peek().t === 'eof') this.fail(this.peek(), 'The formula is empty.');
    const e = this.expr(0);
    const tok = this.peek();
    if (tok.t !== 'eof') this.fail(tok, tok.t === ')' ? 'There is an extra closing bracket.' : undefined);
    return e;
  }

  private expr(minBp: number): Expr {
    let left = this.prefix();
    for (;;) {
      const tok = this.peek();
      if (tok.t !== 'op') break;
      if (tok.v === '%') {
        if (POSTFIX_PCT < minBp) break;
        this.next();
        left = { t: 'pct', e: left };
        continue;
      }
      const bp = INFIX[tok.v];
      if (bp === undefined || bp <= minBp) break;
      this.next();
      const right = this.expr(bp);
      left = { t: 'bin', op: tok.v as BinOp, a: left, b: right };
    }
    return left;
  }

  private prefix(): Expr {
    const tok = this.next();
    switch (tok.t) {
      case 'num':
        return { t: 'num', v: tok.v };
      case 'str':
        return { t: 'str', v: tok.v };
      case 'bool':
        return { t: 'bool', v: tok.v };
      case 'err':
        return { t: 'err', v: tok.v };
      case 'cols':
        return { t: 'range', r: { r1: 0, r2: MAX_ROWS - 1, c1: Math.min(tok.v.c1, tok.v.c2), c2: Math.max(tok.v.c1, tok.v.c2) } };
      case 'ref': {
        if (this.peek().t === ':') {
          this.next();
          const end = this.next();
          if (end.t !== 'ref') this.fail(end, 'A range needs a cell on both sides of ":", like A1:B5.');
          const a = tok.v;
          const b = end.v;
          return {
            t: 'range',
            r: { r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row), c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) },
          };
        }
        return { t: 'ref', row: tok.v.row, col: tok.v.col };
      }
      case 'func':
        return this.call(tok.v);
      case 'name':
        return { t: 'name', name: tok.v };
      case '(': {
        const e = this.expr(0);
        const close = this.next();
        if (close.t !== ')') this.fail(close, 'A closing bracket is missing.');
        return e;
      }
      case 'op':
        if (tok.v === '-') return { t: 'neg', e: this.expr(PREFIX) };
        if (tok.v === '+') return { t: 'pos', e: this.expr(PREFIX) };
        return this.fail(tok);
      default:
        return this.fail(tok);
    }
  }

  private call(name: string): Expr {
    this.next(); // the "(" the lexer saw
    const args: Expr[] = [];
    if (this.peek().t === ')') {
      this.next();
      return { t: 'call', name, args };
    }
    for (;;) {
      const t = this.peek().t;
      // An omitted argument, as in IF(A1,,3) or ROUND(A1,).
      args.push(t === ',' || t === ')' ? { t: 'empty' } : this.expr(0));
      const sep = this.next();
      if (sep.t === ')') return { t: 'call', name, args };
      if (sep.t !== ',') this.fail(sep, sep.t === 'eof' ? `${name}( is missing its closing bracket.` : undefined);
    }
  }
}

function describe(tok: Token): string {
  if (tok.t === 'eof') return 'end of formula';
  return String(tok.v);
}

/** Parses the body of a formula, i.e. the text after "=". Throws ParseError. */
export function parse(body: string): Expr {
  return new Parser(lex(body)).parseFormula();
}

export interface Precedents {
  cells: Array<{ row: number; col: number }>;
  ranges: Range[];
}

/** Every cell and range a formula reads. Static: the graph never depends on the values. */
export function precedents(e: Expr): Precedents {
  const out: Precedents = { cells: [], ranges: [] };
  const seen = new Set<string>();
  const walk = (x: Expr): void => {
    switch (x.t) {
      case 'ref': {
        const k = `${x.row},${x.col}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.cells.push({ row: x.row, col: x.col });
        }
        return;
      }
      case 'range': {
        const k = `${x.r.r1},${x.r.c1},${x.r.r2},${x.r.c2}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.ranges.push(x.r);
        }
        return;
      }
      case 'neg':
      case 'pos':
      case 'pct':
        return walk(x.e);
      case 'bin':
        walk(x.a);
        walk(x.b);
        return;
      case 'call':
        x.args.forEach(walk);
        if ((x.name === 'SUMIF' || x.name === 'AVERAGEIF') && x.args.length === 3) {
          const resized = resizedSumRange(x.args[0], x.args[2]);
          if (resized) walk({ t: 'range', r: resized });
        }
        return;
      default:
        return;
    }
  };
  walk(e);
  return out;
}

const asRange = (x: Expr): Range | null =>
  x.t === 'range' ? x.r : x.t === 'ref' ? { r1: x.row, c1: x.col, r2: x.row, c2: x.col } : null;

/**
 * SUMIF(A1:A10, ">0", B1) sums B1:B10: Excel stretches the sum range to the shape of the criteria
 * range, from its top-left corner. So the cells it really reads are not the ones written in the
 * formula, and the graph has to know. (Found by the fuzzer: the stale value was in C20001 on seed 13.)
 */
function resizedSumRange(criteria: Expr, sum: Expr): Range | null {
  const c = asRange(criteria);
  const s = asRange(sum);
  if (!c || !s) return null;
  return {
    r1: s.r1,
    c1: s.c1,
    r2: Math.min(s.r1 + (c.r2 - c.r1), MAX_ROWS - 1),
    c2: Math.min(s.c1 + (c.c2 - c.c1), MAX_COLS - 1),
  };
}
