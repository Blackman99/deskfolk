import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  test(`${name}: ticket stages and parts passed read on the board at desktop and phone widths`, async ({ baseURL }) => {
    const browser = await engine.launch();
    try {
      for (const [story, width, labels, parts] of [
        ['ticket26a', 900, { '分镜 Storyboard': '审查中', '母带 Master cut with a long title that has to wrap on a phone': '返工', '配乐': '已交付', '海报': '已通过', '字幕': '待做' }, ['11/12 已通过', '3/3 已通过']],
        ['ticket26a-en', 390, { '分镜 Storyboard': 'In review', '母带 Master cut with a long title that has to wrap on a phone': 'Rework', '配乐': 'Submitted', '海报': 'Approved', '字幕': 'To do' }, ['11/12 approved', '3/3 approved']],
      ] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${baseURL}index.html?story=${story}`);
        await expect(page.locator('.ticket-row')).toHaveCount(5, { timeout: 3000 });
        // Columns group by status, so a card's stage is read from the card, not from its place in the list.
        const stages = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.ticket-row')].map((row) => [row.querySelector('.ticket-title')?.textContent?.trim() ?? '', row.querySelector('.ticket-status')?.textContent?.trim() ?? ''])));
        expect(stages).toEqual(labels);
        await expect(page.locator('.ticket-row .ticket-parts')).toHaveText([...parts]);
        // The stage label keeps the colour of the status it reads as.
        const rework = page.locator('.ticket-row', { hasText: '母带' });
        const inReview = page.locator('.ticket-row', { hasText: '分镜' });
        await expect(rework.locator('.ticket-status')).toHaveClass(/is-doing/);
        // Unpicked, a row has its status menu only and says who reviews it; picked, the reviewer's menu opens below.
        await expect(inReview.locator('.real-select-trigger')).toHaveCount(1);
        await expect(inReview.locator('.ticket-meta-reviewer')).toContainText('审片员');
        await inReview.locator('.ticket-main').click();
        await expect(inReview.locator('.real-select-trigger')).toHaveCount(2);
        await expect(inReview.locator('.ticket-reviewer-wrap')).toContainText('审片员');
        await rework.locator('.ticket-main').click();
        await rework.locator('.ticket-reviewer-wrap .real-select-trigger').click();
        await rework.locator('.real-select-option', { hasText: '审片员' }).click();
        await expect.poll(() => page.evaluate(() => JSON.parse(document.body.dataset.ticketPatches ?? '[]'))).toEqual([{ id: 't2', body: { reviewer_bot_id: 'bot-2', if_revision: 1 } }]);
        // Nothing spills sideways, at either width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        // Stacked, every head fits the width. Across, only the columns actually in view are checked.
        for (const row of await page.locator('.ticket-head, .ticket-settings').all()) {
          const box = await row.boundingBox();
          if (!box || box.x >= width) continue;
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
        expect(errors).toEqual([]);
        await page.close();
      }

      if (name === 'webkit') {
        const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
        await page.goto(`${baseURL}index.html?story=ticket26a-columns`);
        await expect(page.locator('[data-board-status]')).toHaveCount(5, { timeout: 3000 });
        const layout = await page.evaluate(() => {
          const columns = [...document.querySelectorAll<HTMLElement>('[data-board-status]')];
          const todo = document.querySelector<HTMLElement>('[data-board-status="todo"]');
          return {
            across: columns.every((column, index) => index === 0 || column.getBoundingClientRect().x > columns[index - 1]!.getBoundingClientRect().x),
            // The one column given more cards than fit scrolls on its own; the short ones stay put.
            scrolls: !!todo && getComputedStyle(todo).overflowY === 'auto' && todo.scrollHeight > todo.clientHeight,
          };
        });
        expect(layout.across).toBe(true);
        expect(layout.scrolls).toBe(true);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
