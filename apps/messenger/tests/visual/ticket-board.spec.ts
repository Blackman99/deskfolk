import { expect, test, webkit, type Page } from '@playwright/test';

/** The five columns side by side: each one's left edge is to the right of the one before it. */
async function columnsAcross(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const columns = [...document.querySelectorAll<HTMLElement>('[data-board-status]')];
    return columns.length === 5 && columns.every((column, index) => index === 0 || column.getBoundingClientRect().x > columns[index - 1]!.getBoundingClientRect().x + 40);
  });
}

test('webkit: the pane switches between the trace, the board and the spec, each filling it at both widths', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    // One switch, at the title's end on a wide pane: the trace, the board, the spec.
    await expect(page.getByRole('tab')).toHaveText([/流程/, /看板\s*15/, /要点/]);
    const pane = await page.locator('.trace-pane').boundingBox();
    // Moved by hand first, so coming back can show the camera was kept, not reopened.
    const opened = await cameraOf(page);
    await panTrace(page, { x: 160, y: 90 });
    await expect.poll(() => cameraOf(page)).not.toBe(opened);
    const moved = await cameraOf(page);

    await page.getByRole('tab', { name: /看板/ }).click();
    await expect(page.locator('.trace-stage')).toBeHidden();
    expect(await columnsAcross(page)).toBe(true);
    const board = await page.locator('.trace-board-view').boundingBox();
    expect(board!.width).toBeGreaterThan(pane!.width - 2);
    const scrolls = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>('[data-board-status="todo"]');
      return !!column && getComputedStyle(column).overflowY === 'auto' && column.scrollHeight > column.clientHeight;
    });
    expect(scrolls).toBe(true);
    // Scrolled, the head sits flush with the column's top edge: no gap above it for cards to show through.
    const headGap = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>('[data-board-status="todo"]')!;
      column.scrollTop = 120;
      const head = column.querySelector<HTMLElement>('.ticket-column-head')!;
      return head.getBoundingClientRect().top - (column.getBoundingClientRect().top + column.clientTop);
    });
    expect(Math.abs(headGap)).toBeLessThan(1);

    // The spec as a page: the goal over the contract in a main column, the overview beside it.
    await page.getByRole('tab', { name: /要点/ }).click();
    await expect(page.locator('.trace-spec-view')).toBeVisible();
    const wide = await specColumns(page);
    expect(wide.side.x).toBeGreaterThan(wide.main.x + wide.main.width);
    expect(wide.overview.y).toBeLessThan(wide.goal.y + wide.goal.height);

    // Back on the trace, the camera is where it was: it was hidden, not resized.
    await page.getByRole('tab', { name: /流程/ }).click();
    await expect(page.locator('.trace-stage')).toBeVisible();
    expect(await cameraOf(page)).toBe(moved);

    // A narrow pane: the switch takes a row of its own; the board is the same five columns, sideways.
    await page.setViewportSize({ width: 390, height: 800 });
    const switcher = await page.locator('.trace-views').boundingBox();
    const title = await page.locator('.trace-titles').boundingBox();
    expect(switcher!.y).toBeGreaterThan(title!.y + title!.height - 1);
    await page.getByRole('tab', { name: /看板/ }).click();
    expect(await columnsAcross(page)).toBe(true);
    expect(await page.locator('.ticket-board').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // And the spec is one column: the goal, the overview, then the contract.
    await page.getByRole('tab', { name: /要点/ }).click();
    const narrow = await specColumns(page);
    expect(narrow.overview.y).toBeGreaterThan(narrow.goal.y + narrow.goal.height - 1);
    expect(narrow.main.y).toBeGreaterThan(narrow.overview.y + narrow.overview.height - 1);
    expect(narrow.overview.x).toBeLessThan(narrow.goal.x + 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    expect(errors).toEqual([]);
    await page.close();
  } finally {
    await browser.close();
  }
});

/** The trace's camera: the board's transform under the fixed viewport. */
async function cameraOf(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector<HTMLElement>('.trace-flow')?.style.transform ?? '');
}

/** Drag the trace by `by`, as a person pans it. */
async function panTrace(page: Page, by: { x: number; y: number }): Promise<void> {
  const box = (await page.locator('.trace-viewport').boundingBox())!;
  const from = { x: box.x + box.width / 2 + 200, y: box.y + box.height / 2 + 150 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 8 });
  await page.mouse.up();
}

/** Where the spec page's parts sit: its goal, its overview, its contract and its side. */
async function specColumns(page: Page) {
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
  return {
    goal: await box('.plan-spec-goal'),
    overview: await box('.plan-overview'),
    main: await box('.plan-spec-main'),
    side: await box('.plan-spec-about'),
  };
}

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
    await page.goto(`${baseURL}index.html?story=ticket26a-tall`);
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
    await page.getByRole('tab', { name: /看板/ }).click();
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

test('webkit: a card picked on the board shows its rounds on the trace, and the spec shows a ticket on the board', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    // The trace panned off its cards, so bringing a ticket's round back has somewhere to go.
    await panTrace(page, { x: -400, y: -250 });
    const away = await cameraOf(page);
    // The spec's ticket states bring the board up on that column.
    await page.getByRole('tab', { name: /要点/ }).click();
    await page.locator('.plan-overview button.plan-spec-ticket-state.is-doing').click();
    await expect(page.locator('.trace-board-view')).toBeVisible();
    await expect(page.locator('[data-board-status="doing"]')).toHaveClass(/is-focused/);
    // A picked card goes back to the trace, its round lit there.
    await page.locator('[data-ticket-id="tk-2"] .ticket-main').click();
    await page.locator('[data-ticket-id="tk-2"] .ticket-show-trace').click();
    await expect(page.locator('.trace-stage')).toBeVisible();
    expect(await page.getByRole('tab', { name: /流程/ }).getAttribute('aria-selected')).toBe('true');
    await expect(page.locator('.trace-card.is-lit')).toHaveCount(1);
    // And the camera slides to that card: it ends up in the middle of the view.
    await expect.poll(() => cameraOf(page)).not.toBe(away);
    const view = (await page.locator('.trace-viewport').boundingBox())!;
    await expect.poll(async () => {
      const card = (await page.locator('.trace-card.is-lit').boundingBox())!;
      return Math.abs(card.x + card.width / 2 - (view.x + view.width / 2)) < 40 && Math.abs(card.y + card.height / 2 - (view.y + view.height / 2)) < 40;
    }, { timeout: 3000 }).toBe(true);
    await page.close();
  } finally {
    await browser.close();
  }
});
