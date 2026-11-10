// The example sheets. Each one is chosen to show something about the engine: the mortgage shows a
// single edit rippling through 1,900 formulas, the gradebook shows lookups and statistics, the
// errors sheet shows cycles and error tracing, and the stress test shows the engine at scale.

import type { SheetDoc } from './workbook.ts';

export interface Example {
  id: string;
  title: string;
  blurb: string;
  /** The cell to select after opening, so the X-ray panel has something to say straight away. */
  start: string;
  hint?: string;
  build: () => SheetDoc;
}

function mortgage(): SheetDoc {
  const c: Array<[string, string]> = [
    ['A1', 'Mortgage calculator'],
    ['A2', 'Change any input in column B. Every payment in the schedule below recalculates.'],
    ['A4', 'Loan amount'],
    ['B4', '250000'],
    ['A5', 'Interest rate (% a year)'],
    ['B5', '6.5'],
    ['A6', 'Term (years)'],
    ['B6', '30'],
    ['A7', 'Payments a year'],
    ['B7', '12'],
    ['A9', 'Payment'],
    ['B9', '=ROUND(-PMT(B5/100/B7,B6*B7,B4),2)'],
    ['A10', 'Total paid'],
    ['B10', '=SUM(B16:B375)'],
    ['A11', 'Total interest'],
    ['B11', '=SUM(C16:C375)'],
    ['A12', 'Interest share'],
    ['B12', '=TEXT(B11/B10,"0.0%")'],
    ['A13', 'Payments made'],
    ['B13', '=COUNTIF(B16:B375,">0")'],
    ['A15', 'Month'],
    ['B15', 'Payment'],
    ['C15', 'Interest'],
    ['D15', 'Principal'],
    ['E15', 'Balance'],
    ['G15', 'Year'],
    ['H15', 'Interest that year'],
    ['I15', 'Balance at year end'],
  ];
  const months = 360;
  for (let m = 1; m <= months; m++) {
    const r = 15 + m;
    const prevBal = m === 1 ? '$B$4' : `E${r - 1}`;
    c.push([`A${r}`, m === 1 ? '1' : `=A${r - 1}+1`]);
    // The last payment clears whatever is left, so the balance ends at exactly zero.
    c.push([`B${r}`, `=IF(A${r}>$B$6*$B$7,0,IF(A${r}=$B$6*$B$7,${prevBal}+C${r},$B$9))`]);
    c.push([`C${r}`, `=ROUND(${prevBal}*$B$5/100/$B$7,2)`]);
    c.push([`D${r}`, `=B${r}-C${r}`]);
    c.push([`E${r}`, `=ROUND(${prevBal}-D${r},2)`]);
  }
  for (let y = 1; y <= 30; y++) {
    const r = 15 + y;
    c.push([`G${r}`, String(y)]);
    c.push([`H${r}`, `=SUMIFS(C$16:C$375,A$16:A$375,">"&(G${r}-1)*$B$7,A$16:A$375,"<="&G${r}*$B$7)`]);
    c.push([`I${r}`, `=IF(G${r}*$B$7>360,"",INDEX(E$16:E$375,G${r}*$B$7))`]);
  }
  return { name: 'Mortgage', cells: c, widths: [[0, 200], [7, 160], [8, 170]] };
}

const STUDENTS = [
  'Nino Beridze', 'Giorgi Kapanadze', 'Ana Lomidze', 'Luka Maisuradze', 'Mariam Tsiklauri', 'Davit Gelashvili',
  'Elene Japaridze', 'Saba Kvaratskhelia', 'Tamar Abashidze', 'Nika Chkheidze', 'Salome Gogoladze', 'Irakli Mchedlidze',
  'Ketevan Dolidze', 'Levan Natsvlishvili', 'Mariam Kiknadze', 'Aleksandre Bakuradze', 'Sophie Laurent', 'Mateo Rossi',
  'Yuki Tanaka', 'Amara Okafor', 'Jonas Becker', 'Priya Raman', 'Oliver Grant', 'Lucía Fernández',
];

