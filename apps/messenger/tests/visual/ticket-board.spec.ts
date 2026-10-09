import { expect, test, webkit, type Page } from '@playwright/test';

/** The five columns side by side: each one's left edge is to the right of the one before it. */
async function columnsAcross(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const columns = [...document.querySelectorAll<HTMLElement>('[data-board-status]')];
    return columns.length === 5 && columns.every((column, index) => index === 0 || column.getBoundingClientRect().x > columns[index - 1]!.getBoundingClientRect().x + 40);
  });
}

test('webkit: the wide board and the narrow tickets tab are five columns across', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '看板' }).click();
    await expect(page.locator('.trace-stage')).toBeHidden();
    expect(await columnsAcross(page)).toBe(true);
    const scrolls = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>('[data-board-status="todo"]');
      return !!column && getComputedStyle(column).overflowY === 'auto' && column.scrollHeight > column.clientHeight;
    });
    expect(scrolls).toBe(true);

    // Pulled under 720px, the wide board gives way to the tabs and the trace comes back.
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.locator('.trace-stage')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('tab', { name: /任务/ }).click();
    await expect(page.locator('.trace-stage')).toBeHidden();
    expect(await columnsAcross(page)).toBe(true);
    const scrollsAcross = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.ticket-board');
      return !!board && board.scrollWidth > board.clientWidth;
    });
    expect(scrollsAcross).toBe(true);

    expect(errors).toEqual([]);
    await page.close();
  } finally {
    await browser.close();
  }
});

const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Press a card by its title — where a person grabs it — and carry it past the threshold to `to`. */
async function grab(page: Page, id: string, to: { x: number; y: number }): Promise<void> {
  const title = centre((await page.locator(`[data-ticket-id="${id}"] .ticket-main`).boundingBox())!);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down();
  await page.mouse.move(title.x + 3, title.y);
  await page.mouse.move(title.x + 8, title.y);
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

/** A finger has no mouse in Playwright's desktop page, so its pointer events are sent as a touch would. */
async function touchDrag(page: Page, id: string, by: number): Promise<void> {
  const box = (await page.locator(`[data-ticket-id="${id}"] .ticket-main`).boundingBox())!;
  await page.evaluate(({ id, x, y, by }) => {
    const title = document.querySelector<HTMLElement>(`[data-ticket-id="${id}"] .ticket-main`)!;
    const fire = (type: string, at: number, target: EventTarget) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, pointerType: 'touch', clientX: at, clientY: y }));
    fire('pointerdown', x, title);
    fire('pointermove', x + by, window);
    fire('pointerup', x + by, window);
  }, { id, x: box.x + 24, y: box.y + box.height / 2, by });
}

test('webkit: a card dragged by its title changes status; a short move is a click, Escape and a touch drop nothing', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.goto(`${baseURL}index.html?story=ticket26a-columns`);
    await expect(page.locator('[data-board-status]')).toHaveCount(5, { timeout: 3000 });
    const patches = () => page.evaluate(() => JSON.parse(document.body.dataset.ticketPatches ?? '[]'));
    const selected = () => page.evaluate(() => document.querySelector('.ticket-row.is-selected')?.getAttribute('data-ticket-id') ?? null);
    const doing = centre((await page.locator('[data-board-status="doing"]').boundingBox())!);
    const todo = centre((await page.locator('[data-board-status="todo"]').boundingBox())!);

    // Three pixels on the title is a click: nothing is patched and the card is picked.
    const t5 = centre((await page.locator('[data-ticket-id="t5"] .ticket-main').boundingBox())!);
    await page.mouse.move(t5.x, t5.y);
    await page.mouse.down();
    await page.mouse.move(t5.x + 3, t5.y);
    await page.mouse.up();
    expect(await patches()).toEqual([]);
    expect(await selected()).toBe('t5');

    // Carried by its title into the next column, another card moves. The ghost never catches the
    // pointer, and the click the release fires does not pick the carried card.
    await grab(page, 't4', doing);
    await expect(page.locator('.ticket-ghost')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.ticket-ghost')!).pointerEvents)).toBe('none');
    await expect(page.locator('[data-board-status="doing"].is-drop')).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(patches).toEqual([{ id: 't4', body: { status: 'doing', if_revision: 1 } }]);
    expect(await selected()).toBe('t5');

    // Escape ends the drag: moving on draws no ghost and lights no column, and the release drops nothing.
    await grab(page, 't2', todo);
    await expect(page.locator('.ticket-ghost')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.move(todo.x + 12, todo.y + 12, { steps: 3 });
    await expect(page.locator('.ticket-ghost')).toHaveCount(0);
    await expect(page.locator('.ticket-column.is-drop')).toHaveCount(0);
    await page.mouse.up();
    expect(await patches()).toHaveLength(1);

    // A finger scrolls the board. It never starts a drag.
    await touchDrag(page, 't2', 120);
    expect(await patches()).toHaveLength(1);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('webkit: on a board wider than the pane, a card held at the edge scrolls it to a column out of sight', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: '看板' }).click();
    const board = page.locator('.ticket-board');
    const parkedInView = () => page.evaluate(() => document.querySelector('[data-board-status="parked"]')!.getBoundingClientRect().right <= window.innerWidth);
    expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await parkedInView()).toBe(false);

    const box = (await board.boundingBox())!;
    const card = (await page.locator('[data-ticket-id="tk-1"]').boundingBox())!;
    await grab(page, 'tk-1', { x: box.x + box.width - 6, y: card.y + 60 });
    await expect.poll(() => board.evaluate((el) => el.scrollLeft), { timeout: 3000 }).toBeGreaterThan(0);
    await expect.poll(parkedInView, { timeout: 3000 }).toBe(true);
    const parked = centre((await page.locator('[data-board-status="parked"]').boundingBox())!);
    await page.mouse.move(Math.min(parked.x, box.x + box.width - 40), parked.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => JSON.parse(document.body.dataset.ticketPatches ?? '[]'))).toEqual([{ id: 'tk-1', body: { status: 'parked', if_revision: 2 } }]);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('webkit: a narrow pane shows the spec tab even when the wide board was left on over the spec', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    await page.locator('.trace-side-toggle').first().click();
    await page.getByRole('button', { name: '看板' }).click();
    await expect(page.locator('.trace-stage')).toBeHidden();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('tab', { name: /要点/ }).click();
    await expect(page.locator('.trace-side-panel:not(.is-tickets)')).toBeVisible();
    await expect(page.locator('.trace-side-panel.is-tickets')).toBeHidden();
    await page.close();
  } finally {
    await browser.close();
  }
});
