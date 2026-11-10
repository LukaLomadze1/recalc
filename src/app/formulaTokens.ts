// What the formula bar needs from the lexer: coloured segments, the ranges each colour stands for (so
// the grid can outline them), the function call the caret is inside, and completion candidates.

import { normalize, rangeLabel, type Range } from '../engine/address.ts';
import { FUNCTION_LIST, FUNCTIONS, type FnDef } from '../engine/functions.ts';
import { lex, type Token } from '../engine/lexer.ts';

export type SegmentKind = 'ref' | 'func' | 'num' | 'str' | 'op' | 'err' | 'bool' | 'paren' | 'name' | 'bad' | 'plain';

export interface Segment {
  text: string;
  kind: SegmentKind;
  /** For references: index into the reference colour palette. */
  color?: number;
}

export interface Highlighted {
  segments: Segment[];
  refs: Array<{ r: Range; color: number }>;
}

export const REF_PALETTE_SIZE = 8;

export function highlight(raw: string): Highlighted {
  if (!raw.startsWith('=')) return { segments: [{ text: raw, kind: 'plain' }], refs: [] };
  const body = raw.slice(1);
  const toks = lex(body);
  const segments: Segment[] = [{ text: '=', kind: 'op' }];
  const refs: Array<{ r: Range; color: number }> = [];
  const colorOf = new Map<string, number>();
  let last = 0;
  const gap = (to: number): void => {
    if (to > last) segments.push({ text: body.slice(last, to), kind: 'plain' });
  };
  const addRef = (r: Range, start: number, end: number): void => {
    const label = rangeLabel(r);
    let color = colorOf.get(label);
    if (color === undefined) {
      color = colorOf.size % REF_PALETTE_SIZE;
      colorOf.set(label, color);
      refs.push({ r, color });
    }
    gap(start);
    segments.push({ text: body.slice(start, end), kind: 'ref', color });
    last = end;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'eof') break;
    if (t.t === 'ref') {
      const colon = toks[i + 1];
      const end = toks[i + 2];
      if (colon?.t === ':' && end?.t === 'ref') {
        addRef(normalize(t.v, end.v), t.start, end.end);
        i += 2;
        continue;
      }
      addRef(normalize(t.v, t.v), t.start, t.end);
      continue;
    }
    if (t.t === 'cols') {
      addRef({ r1: 0, r2: 1_048_575, c1: Math.min(t.v.c1, t.v.c2), c2: Math.max(t.v.c1, t.v.c2) }, t.start, t.end);
      continue;
    }
    gap(t.start);
    segments.push({ text: body.slice(t.start, t.end), kind: kindOf(t) });
    last = t.end;
  }
  gap(body.length);
  return { segments, refs };
}

function kindOf(t: Token): SegmentKind {
  switch (t.t) {
    case 'func':
      return FUNCTIONS.has(t.v) ? 'func' : 'bad';
    case 'num':
      return 'num';
    case 'str':
      return 'str';
    case 'bool':
      return 'bool';
    case 'err':
      return 'err';
    case 'op':
    case ',':
    case ':':
      return 'op';
    case '(':
    case ')':
      return 'paren';
    case 'name':
      return 'name';
    case 'bad':
      return 'bad';
    default:
      return 'plain';
  }
}

/** The innermost function call around the caret, and which argument the caret is in. */
export function activeCall(raw: string, caret: number): { fn: FnDef; arg: number } | null {
  if (!raw.startsWith('=') || caret < 1) return null;
  // The lexer always emits a function's name immediately before its "(".
  const stack: Array<{ name: string | null; arg: number }> = [];
  let pending: string | null = null;
  for (const t of lex(raw.slice(1, caret))) {
    if (t.t === 'func') {
      pending = t.v;
      continue;
    }
    if (t.t === '(') stack.push({ name: pending, arg: 0 });
    else if (t.t === ',' && stack.length) stack[stack.length - 1].arg++;
    else if (t.t === ')') stack.pop();
    pending = null;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const name = stack[i].name;
    if (name === null) continue;
    const fn = FUNCTIONS.get(name);
    return fn ? { fn, arg: stack[i].arg } : null;
  }
  return null;
}

/** The identifier being typed at the caret, if a function name could go there. */
export function completionAt(raw: string, caret: number): { start: number; matches: FnDef[] } | null {
  if (!raw.startsWith('=')) return null;
  const before = raw.slice(0, caret);
  if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return null; // inside a string
  const m = /[A-Za-z][A-Za-z0-9.]*$/.exec(before);
  if (!m) return null;
  const prev = before[m.index - 1];
  if (prev !== undefined && /[A-Za-z0-9$_.]/.test(prev)) return null;
  if (/[(]/.test(raw[caret] ?? '')) return null;
  const prefix = m[0].toUpperCase();
  const matches = FUNCTION_LIST.filter((f) => f.name.startsWith(prefix)).slice(0, 8);
  if (matches.length === 0 || (matches.length === 1 && matches[0].name === prefix)) return null;
  return { start: m.index, matches };
}

/** True when clicking a cell while editing should insert a reference at the caret. */
export function canInsertRef(raw: string, caret: number): boolean {
  if (!raw.startsWith('=')) return false;
  const before = raw.slice(0, caret).trimEnd();
  if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return false;
  const last = before[before.length - 1];
  return last === undefined || '=(,+-*/^&<>:%'.includes(last);
}

/** Closes any brackets left open, as Excel does when you press Enter. */
export function autoClose(raw: string): string {
  if (!raw.startsWith('=')) return raw;
  let depth = 0;
  for (const t of lex(raw.slice(1))) {
    if (t.t === '(') depth++;
    else if (t.t === 'func') continue;
    else if (t.t === ')') depth--;
    if (t.t === 'bad') return raw;
  }
  return depth > 0 ? raw + ')'.repeat(depth) : raw;
}