function gradebook(): SheetDoc {
  // Deterministic "random" scores, so the example is the same for everyone.
  let seed = 7;
  const rnd = (lo: number, hi: number): number => {
    seed = (seed * 16807) % 2147483647;
    return lo + (seed % (hi - lo + 1));
  };
  const c: Array<[string, string]> = [
    ['A1', 'Algorithms 101: final grades'],
    ['A2', 'Change a score or a weight. Averages, grades, ranks and class statistics follow.'],
    ['A4', 'Student'],
    ['B4', 'Homework'],
    ['C4', 'Project'],
    ['D4', 'Midterm'],
    ['E4', 'Final'],
    ['F4', 'Weighted'],
    ['G4', 'Grade'],
    ['H4', 'Rank'],
    ['A3', 'Weights →'],
    ['B3', '0.15'],
    ['C3', '0.15'],
    ['D3', '0.3'],
    ['E3', '0.4'],
    ['F3', '=SUM(B3:E3)'],
    ['G3', '=IF(ROUND(F3,6)=1,"weights OK","weights must add up to 1")'],
    // The Georgian university scale.
    ['K4', 'From'],
    ['L4', 'Grade'],
    ['K5', '0'], ['L5', 'F'],
    ['K6', '41'], ['L6', 'FX'],
    ['K7', '51'], ['L7', 'E'],
    ['K8', '61'], ['L8', 'D'],
    ['K9', '71'], ['L9', 'C'],
    ['K10', '81'], ['L10', 'B'],
    ['K11', '91'], ['L11', 'A'],
  ];
  const first = 5;
  const last = first + STUDENTS.length - 1;
  STUDENTS.forEach((name, i) => {
    const r = first + i;
    const base = rnd(48, 96);
    c.push([`A${r}`, name]);
    c.push([`B${r}`, String(Math.min(100, base + rnd(-6, 8)))]);
    c.push([`C${r}`, String(Math.min(100, base + rnd(-10, 10)))]);
    c.push([`D${r}`, String(Math.min(100, Math.max(20, base + rnd(-15, 8))))]);
    c.push([`E${r}`, String(Math.min(100, Math.max(20, base + rnd(-12, 10))))]);
    c.push([`F${r}`, `=ROUND(SUMPRODUCT(B${r}:E${r},$B$3:$E$3),1)`]);
    c.push([`G${r}`, `=VLOOKUP(F${r},$K$5:$L$11,2)`]);
    c.push([`H${r}`, `=RANK(F${r},$F$${first}:$F$${last})`]);
  });
  const s = last + 2;
  const F = `F${first}:F${last}`;
  c.push(
    [`A${s}`, 'Class average'], [`B${s}`, `=ROUND(AVERAGE(${F}),1)`],
    [`A${s + 1}`, 'Median'], [`B${s + 1}`, `=MEDIAN(${F})`],
    [`A${s + 2}`, 'Standard deviation'], [`B${s + 2}`, `=ROUND(STDEV(${F}),2)`],
    [`A${s + 3}`, 'Top student'], [`B${s + 3}`, `=INDEX(A${first}:A${last},MATCH(MAX(${F}),${F},0))`],
    [`A${s + 4}`, 'Passed (51+)'], [`B${s + 4}`, `=COUNTIF(${F},">=51")&" of "&COUNT(${F})`],
    [`A${s + 5}`, 'Pass rate'], [`B${s + 5}`, `=TEXT(COUNTIF(${F},">=51")/COUNT(${F}),"0%")`],
    [`A${s + 6}`, 'Grade A'], [`B${s + 6}`, `=COUNTIF(G${first}:G${last},"A")`],
    [`A${s + 7}`, 'Best final exam'], [`B${s + 7}`, `=XLOOKUP(MAX(E${first}:E${last}),E${first}:E${last},A${first}:A${last})`],
  );
  return { name: 'Gradebook', cells: c, widths: [[0, 168]] };
}

