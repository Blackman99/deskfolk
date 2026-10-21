import { expect, test, webkit, type Browser, type Page } from '@playwright/test';

type Card = { top: number; bottom: number; height: number; scrolls: boolean };

/** What was asked and the moments: where each card is and whether its list scrolls; and the note's top. */
async function measure(page: Page): Promise<{ said: Card; moments: Card; noteTop: number }> {
  return page.evaluate(() => {
    const card = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector)!;
      const box = el.getBoundingClientRect();
      const list = el.querySelector<HTMLElement>('.tm-list')!;
      return { top: box.top, bottom: box.bottom, height: box.height, scrolls: list.scrollHeight > list.clientHeight + 1 };
    };
    const note = document.querySelector<HTMLElement>('#story > p')!;
    return { said: card('.tm-said'), moments: card('.tm-moments'), noteTop: note.getBoundingClientRect().top };
  });
}

async function open(page: Page, baseURL: string | undefined, story: string): Promise<void> {
  await page.goto(`${baseURL}index.html?story=${story}`);
  await expect(page.locator('.tm-moments')).toBeVisible({ timeout: 5000 });
}

async function sharesTheColumn(page: Page, baseURL: string | undefined): Promise<void> {
  // Both long: half each, each list scrolling in its own card, nothing over the note.
  await open(page, baseURL, 'taskmap-side');
  const both = await measure(page);
  expect(Math.abs(both.said.height - both.moments.height)).toBeLessThanOrEqual(2);
  expect(both.said.scrolls).toBe(true);
  expect(both.moments.scrolls).toBe(true);
  expect(both.moments.bottom).toBeLessThanOrEqual(both.noteTop);

  // A short list keeps only its lines; the long one takes the rest.
  await open(page, baseURL, 'taskmap-side-few-said');
  const fewSaid = await measure(page);
  expect(fewSaid.said.scrolls).toBe(false);
  expect(fewSaid.moments.height).toBeGreaterThan(fewSaid.said.height * 2);
  expect(fewSaid.moments.bottom).toBeLessThanOrEqual(fewSaid.noteTop);

  await open(page, baseURL, 'taskmap-side-few-moments');
  const fewMoments = await measure(page);
  expect(fewMoments.moments.scrolls).toBe(false);
  expect(fewMoments.said.height).toBeGreaterThan(fewMoments.moments.height * 2);
  expect(fewMoments.said.scrolls).toBe(true);
  expect(fewMoments.moments.bottom).toBeLessThanOrEqual(fewMoments.noteTop);

  // Both short: each its lines, one under the other.
  await open(page, baseURL, 'taskmap-side-few');
  const few = await measure(page);
  expect(few.said.scrolls).toBe(false);
  expect(few.moments.scrolls).toBe(false);
  expect(few.moments.top).toBeGreaterThan(few.said.bottom);
}

test('the task map side column: what was asked and the moments share what the leads leave', async ({ page, baseURL }) => {
  await sharesTheColumn(page, baseURL);
});

test('webkit: the task map side column shares the same way', async ({ baseURL }) => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 300, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await sharesTheColumn(page, baseURL);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
  }
});
