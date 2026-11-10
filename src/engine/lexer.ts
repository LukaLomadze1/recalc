// Turns formula text into tokens. Every token keeps its position, which the formula bar uses for
// syntax colouring and the copy/paste code uses to rewrite references without touching anything else.

import { colIndex, MAX_ROWS } from './address.ts';
import type { ErrorCode } from './values.ts';

export interface RefParts {
  row: number;
  col: number;
  rowAbs: boolean;
  colAbs: boolean;
}

export interface ColRangeParts {
  c1: number;
  c2: number;
  c1Abs: boolean;
  c2Abs: boolean;
}

export type Token =
  | { t: 'num'; v: number; start: number; end: number }
  | { t: 'str'; v: string; start: number; end: number }
  | { t: 'bool'; v: boolean; start: number; end: number }
  | { t: 'err'; v: ErrorCode; start: number; end: number }
  | { t: 'ref'; v: RefParts; start: number; end: number }
  | { t: 'cols'; v: ColRangeParts; start: number; end: number }
  | { t: 'func'; v: string; start: number; end: number }
  | { t: 'name'; v: string; start: number; end: number }
  | { t: 'op'; v: string; start: number; end: number }
  | { t: '(' | ')' | ',' | ':'; v: string; start: number; end: number }
  | { t: 'bad'; v: string; start: number; end: number }
  | { t: 'eof'; v: ''; start: number; end: number };

const WS = /\s+/y;
const NUM = /(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/iy;
const STR = /"((?:[^"]|"")*)"/y;
const ERRLIT = /#(DIV\/0!|N\/A|NAME\?|REF!|VALUE!|NUM!|NULL!|CYCLE!|ERROR!)/iy;
// A column range such as A:C. The lookahead stops it from eating the start of A:C5 (not valid anyway).
const COLS = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/y;
// A cell reference, as long as it is not the start of a longer name or a function call (LOG10( is a function).
const REF = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_.(])/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_.]*/y;
const FOLLOWED_BY_PAREN = /\s*\(/y;

function match(re: RegExp, src: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(src);
}

/** Tokenises a formula body (the text after "="). Never throws: unknown characters become 'bad' tokens. */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    let m: RegExpExecArray | null;
    if ((m = match(WS, src, i))) {
      i += m[0].length;
      continue;
    }
    const start = i;
    const ch = src[i];

    if ((m = match(STR, src, i))) {
      i += m[0].length;
      out.push({ t: 'str', v: m[1].replace(/""/g, '"'), start, end: i });
      continue;
    }
    if (ch === '"') {
      out.push({ t: 'bad', v: 'Unterminated text: a closing " is missing.', start, end: src.length });
      break;
    }
    if (ch === '#' && (m = match(ERRLIT, src, i))) {
      i += m[0].length;
      out.push({ t: 'err', v: m[0].toUpperCase() as ErrorCode, start, end: i });
      continue;
    }
    const code = src.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    if ((isDigit || ch === '.') && (m = match(NUM, src, i))) {
      i += m[0].length;
      out.push({ t: 'num', v: Number(m[0]), start, end: i });
      continue;
    }
    const isLetter = (code | 32) >= 97 && (code | 32) <= 122;
    if (!isLetter && ch !== '$' && ch !== '_') {
      // Not the start of a reference or a name: operators and punctuation.
    } else if ((m = match(COLS, src, i))) {
      const c1 = colIndex(m[2]);
      const c2 = colIndex(m[4]);
      if (c1 >= 0 && c2 >= 0) {
        i += m[0].length;
        out.push({ t: 'cols', v: { c1, c2, c1Abs: m[1] === '$', c2Abs: m[3] === '$' }, start, end: i });
        continue;
      }
    }
    if ((isLetter || ch === '$') && (m = match(REF, src, i))) {
      const col = colIndex(m[2]);
      const row = Number(m[4]) - 1;
      if (col >= 0 && row >= 0 && row < MAX_ROWS) {
        i += m[0].length;
        out.push({ t: 'ref', v: { row, col, colAbs: m[1] === '$', rowAbs: m[3] === '$' }, start, end: i });
        continue;
      }
    }
    if ((isLetter || ch === '_') && (m = match(IDENT, src, i))) {
      i += m[0].length;
      const word = m[0].toUpperCase();
      if (match(FOLLOWED_BY_PAREN, src, i)) out.push({ t: 'func', v: word, start, end: i });
      else if (word === 'TRUE' || word === 'FALSE') out.push({ t: 'bool', v: word === 'TRUE', start, end: i });
      else out.push({ t: 'name', v: word, start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      i += 2;
      out.push({ t: 'op', v: two, start, end: i });
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) {
      i += 1;
      out.push({ t: 'op', v: ch, start, end: i });
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ':') {
      i += 1;
      out.push({ t: ch, v: ch, start, end: i });
      continue;
    }
    i += 1;
    out.push({ t: 'bad', v: `Unexpected character "${ch}".`, start, end: i });
  }
  out.push({ t: 'eof', v: '', start: src.length, end: src.length });
  return out;
}
