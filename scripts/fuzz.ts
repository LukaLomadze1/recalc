// npm run fuzz -- [--seeds N] [--from S] [--steps K] [--seed S] [--bug NAME]
//
// Runs random sheets through the incremental engine and the naive reference, and stops at the first
// disagreement with everything needed to replay it. --bug switches on a deliberate bug, to see how
// quickly the fuzzer notices.

import { runCase } from '../src/engine/fuzz.ts';
import { BUGS, type Bug } from '../src/engine/sheet.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const bugArg = args.includes('--bug') ? args[args.indexOf('--bug') + 1] : null;
if (bugArg && !BUGS.includes(bugArg as Bug)) {
  console.error(`Unknown bug "${bugArg}". Choose one of: ${BUGS.join(', ')}`);
  process.exit(2);
}
const bug = bugArg as Bug | null;

const single = opt('seed', NaN);
const from = Number.isNaN(single) ? opt('from', 1) : single;
const count = Number.isNaN(single) ? opt('seeds', 2000) : 1;
const steps = opt('steps', 30);

const t0 = performance.now();
for (let seed = from; seed < from + count; seed++) {
  const failure = runCase(seed, steps, bug);
  if (failure) {
    console.log(`\nDisagreement on seed ${seed}, after edit ${failure.step}:`);
    console.log(`  ${failure.cell} should be ${failure.expected}, but the engine has ${failure.actual}\n`);
    console.log('Edits:');
    failure.log.forEach((l, i) => console.log(`  ${String(i).padStart(2)}. ${l}`));
    console.log('\nSheet at that moment:');
    for (const [a, raw] of Object.entries(failure.cells)) console.log(`  ${a.padEnd(8)} ${raw}`);
    console.log(`\nReplay: npm run fuzz -- --seed ${seed}${bug ? ` --bug ${bug}` : ''}`);
    process.exit(1);
  }
  if ((seed - from + 1) % 1000 === 0) process.stdout.write(`  ${seed - from + 1} sheets…\r`);
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`${count} random sheets, ${count * steps} edits${bug ? ` with bug "${bug}"` : ''}: no disagreement (${secs}s).`);
if (bug) process.exit(1);
