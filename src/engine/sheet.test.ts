import { describe, expect, it } from 'vitest';
import { keyAddr } from './address.ts';
import { Sheet } from './sheet.ts';
import { keyOf, sheetOf, val } from './testkit.ts';

describe('recalculation', () => {
  it('recomputes only what is downstream of an edit, in dependency order', () => {
    const s = sheetOf({ A1: '1', B1: '=A1*2', C1: '=B1+A1', D1: '=C1*10', Z9: '=5+5' });
    expect(val(s, 'D1')).toBe(30);
    const report = s.set([[keyOf('A1'), '2']]);
    expect(report.order.map(keyAddr)).toEqual(['B1', 'C1', 'D1']);
    expect(val(s, 'D1')).toBe(60);
    expect(report.formulas).toBe(4);
  });

  it('reaches formulas that read a range, not just a direct reference', () => {
    const s = sheetOf({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)', C1: '=SUM(A:A)' });
    s.set([[keyOf('A2'), '20']]);
    expect(val(s, 'B1')).toBe(24);
    expect(val(s, 'C1')).toBe(24);
    // A cell that was blank when the formula was written still counts.
    s.set([[keyOf('A500000'), '100']]);
    expect(val(s, 'C1')).toBe(124);
    expect(val(s, 'B1')).toBe(24);
  });

  it('finds cycles, names them, and recovers when they are broken', () => {
    const s = sheetOf({ A1: '=B1+1', B1: '=C1+1', C1: '=A1+1', D1: '=A1*2', E1: '=E1' });
    expect(val(s, 'A1')).toBe('#CYCLE!');
    expect(val(s, 'B1')).toBe('#CYCLE!');
    expect(val(s, 'D1')).toBe('#CYCLE!'); // downstream of a cycle, so it inherits the error
    expect(val(s, 'E1')).toBe('#CYCLE!');
    const report = s.set([[keyOf('C1'), '10']]);
    expect(report.cycles).toEqual([]);
    expect(val(s, 'A1')).toBe(12);
    expect(val(s, 'D1')).toBe(24);
  });

  it('treats a range that contains its own cell as a cycle', () => {
    const s = sheetOf({ A1: '1', A2: '=SUM(A1:A3)' });
    expect(val(s, 'A2')).toBe('#CYCLE!');
    expect(s.value(keyOf('A2'))).toMatchObject({ why: 'A2 refers to itself.' });
  });

  it('IFERROR can catch a cycle downstream', () => {
    const s = sheetOf({ A1: '=A1', B1: '=IFERROR(A1,"loop")' });
    expect(val(s, 'B1')).toBe('loop');
  });

  it('handles a 100,000-deep chain without overflowing the stack', () => {
    const s = new Sheet();
    const n = 100_000;
    const cells: Array<[number, string]> = [[keyOf('A1'), '1']];
    for (let i = 2; i <= n; i++) cells.push([keyOf(`A${i}`), `=A${i - 1}+1`]);
    s.set(cells);
    expect(val(s, `A${n}`)).toBe(n);
    const report = s.set([[keyOf('A1'), '0']]);
    expect(report.order.length).toBe(n - 1);
    expect(val(s, `A${n}`)).toBe(n - 1);
    // An edit at the bottom of the chain touches nothing else.
    expect(s.set([[keyOf(`A${n}`), '5']]).order.length).toBe(0);
  });

  it('clears a cell and updates its dependents', () => {
    const s = sheetOf({ A1: '5', B1: '=A1*2' });
    s.set([[keyOf('A1'), '']]);
    expect(val(s, 'B1')).toBe(0);
    expect(s.size).toBe(1);
  });

  it('replacing a formula drops its old precedents', () => {
    const s = sheetOf({ A1: '1', B1: '=A1', C1: '7' });
    s.set([[keyOf('B1'), '=C1']]);
    expect(s.set([[keyOf('A1'), '2']]).order).toEqual([]);
    expect(s.set([[keyOf('C1'), '8']]).order.map(keyAddr)).toEqual(['B1']);
  });

  it('explains errors', () => {
    const s = sheetOf({ A1: '=1/0', B1: '=A1+1', C1: '=SUM(', D1: '="x"*2' });
    expect(val(s, 'B1')).toBe('#DIV/0!');
    expect(s.value(keyOf('C1'))).toMatchObject({ code: '#ERROR!' });
    expect(String((s.value(keyOf('D1')) as { why: string }).why)).toContain('"x"');
  });

  it('reports dependents and downstream counts for the inspector', () => {
    const s = sheetOf({ A1: '1', B1: '=A1', B2: '=SUM(A1:A9)', C1: '=B1+B2' });
    expect(s.dependentsOf(keyOf('A1')).map(keyAddr).sort()).toEqual(['B1', 'B2']);
    expect(s.downstreamCount(keyOf('A1'))).toBe(3);
    expect(s.precedentsOf(keyOf('C1')).refs.map(keyAddr)).toEqual(['B1', 'B2']);
  });
});
