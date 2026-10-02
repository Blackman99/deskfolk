import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  test(`${name}: ticket stages and parts passed read on the board at desktop and phone widths`, async ({ baseURL }) => {
    const browser = await engine.launch();
    try {
      for (const [story, width, labels, parts] of [
        ['ticket26a', 900, ['审查中', '返工', '已交付', '已通过', '待做'], ['11/12 已通过', '3/3 已通过']],
        ['ticket26a-en', 390, ['In review', 'Rework', 'Submitted', 'Approved', 'To do'], ['11/12 approved', '3/3 approved']],
      ] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${baseURL}index.html?story=${story}`);
        await expect(page.locator('.ticket-row')).toHaveCount(5, { timeout: 3000 });
        await expect(page.locator('.ticket-row .ticket-status')).toHaveText([...labels]);
        await expect(page.locator('.ticket-row .ticket-parts')).toHaveText([...parts]);
        // The stage label keeps the colour of the status it reads as.
        await expect(page.locator('.ticket-row').nth(1).locator('.ticket-status')).toHaveClass(/is-doing/);
        // Each row has the reviewer's menu beside the status menu; the first shows its reviewer.
        await expect(page.locator('.ticket-row').first().locator('.real-select-trigger')).toHaveCount(2);
        await expect(page.locator('.ticket-row').first().locator('.ticket-reviewer-wrap')).toContainText('审片员');
        await page.locator('.ticket-row').nth(1).locator('.ticket-reviewer-wrap .real-select-trigger').click();
        await page.locator('.ticket-row').nth(1).locator('.real-select-option', { hasText: '审片员' }).click();
        await expect.poll(() => page.evaluate(() => JSON.parse(document.body.dataset.ticketPatches ?? '[]'))).toEqual([{ id: 't2', body: { reviewer_bot_id: 'bot-2', if_revision: 1 } }]);
        // Nothing spills sideways, at either width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        for (const row of await page.locator('.ticket-line').all()) {
          const box = await row.boundingBox();
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
