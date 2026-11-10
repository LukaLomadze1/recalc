import { describe, expect, it } from 'vitest';
import { runCase } from './fuzz.ts';
import { BUGS } from './sheet.ts';

describe('incremental recalculation matches recomputing from scratch', () => {
  it('on 1,000 random sheets and 30,000 random edits', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const failure = runCase(seed);
      if (failure) expect.fail(JSON.stringify(failure, null, 2));
    }
  });
});

describe('the fuzzer catches every deliberate bug', () => {
  for (const bug of BUGS) {
    it(bug, () => {
      let found: number | null = null;
      for (let seed = 1; seed <= 2000 && found === null; seed++) if (runCase(seed, 30, bug)) found = seed;
      expect(found, `${bug} was never caught`).not.toBeNull();
    });
  }
});
