import { describe, expect, it } from 'vitest';
import { parseCSV, toCSV } from './csv.ts';
import { keyOf, sheetOf, val } from './testkit.ts';
import { applyStructural, diff, shiftFormula, structuralFormula } from './transform.ts';

describe('copying formulas', () => {
  it('shifts relative references and keeps absolute ones', () => {
    expect(shiftFormula('=A1+$B$1+$C1+D$1', 2, 1)).toBe('=B3+$B$1+$C3+E$1');
    expect(shiftFormula('=SUM(A1:B2)*2', 1, 0)).toBe('=SUM(A2:B3)*2');
    expect(shiftFormula('=SUM(A:A)', 5, 2)).toBe('=SUM(C:C)');
  });

  it('keeps spacing, case and strings exactly as typed', () => {
    expect(shiftFormula('=sum( a1 , "A1" )', 1, 0)).toBe('=sum( A2 , "A1" )');
  });

  it('turns references pushed off the sheet into #REF!', () => {
    expect(shiftFormula('=A1+1', -1, 0)).toBe('=#REF!+1');
    expect(shiftFormula('=SUM(A1:B2)', 0, -1)).toBe('=SUM(#REF!)');
  });

  it('leaves plain values alone', () => {
    expect(shiftFormula('A1', 1, 1)).toBe('A1');
  });
});

describe('inserting and deleting rows and columns', () => {
  it('moves references below an inserted row, absolute ones included', () => {
    const op = { kind: 'insert', axis: 'row', at: 2, count: 1 } as const;
    expect(structuralFormula('=A1+A3+$A$5', op)).toBe('=A1+A4+$A$6');
    expect(structuralFormula('=SUM(A1:A10)', op)).toBe('=SUM(A1:A11)'); // grows
  });

  it('shrinks ranges and breaks references to deleted rows', () => {
    const op = { kind: 'delete', axis: 'row', at: 2, count: 2 } as const; // rows 3–4
    expect(structuralFormula('=A3', op)).toBe('=#REF!');
    expect(structuralFormula('=A5+A1', op)).toBe('=A3+A1');
    expect(structuralFormula('=SUM(A1:A10)', op)).toBe('=SUM(A1:A8)');
    expect(structuralFormula('=SUM(A3:A4)', op)).toBe('=SUM(#REF!)');
    expect(structuralFormula('=SUM(A4:A6)', op)).toBe('=SUM(A3:A4)');
  });

  it('handles columns and whole-column ranges', () => {
    expect(structuralFormula('=SUM(B:D)+C1', { kind: 'delete', axis: 'col', at: 2, count: 1 })).toBe('=SUM(B:C)+#REF!');
    expect(structuralFormula('=SUM(B:D)', { kind: 'insert', axis: 'col', at: 0, count: 2 })).toBe('=SUM(D:F)');
  });

  it('keeps a sheet computing the same values after an insert', () => {
    const before = sheetOf({ A1: '1', A2: '2', A3: '=A1+A2', B1: '=SUM(A1:A3)' });
    const raw = new Map(before.entries());
    const after = applyStructural(raw, { kind: 'insert', axis: 'row', at: 1, count: 1 });
    before.set(diff(raw, after));
    expect(val(before, 'A4')).toBe(3);
    expect(val(before, 'B1')).toBe(6);
    expect(before.raw(keyOf('B1'))).toBe('=SUM(A1:A4)');
    expect(before.raw(keyOf('A2'))).toBe('');
  });
});

describe('csv', () => {
  it('round-trips quotes, commas and newlines', () => {
    const rows = [
      ['name', 'note'],
      ['Nino', 'said "hi", then left'],
      ['Giorgi', 'two\nlines'],
    ];
    expect(parseCSV(toCSV(rows))).toEqual(rows);
  });

  it('detects semicolons and tabs', () => {
    expect(parseCSV('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCSV('a\tb\n1\t2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