function errors(): SheetDoc {
  const c: Array<[string, string]> = [
    ['A1', 'Every error explains itself'],
    ['A2', 'Select a red cell and read the X-ray panel: what went wrong, and which cell it started in.'],
    ['A4', 'Division by zero'],
    ['B4', '=10/(B5-B5)'],
    ['A5', 'An input'],
    ['B5', '3'],
    ['A6', 'Inherits the error'],
    ['B6', '=B4*2'],
    ['A7', '…two steps away'],
    ['B7', '=SUM(B6,1)'],
    ['A8', 'Caught by IFERROR'],
    ['B8', '=IFERROR(B7,"fallback")'],
    ['A10', 'Unknown function'],
    ['B10', '=SUMM(1,2)'],
    ['A11', 'Wrong type'],
    ['B11', '="apple"*2'],
    ['A12', 'Not found'],
    ['B12', '=VLOOKUP("kiwi",D12:E14,2,FALSE)'],
    ['D12', 'apple'], ['E12', '1.20'],
    ['D13', 'pear'], ['E13', '0.90'],
    ['D14', 'plum'], ['E14', '2.10'],
    ['A13', 'Syntax error'],
    ['B13', '=SUM(1,'],
    ['A15', 'A loop of three cells'],
    ['B15', '=C15+1'],
    ['C15', '=D15+1'],
    ['D15', '=B15+1'],
    ['A16', 'A range that contains itself'],
    ['B16', '=SUM(B14:B18)'],
    ['A17', 'Downstream of the loop'],
    ['B17', '=B15*10'],
    ['A19', 'Break the loop: type a number into D15 and watch B15, C15 and B17 come back to life.'],
  ];
  return { name: 'Errors and cycles', cells: c, widths: [[0, 230]] };
}

export const STRESS_ROWS = 100_000;

function stress(): SheetDoc {
  const c: Array<[string, string]> = new Array(STRESS_ROWS * 3 + 12);
  let i = 0;
  for (let r = 1; r <= STRESS_ROWS; r++) {
    c[i++] = [`A${r}`, String(r)];
    // A running total: a dependency chain 100,000 cells deep.
    c[i++] = [`B${r}`, r === 1 ? '=A1' : `=B${r - 1}+A${r}`];
    c[i++] = [`C${r}`, `=A${r}*2`];
  }
  c[i++] = ['E1', 'Sum of A'];
  c[i++] = ['F1', '=SUM(A:A)'];
  c[i++] = ['E2', 'Average of C'];
  c[i++] = ['F2', '=AVERAGE(C:C)'];
  c[i++] = ['E3', 'Above 50,000'];
  c[i++] = ['F3', '=COUNTIF(A:A,">50000")'];
  c[i++] = ['E4', 'Lookup 99,999'];
  c[i++] = ['F4', '=VLOOKUP(99999,A:C,3,FALSE)'];
  c[i++] = ['E5', 'Last total'];
  c[i++] = ['F5', `=B${STRESS_ROWS}`];
  c[i++] = ['E7', 'Edit A1 to recompute the whole 100,000-deep chain; edit A99999 to recompute two cells.'];
  return { name: 'Stress test', cells: c.slice(0, i), widths: [[4, 120]] };
}

export const EXAMPLES: Example[] = [
  {
    id: 'mortgage',
    title: 'Mortgage',
    blurb: '1,900 formulas downstream of one interest rate',
    start: 'B5',
    hint: 'B5 is the interest rate. Type 4.5 and press Enter, then watch the schedule recalculate in dependency order.',
    build: mortgage,
  },
  { id: 'grades', title: 'Gradebook', blurb: 'Lookups, ranks and class statistics', start: 'B3', hint: 'Change a weight in row 3: every grade, rank and statistic follows.', build: gradebook },
  {
    id: 'errors',
    title: 'Errors and cycles',
    blurb: 'Every error type, traced to where it started',
    start: 'B7',
    hint: 'B7 shows #DIV/0!, but the panel traces it back two steps to B4, where it started.',
    build: errors,
  },
  {
    id: 'stress',
    title: 'Stress test',
    blurb: '300,000 cells and a 100,000-deep dependency chain',
    start: 'A1',
    hint: 'Type a number into A1. All 100,000 running totals depend on it.',
    build: stress,
  },
];
