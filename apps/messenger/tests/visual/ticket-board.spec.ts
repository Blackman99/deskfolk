import { expect, test, webkit, type Page } from '@playwright/test';

/** The five columns side by side: each one's left edge is to the right of the one before it. */
async function columnsAcross(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const columns = [...document.querySelectorAll<HTMLElement>('[data-board-status]')];
    return columns.length === 5 && columns.every((column, index) => index === 0 || column.getBoundingClientRect().x > columns[index - 1]!.getBoundingClientRect().x + 40);
  });
}

test('webkit: a wide job shows the rail, the trace and the inspector side by side; the rail opens out into the board; narrow, one part at a time behind the switch', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    // No switch on a wide job: the three parts side by side, left to right.
    await expect(page.getByRole('tab')).toHaveCount(0);
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const rail = await box('.job-rail');
    const flow = await box('.job-flow');
    const inspector = await box('.job-inspector');
    expect(rail.x + rail.width).toBeLessThanOrEqual(flow.x + 1);
    expect(flow.x + flow.width).toBeLessThanOrEqual(inspector.x + 1);
    // Fifteen tickets are more than the rail holds: it scrolls on its own.
    expect(await page.locator('.rail-rows').evaluate((el) => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight)).toBe(true);
    // In its column the spec is one column: the goal, the overview under it, then the contract.
    const inColumn = await specColumns(page);
    expect(inColumn.overview.y).toBeGreaterThan(inColumn.goal.y + inColumn.goal.height - 1);
    expect(inColumn.overview.x).toBeLessThan(inColumn.goal.x + 2);
    // Moved by hand first, so coming back can show the camera was kept, not reopened.
    const opened = await cameraOf(page);
    await panTrace(page, { x: 160, y: 90 });
    await expect.poll(() => cameraOf(page)).not.toBe(opened);
    const moved = await cameraOf(page);

    // The rail opened out: the board's five columns over the rail and the trace, which stay hidden in place.
    await page.locator('.rail-expand').click();
    await expect(page.locator('.trace-stage')).toBeHidden();
    expect(await columnsAcross(page)).toBe(true);
    const board = await box('.job-board');
    expect(board.width).toBeGreaterThan(rail.width + flow.width - 2);
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
    // Closed again, the trace is where it was: it was hidden, not resized.
    await page.locator('.job-board-close').click();
    await expect(page.locator('.trace-stage')).toBeVisible();
    expect(await cameraOf(page)).toBe(moved);

    // The inspector widened over the tab: the spec lays out as a page, the overview beside the contract.
    await page.locator('.job-inspector .insp-icon[aria-pressed]').click();
    const wide = await specColumns(page);
    expect(wide.side.x).toBeGreaterThan(wide.main.x + wide.main.width);
    expect(wide.overview.y).toBeLessThan(wide.goal.y + wide.goal.height);
    await page.locator('.job-inspector .insp-icon[aria-pressed]').click();
    await expect(page.locator('.trace-stage')).toBeVisible();
    expect(await cameraOf(page)).toBe(moved);

    // Narrow: the switch takes a row of its own under the title, and the parts are one at a time.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByRole('tab')).toHaveText([/任务\s*15/, /流程/, /要点/]);
    const switcher = await box('.trace-views');
    const title = await box('.trace-titles');
    expect(switcher.y).toBeGreaterThan(title.y + title.height - 1);
    await page.getByRole('tab', { name: /任务/ }).click();
    await expect(page.locator('.rail-row').first()).toBeVisible();
    await expect(page.locator('.trace-stage')).toBeHidden();
    // A ticket picked comes up as a sheet over the rail's bottom.
    await page.locator('[data-rail-ticket="tk-2"]').click();
    const sheet = await box('.job-inspector.is-sheet');
    expect(sheet.y).toBeGreaterThan(300);
    expect(sheet.width).toBeGreaterThan(388);
    // The board opened out is the same five columns, sideways.
    await page.locator('.rail-expand').click();
    expect(await columnsAcross(page)).toBe(true);
    expect(await page.locator('.ticket-board').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // And the spec is one column: the goal, the overview, then the contract.
    await page.getByRole('tab', { name: /要点/ }).click();
    const narrow = await specColumns(page);
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
    await page.locator('.rail-expand').click();
    const board = page.locator('.ticket-board');
    // In view inside the board, which ends where the inspector beside it begins.
    const parkedInView = () => page.evaluate(() => document.querySelector('[data-board-status="parked"]')!.getBoundingClientRect().right <= document.querySelector('.ticket-board')!.getBoundingClientRect().right + 1);
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

test('webkit: a ticket shows its rounds on the trace from the inspector and from its lane, and the spec narrows the rail', async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${baseURL}index.html?story=ticket-board`);
    await expect(page.locator('.trace-stage')).toBeVisible({ timeout: 5000 });
    const centred = async () => {
      const view = (await page.locator('.trace-viewport').boundingBox())!;
      const card = (await page.locator('.trace-card.is-lit').boundingBox())!;
      return Math.abs(card.x + card.width / 2 - (view.x + view.width / 2)) < 40 && Math.abs(card.y + card.height / 2 - (view.y + view.height / 2)) < 40;
    };
    // The trace panned off its cards, so bringing a ticket's round back has somewhere to go.
    await panTrace(page, { x: -400, y: -250 });
    const away = await cameraOf(page);
    // The spec's ticket states let one status through on the rail.
    await page.locator('.plan-overview button.plan-spec-ticket-state.is-doing').click();
    await expect(page.locator('.rail-row')).toHaveCount(1);
    await expect(page.locator('.rail-filter')).toBeVisible();
    // Picked, the ticket's 「在流程里看」 lights its round and slides the camera to it.
    await page.locator('[data-rail-ticket="tk-2"]').click();
    await page.locator('.job-inspector .insp-link', { hasText: '在流程里看' }).click();
    await expect(page.locator('.trace-card.is-lit')).toHaveCount(1);
    await expect.poll(() => cameraOf(page)).not.toBe(away);
    await expect.poll(centred, { timeout: 3000 }).toBe(true);
    // Panned away again, a press on the ticket's lane brings its card back as well.
    await panTrace(page, { x: 380, y: 240 });
    const lane = (await page.locator('[data-rail-ticket="tk-2"] .rail-lane').boundingBox())!;
    await page.mouse.click(lane.x + lane.width * 0.75, lane.y + lane.height / 2);
    await expect.poll(centred, { timeout: 3000 }).toBe(true);
    await page.close();
  } finally {
    await browser.close();
  }
});
