import { describe, expect, it } from 'vitest';
import { Sheet } from '../engine/sheet.ts';
import { parseAddress, toKey } from '../engine/address.ts';
import { EXAMPLES } from './samples.ts';
import { decodeDoc, encodeDoc } from './share.ts';

describe('share links', () => {
  it('round-trip a sheet through the URL fragment', async () => {
    const doc = EXAMPLES[0].build();
    const text = await encodeDoc(doc);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    // The whole mortgage (2,100 cells) is about 20 KB: long, but within what browsers accept in a URL.
    expect(text.length).toBeLessThan(32_000);
    expect(await decodeDoc(text)).toEqual(doc);
  });

  it('reject garbage', async () => {
    await expect(decodeDoc('not-a-sheet')).rejects.toThrow();
  });
});

describe('examples', () => {
  for (const ex of EXAMPLES.filter((e) => e.id !== 'stress')) {
    it(`${ex.title} computes without stray errors`, () => {
      const doc = ex.build();
      const s = new Sheet();
      s.load(doc.cells.map(([a, raw]) => [toKey(parseAddress(a)!.row, parseAddress(a)!.col), raw] as const));
      const errors: string[] = [];
      for (const [a] of doc.cells) {
        const c = parseAddress(a)!;
        const v = s.valueAt(c.row, c.col);
        if (typeof v === 'object' && v !== null) errors.push(`${a}: ${v.code}`);
      }
      if (ex.id === 'errors') expect(errors.length).toBeGreaterThan(5);
      else expect(errors).toEqual([]);
    });
  }

  it('the mortgage pays off to exactly zero', () => {
    const doc = EXAMPLES[0].build();
    const s = new Sheet();
    s.load(doc.cells.map(([a, raw]) => [toKey(parseAddress(a)!.row, parseAddress(a)!.col), raw] as const));
    const at = (a: string): unknown => s.valueAt(parseAddress(a)!.row, parseAddress(a)!.col);
    expect(at('B9')).toBe(1580.17);
    expect(at('E375')).toBe(0);
    expect(at('B13')).toBe(360);
    expect(at('I45')).toBe(0);
  });
});
