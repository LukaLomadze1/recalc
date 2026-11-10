// npm run bench
// Measures the engine on the example sheets and prints the table used in the README.
// Each figure is the median of several runs, on Node (V8), single-threaded.

import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseAddress, toKey, type CellKey } from '../src/engine/address.ts';
import { parse } from '../src/engine/parser.ts';
import { Sheet } from '../src/engine/sheet.ts';
import { EXAMPLES } from '../src/app/samples.ts';

const RUNS = 7;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const key = (a1: string): CellKey => {
  const c = parseAddress(a1)!;
  return toKey(c.row, c.col);
};
const entries = (id: string): Array<[CellKey, string]> => EXAMPLES.find((e) => e.id === id)!.build().cells.map(([a, raw]) => [key(a), raw]);

interface Row {
  what: string;
  recomputed: number;
  of: number;
  ms: number;
}
const rows: Row[] = [];

function time(what: string, setup: () => Sheet, act: (s: Sheet) => { order: unknown[]; formulas: number }): void {
  const ms: number[] = [];
  let last = { order: [] as unknown[], formulas: 0 };
  for (let i = 0; i < RUNS; i++) {
    const s = setup();
    const t0 = performance.now();
    last = act(s);
    ms.push(performance.now() - t0);
  }
  rows.push({ what, recomputed: last.order.length, of: last.formulas, ms: median(ms) });
}

// Mortgage: one interest rate feeds 1,500 of the 1,864 formulas.
const mortgage = entries('mortgage');
time('Mortgage: open and compute everything', () => new Sheet(), (s) => s.load(mortgage));
const loadedMortgage = (): Sheet => {
  const s = new Sheet();
  s.load(mortgage);
  return s;
};
time('Mortgage: change the interest rate (B5)', loadedMortgage, (s) => s.set([[key('B5'), '4.5']]));
time('Mortgage: change a label (A1)', loadedMortgage, (s) => s.set([[key('A1'), 'Renamed']]));

// Stress: 300,000 cells, a running total 100,000 cells deep.
const stress = entries('stress');
time('Stress: open 300,000 cells (200,005 formulas)', () => new Sheet(), (s) => s.load(stress));
const loadedStress = (): Sheet => {
  const s = new Sheet();
  s.load(stress);
  return s;
};
time('Stress: change A1 (top of the 100,000-deep chain)', loadedStress, (s) => s.set([[key('A1'), '2']]));
time('Stress: change A99999 (near the bottom)', loadedStress, (s) => s.set([[key('A99999'), '1']]));
time('Stress: change an unrelated cell (H1)', loadedStress, (s) => s.set([[key('H1'), '1']]));

// Parser throughput.
const formulas = mortgage.map(([, raw]) => raw).filter((r) => r.startsWith('='));
const parseMs: number[] = [];
let parsed = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) for (const f of formulas) parse(f.slice(1));
  parseMs.push(performance.now() - t0);
  parsed = formulas.length * 20;
}
const perSec = Math.round(parsed / (median(parseMs) / 1000));

const fmt = (n: number): string => new Intl.NumberFormat('en-US').format(n);
const ms = (x: number): string => (x < 0.1 ? `${(x * 1000).toFixed(0)} µs` : x < 10 ? `${x.toFixed(2)} ms` : `${Math.round(x)} ms`);
const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';

console.log(`\n${cpu}, Node ${process.version}, median of ${RUNS} runs\n`);
console.log('| What | Formulas recomputed | Time |');
console.log('|---|---:|---:|');
for (const r of rows) console.log(`| ${r.what} | ${fmt(r.recomputed)} of ${fmt(r.of)} | ${ms(r.ms)} |`);
console.log(`\nParser: ${fmt(perSec)} formulas per second.`);

writeFileSync(
  'docs/bench.json',
  JSON.stringify({ cpu, node: process.version, runs: RUNS, rows, parsePerSecond: perSec, date: new Date().toISOString().slice(0, 10) }, null, 2) + '\n',
);
