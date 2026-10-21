import { expect, test, webkit, type Browser, type Page } from '@playwright/test';

/** The head's title: how many rows it takes, whether it is clipped, and whether the row overflows the head. */
async function measure(page: Page): Promise<{ rows: number; clipped: boolean; overflows: boolean }> {
  return page.evaluate(() => {
    const head = document.querySelector<HTMLElement>('.tm-head')!;
    const heading = head.querySelector<HTMLElement>('h2')!;
    const meta = head.querySelector<HTMLElement>('.tm-head-meta')!;
    const text = document.createRange();
    text.selectNodeContents(heading);
    return {
      // By where each piece of text sits: an ellipsis splits a clipped row into two boxes in Chromium.
      rows: new Set([...text.getClientRects()].map((box) => Math.round(box.top))).size,
      clipped: heading.scrollWidth > heading.clientWidth,
      overflows: meta.getBoundingClientRect().right > head.getBoundingClientRect().right,
    };
  });
}

async function open(page: Page, baseURL: string | undefined, story: string): Promise<void> {
  await page.goto(`${baseURL}index.html?story=${story}`);
  await expect(page.locator('.tm-head h2')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.tm-plate').first()).toBeVisible({ timeout: 5000 });
}

async function headHolds(page: Page, baseURL: string | undefined): Promise<void> {
  // Room to spare: the whole title on one row, the switcher's button or the bare heading alike.
  await open(page, baseURL, 'taskmap-head-one');
  expect(await measure(page)).toEqual({ rows: 1, clipped: false, overflows: false });
  await open(page, baseURL, 'taskmap-head');
  expect(await measure(page)).toEqual({ rows: 1, clipped: false, overflows: false });
  // No room: still one row, clipped, the count kept in the head.
  await open(page, baseURL, 'taskmap-head-narrow');
  expect(await measure(page)).toEqual({ rows: 1, clipped: true, overflows: false });
}

test('the task map head: one row for its title, clipped only when the row runs out', async ({ page, baseURL }) => {
  await headHolds(page, baseURL);
});

test('webkit: the task map head holds the same way', async ({ baseURL }) => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await headHolds(page, baseURL);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
  }
});
