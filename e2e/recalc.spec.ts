import { expect, test, type Page } from '@playwright/test';

// The grid is a canvas, so these tests read cells the way a person checks them: select the cell with
// the name box, then read the formula bar and the X-ray panel.

const COL_W = 96;
const ROW_H = 24;
const HEAD_W = 58;
const HEAD_H = 26;

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await expect(page.locator('.doc-name')).toHaveText('Mortgage');
}

async function blank(page: Page): Promise<void> {
  await open(page);
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'New sheet' }).click();
  await expect(page.locator('.doc-name')).toHaveText('Untitled');
}

async function goto(page: Page, a1: string): Promise<void> {
  await page.locator('.name-box').fill(a1);
  await page.locator('.name-box').press('Enter');
}

async function valueOf(page: Page, a1: string): Promise<string> {
  await goto(page, a1);
  await expect(page.locator('.ins-cell-head h2')).toHaveText(a1);
  const v = page.locator('.ins-v');
  return (await v.count()) ? ((await v.textContent()) ?? '') : '';
}

async function rawOf(page: Page, a1: string): Promise<string> {
  await goto(page, a1);
  return page.getByLabel('Formula bar').inputValue();
}

/** Types into the selected cell and presses Enter, like a person would. */
async function enter(page: Page, a1: string, text: string): Promise<void> {
  await goto(page, a1);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The centre of a cell on a sheet with default column widths, scrolled to the top-left. */
async function cellPoint(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.grid-scroller').boundingBox())!;
  return { x: box.x + HEAD_W + col * COL_W + COL_W / 2, y: box.y + HEAD_H + row * ROW_H + ROW_H / 2 };
}

test('editing an input recalculates everything downstream', async ({ page }) => {
  await open(page);
  expect(await valueOf(page, 'B9')).toBe('1580.17');
  await enter(page, 'B5', '4.5');
  await expect(page.locator('.statusbar')).toContainText('Changing B5: 1,505 formulas recomputed');
  expect(await valueOf(page, 'B9')).toBe('1266.71');
  expect(await valueOf(page, 'E375')).toBe('0');
});

test('undo and redo restore values', async ({ page }) => {
  await open(page);
  await enter(page, 'B4', '100000');
  expect(await valueOf(page, 'B9')).toBe('632.07');
  await page.keyboard.press('Control+z');
  expect(await valueOf(page, 'B9')).toBe('1580.17');
  await page.keyboard.press('Control+y');
  expect(await valueOf(page, 'B9')).toBe('632.07');
});

test('formulas: typing, pointing at cells, and errors explained', async ({ page }) => {
  await blank(page);
  await enter(page, 'A1', '20');
  await enter(page, 'A2', '22');
  await goto(page, 'C1');
  await page.keyboard.type('=SUM(');
  // Click A1, then shift-free drag to A2: the reference is inserted at the caret.
  const a1 = await cellPoint(page, 0, 0);
  const a2 = await cellPoint(page, 1, 0);
  await page.mouse.move(a1.x, a1.y);
  await page.mouse.down();
  await page.mouse.move(a2.x, a2.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel('Formula bar')).toHaveValue('=SUM(A1:A2');
  await page.keyboard.press('Enter');
  expect(await rawOf(page, 'C1')).toBe('=SUM(A1:A2)'); // the bracket was closed for us
  expect(await valueOf(page, 'C1')).toBe('42');

  await enter(page, 'C2', '=C1/(A1-20)');
  expect(await valueOf(page, 'C2')).toBe('#DIV/0!');
  await enter(page, 'C3', '=C2+1');
  await goto(page, 'C3');
  await expect(page.locator('.ins-error')).toContainText('It started in C2');
});

test('copy and paste shift relative references', async ({ page }) => {
  await blank(page);
  await enter(page, 'A1', '1');
  await enter(page, 'A2', '2');
  await enter(page, 'B1', '=A1*10');
  await goto(page, 'B1');
  const b1 = await cellPoint(page, 0, 1);
  await page.mouse.click(b1.x, b1.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy/ }).click();
  await goto(page, 'B2');
  const b2 = await cellPoint(page, 1, 1);
  await page.mouse.click(b2.x, b2.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  expect(await rawOf(page, 'B2')).toBe('=A2*10');
  expect(await valueOf(page, 'B2')).toBe('20');
});

test('the fill handle continues a series and copies formulas', async ({ page }) => {
  await blank(page);
  await enter(page, 'A1', '5');
  await enter(page, 'A2', '10');
  await enter(page, 'B1', '=A1*2');
  await enter(page, 'B2', '=A2*2');
  await goto(page, 'A1:B2');
  // The handle is the small square at the bottom-right corner of the selection.
  const box = (await page.locator('.grid-scroller').boundingBox())!;
  const hx = box.x + HEAD_W + 2 * COL_W;
  const hy = box.y + HEAD_H + 2 * ROW_H;
  const target = await cellPoint(page, 4, 1);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();
  expect(await valueOf(page, 'A5')).toBe('25');
  expect(await rawOf(page, 'B5')).toBe('=A5*2');
  expect(await valueOf(page, 'B5')).toBe('50');
});

test('inserting a row rewrites references across the sheet', async ({ page }) => {
  await blank(page);
  await enter(page, 'A1', '1');
  await enter(page, 'A2', '2');
  await enter(page, 'A3', '=SUM(A1:A2)');
  await goto(page, 'A2');
  await page.keyboard.press('Control+Shift+Equal');
  expect(await rawOf(page, 'A4')).toBe('=SUM(A1:A3)');
  expect(await valueOf(page, 'A4')).toBe('3');
  expect(await valueOf(page, 'A3')).toBe('2');
});

test('cycles are detected, named, and recover when broken', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('menuitem', { name: /Errors and cycles/ }).click();
  expect(await valueOf(page, 'B15')).toBe('#CYCLE!');
  await expect(page.locator('.ins-error')).toContainText('Circular reference between 3 cells: B15, C15, D15');
  expect(await valueOf(page, 'B17')).toBe('#CYCLE!');
  await enter(page, 'D15', '10');
  expect(await valueOf(page, 'B15')).toBe('12');
  expect(await valueOf(page, 'B17')).toBe('120');
});

test('the sheet is a million rows deep, and the last cell is reachable', async ({ page }) => {
  await blank(page);
  await enter(page, 'XFD1048576', 'the end');
  expect(await valueOf(page, 'XFD1048576')).toBe('the end');
  await enter(page, 'A1', '=XFD1048576');
  expect(await valueOf(page, 'A1')).toBe('the end');
  // Ctrl+Down from an empty column goes straight to the last row.
  await goto(page, 'B1');
  await page.keyboard.press('Control+ArrowDown');
  await expect(page.locator('.name-box')).toHaveValue('B1048576');
});

test('the sheet survives a reload', async ({ page }) => {
  await blank(page);
  await enter(page, 'A1', 'kept');
  await page.waitForTimeout(700); // autosave is debounced
  await page.reload();
  expect(await valueOf(page, 'A1')).toBe('kept');
});

test('function suggestions and signature help', async ({ page }) => {
  await blank(page);
  await goto(page, 'A1');
  await page.keyboard.type('=VLOO');
  await expect(page.getByRole('listbox', { name: 'Function suggestions' })).toContainText('VLOOKUP');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Formula bar')).toHaveValue('=VLOOKUP(');
  await page.keyboard.type('1,');
  await expect(page.locator('.sig-arg.on')).toHaveText('table');
  await page.keyboard.press('Escape');
});
