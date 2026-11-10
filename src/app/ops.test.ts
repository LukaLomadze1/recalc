import { describe, expect, it } from 'vitest';
import { keyAddr, parseRange } from '../engine/address.ts';
import { keyOf, sheetOf } from '../engine/testkit.ts';
import { copyClip, fillWrites, jump, parseClipboardText, pasteWrites, selectionStats } from './ops.ts';

const named = (writes: Array<[number, string]>): Record<string, string> => Object.fromEntries(writes.map(([k, v]) => [keyAddr(k), v]));

describe('fill handle', () => {
  it('copies formulas with shifted references', () => {
    const s = sheetOf({ A1: '1', B1: '=A1*2+$A$1' });
    expect(named(fillWrites(s, parseRange('B1')!, parseRange('B1:B3')!))).toEqual({ B2: '=A2*2+$A$1', B3: '=A3*2+$A$1' });
  });

  it('continues number series, also upwards', () => {
    const s = sheetOf({ A3: '10', A4: '20' });
    expect(named(fillWrites(s, parseRange('A3:A4')!, parseRange('A1:A6')!))).toEqual({ A1: '-10', A2: '0', A5: '30', A6: '40' });
  });

  it('increments a trailing number in text, and repeats a lone number', () => {
    const s = sheetOf({ A1: 'Item 1', B1: '7', C1: 'Q09' });
    expect(named(fillWrites(s, parseRange('A1:C1')!, parseRange('A1:C3')!))).toEqual({
      A2: 'Item 2',
      A3: 'Item 3',
      B2: '7',
      B3: '7',
      C2: 'Q10',
      C3: 'Q11',
    });
  });

  it('fills sideways', () => {
    const s = sheetOf({ A1: '=A2', A2: '1' });
    expect(named(fillWrites(s, parseRange('A1')!, parseRange('A1:C1')!))).toEqual({ B1: '=B2', C1: '=C2' });
  });
});

describe('clipboard', () => {
  it('copies values as tab-separated text and formulas as raw', () => {
    const s = sheetOf({ A1: '1', B1: '=A1+1', A2: 'x' });
    const clip = copyClip(s, parseRange('A1:B2')!, false);
    expect(clip.text).toBe('1\t2\nx\t');
    expect(clip.raws).toEqual([
      ['1', '=A1+1'],
      ['x', ''],
    ]);
  });

  it('shifts copied formulas and tiles over a larger selection', () => {
    const { writes, area } = pasteWrites([['=A1']], parseRange('C3:C4')!, { row: 0, col: 1 }, true);
    expect(named(writes)).toEqual({ C3: '=B3', C4: '=B4' });
    expect(area).toEqual(parseRange('C3:C4'));
  });

  it('parses text from other programs', () => {
    expect(parseClipboardText('a\tb\r\n1\t2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('navigation and stats', () => {
  const s = sheetOf({ A1: '1', A2: '2', A3: '3', A10: '10' });
  it('Ctrl+Arrow jumps to the edges of data', () => {
    expect(jump(s, { row: 0, col: 0 }, 1, 0)).toEqual({ row: 2, col: 0 });
    expect(jump(s, { row: 2, col: 0 }, 1, 0)).toEqual({ row: 9, col: 0 });
    expect(jump(s, { row: 9, col: 0 }, 1, 0)).toEqual({ row: 1_048_575, col: 0 });
    expect(jump(s, { row: 9, col: 0 }, -1, 0)).toEqual({ row: 2, col: 0 });
    expect(jump(s, { row: 0, col: 0 }, 0, -1)).toEqual({ row: 0, col: 0 });
  });

  it('sums the selection', () => {
    expect(selectionStats(s, parseRange('A:A')!)).toMatchObject({ count: 4, numbers: 4, sum: 16, min: 1, max: 10 });
    expect(keyOf('A1')).toBe(0);
  });
});
