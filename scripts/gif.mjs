// node scripts/gif.mjs (with the dev server running on 5207)
// Records the README's hero GIF from the real app: change the interest rate, watch the ripple.

import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const BASE = process.env.BASE_URL ?? 'http://localhost:5207/';
const OUT = process.argv[2] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 700 }, deviceScaleFactor: 1 });
await page.goto(BASE);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('recalc:theme', 'light');
});
await page.goto(BASE);
await page.waitForSelector('.grid-scroller');
await page.waitForTimeout(2200);
await page.locator('.hint-x').click();
await page.locator('.name-box').fill('B5');
await page.locator('.name-box').press('Enter');
await page.waitForTimeout(300);

const frames = [];
const grab = async (hold = 1) => {
  const png = await page.screenshot();
  frames.push({ png, hold });
};

await grab(14); // the selected input, its arrows and its 1,505 dependents
for (const ch of '4.5') {
  await page.keyboard.type(ch);
  await grab(4);
}
await page.keyboard.press('Enter');
await page.locator('.name-box').fill('B5');
await page.locator('.name-box').press('Enter');
const t0 = Date.now();
while (Date.now() - t0 < 2300) await grab(1);
await grab(30); // hold on the result

await browser.close();

const gif = GIFEncoder();
let width = 0;
let height = 0;
for (const f of frames) {
  const img = PNG.sync.read(f.png);
  width = img.width;
  height = img.height;
  const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
  const palette = quantize(rgba, 192);
  const index = applyPalette(rgba, palette);
  gif.writeFrame(index, width, height, { palette, delay: 70 * f.hold });
}
gif.finish();
writeFileSync(`${OUT}/hero.gif`, gif.bytes());
console.log(`hero.gif: ${frames.length} frames, ${width}x${height}, ${(statSync(`${OUT}/hero.gif`).size / 1e6).toFixed(1)} MB`);
