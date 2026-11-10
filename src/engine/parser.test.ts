import { describe, expect, it } from 'vitest';
import { addr, colIndex, colName, MAX_ROWS, parseAddress, parseRange, rangeLabel } from './address.ts';
import { lex } from './lexer.ts';
import { parse, ParseError, precedents } from './parser.ts';
import { calc } from './testkit.ts';
import { formatNumber, parseLiteral } from './values.ts';

describe('addresses', () => {
  it('converts column letters both ways across the whole sheet', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
    expect(colName(701)).toBe('ZZ');
    expect(colName(702)).toBe('AAA');
    expect(colName(16383)).toBe('XFD');
    for (let c = 0; c < 16384; c += 37) expect(colIndex(colName(c))).toBe(c);
    expect(colIndex('XFE')).toBe(-1);
    expect(colIndex('a')).toBe(0);
  });

  it('parses addresses and ranges', () => {
    expect(parseAddress('$B$3')).toEqual({ row: 2, col: 1 });
    expect(parseAddress('A0')).toBeNull();
    expect(parseAddress('A1048577')).toBeNull();
    expect(parseRange('C5:A1')).toEqual({ r1: 0, c1: 0, r2: 4, c2: 2 });
    expect(rangeLabel(parseRange('B:D')!)).toBe('B:D');
    expect(addr(MAX_ROWS - 1, 16383)).toBe('XFD1048576');
  });
});

describe('lexer', () => {
  it('tells references, functions and names apart', () => {
    const kinds = lex('LOG10(A1)+log10+$B$2:C3+A:B+SUM(x)').map((t) => t.t);
    expect(kinds).toEqual(['func', '(', 'ref', ')', 'op', 'ref', 'op', 'ref', ':', 'ref', 'op', 'cols', 'op', 'func', '(', 'name', ')', 'eof']);
  });

  it('keeps positions so references can be coloured', () => {
    const toks = lex('SUM( A1 , B2 )');
    const refs = toks.filter((t) => t.t === 'ref');
    expect(refs.map((t) => [t.start, t.end])).toEqual([
      [5, 7],
      [10, 12],
    ]);
  });

  it('handles strings with doubled quotes and error literals', () => {
    const [s, , e] = lex('"say ""hi"""&#DIV/0!');
    expect(s).toMatchObject({ t: 'str', v: 'say "hi"' });
    expect(e).toMatchObject({ t: 'err', v: '#DIV/0!' });
  });
});

describe('parser', () => {
  it('follows Excel precedence, including its unusual unary minus', () => {
    expect(calc('=1+2*3')).toBe(7);
    expect(calc('=(1+2)*3')).toBe(9);
    expect(calc('=-2^2')).toBe(4); // Excel: negation binds tighter than ^
    expect(calc('=2^3^2')).toBe(64); // and ^ is left-associative
    expect(calc('=2^-1')).toBe(0.5);
    expect(calc('=50%')).toBe(0.5);
    expect(calc('=10*20%')).toBe(2);
    expect(calc('=1+1=2')).toBe(true);
    expect(calc('="a"&1+1')).toBe('a2');
    expect(calc('=3>2=TRUE')).toBe(true);
  });

  it('reports syntax errors with a position', () => {
    for (const bad of ['1+', 'SUM(1,2', '(1', '1)', '"abc', 'A1:', '1 2', '@']) {
      expect(() => parse(bad), bad).toThrow(ParseError);
    }
    try {
      parse('1+*2');
    } catch (e) {
      expect((e as ParseError).at).toBe(2);
    }
    expect(calc('=1+')).toBe('#ERROR!');
  });

  it('supports omitted arguments', () => {
    expect(calc('=IF(FALSE,1,)')).toBe(0);
    expect(calc('=ROUND(2.5,)')).toBe(3);
  });

  it('extracts precedents once each', () => {
    const p = precedents(parse('A1+A1+SUM(B1:B3)+SUM(B3:B1)+C:C'));
    expect(p.cells).toEqual([{ row: 0, col: 0 }]);
    expect(p.ranges).toHaveLength(2);
  });
});

describe('values', () => {
  it('formats numbers like the General format', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.3333333333');
    expect(formatNumber(2 / 3)).toBe('0.6666666667');
    expect(formatNumber(1234567.891)).toBe('1234567.891');
    expect(formatNumber(123456789012)).toBe('123456789012');
    expect(formatNumber(1e20)).toBe('1E+20');
    expect(formatNumber(-0.000000000123)).toBe('-1.23E-10');
    expect(formatNumber(-5)).toBe('-5');
  });

  it('reads typed entries', () => {
    expect(parseLiteral('42')).toBe(42);
    expect(parseLiteral(' 1.5e3 ')).toBe(1500);
    expect(parseLiteral('true')).toBe(true);
    expect(parseLiteral("'42")).toBe('42');
    expect(parseLiteral('hello')).toBe('hello');
  });
});
