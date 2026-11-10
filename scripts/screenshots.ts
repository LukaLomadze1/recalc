// npm run screenshots (with the dev server running on 5207)
// Captures the images used in the README, in a real browser, from the real app.

import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5207/';
const OUT = process.argv[2] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

async function fresh(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.goto(BASE);
  await page.evaluate((t) => {
    localStorage.clear();
    localStorage.setItem('recalc:theme', t);
  }, theme);
  await page.goto(BASE);
  await page.waitForSelector('.grid-scroller');
  await page.waitForTimeout(1600); // fonts and the opening ripple
}

async function goto(page: Page, a1: string): Promise<void> {
  await page.locator('.name-box').fill(a1);
  await page.locator('.name-box').press('Enter');
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
const only = process.argv[3];

if (!only || only === 'hero') {
  await fresh(page);
  await goto(page, 'B5');
  await page.keyboard.type('4.5');
  await page.keyboard.press('Enter');
  await goto(page, 'B5');
  await page.waitForTimeout(380); // mid-ripple
  await page.screenshot({ path: `${OUT}/hero.png` });
}

if (!only || only === 'arrows') {
  await fresh(page);
  await goto(page, 'C20');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/arrows.png` });
}

if (!only || only === 'errors') {
  await fresh(page, 'dark');
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('menuitem', { name: /Errors and cycles/ }).click();
  await page.waitForTimeout(1500);
  await goto(page, 'B15');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/errors-dark.png` });
}

if (!only || only === 'editing') {
  await fresh(page);
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('menuitem', { name: /Gradebook/ }).click();
  await page.waitForTimeout(1500);
  await goto(page, 'J30');
  await page.keyboard.type('=AVERAGEIF(G5:G28,"A",F5:F2');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/editing.png` });
}

await browser.close();
console.log(`Screenshots written to ${OUT}`);
