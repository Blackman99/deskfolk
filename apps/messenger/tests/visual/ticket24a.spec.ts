import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  test(`${name}: persisted delegation in actual read-only peer ChatStage at desktop and phone widths`, async ({ baseURL }) => {
    const browser = await engine.launch();
    try {
      for (const width of [900, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1100 } });
        const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${baseURL}index.html?story=${width === 900 ? 'ticket24a' : 'ticket24a-en'}`);
        const records = page.locator('.delegation-records');
        await expect(records).toContainText('审 Shot 11');
        await expect(records).toContainText('2 通过 1 不通过');
        await expect(records.locator('.delegation-wait')).toHaveCount(1);
        await expect(records).not.toContainText(width === 900 ? '约定时间' : 'Due');
        await expect(page.locator('[data-message-id="ordinary-peer"]')).toContainText('普通讨论');
        await expect(page.locator('[data-message-id="linked-request"], [data-message-id="linked-result"]')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveAttribute('contenteditable', 'false');
        await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
        await expect(records.locator('script, a[href^="javascript:"]')).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, 'fixtureInjection'))).toBeUndefined();
        await records.getByRole('link', { name: 'review.md' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-opened-artifact', 'fixture/review.md');
        const box = await records.boundingBox(); expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.locator('#story').dispatchEvent('fixture-held');
        await expect(records).toContainText(width === 900 ? '等待已挂起：被叫停' : 'Wait suspended: held');
        await expect(records).not.toContainText(width === 900 ? '（等结果）' : '(waiting for result)');
        await expect(records).toHaveScreenshot(`ticket24a-held-${name}-${width}.png`);
        await page.locator('#story').dispatchEvent('fixture-continue');
        await expect(records.locator('.delegation-wait')).toHaveCount(0);
        await expect(records).not.toContainText(width === 900 ? '（等结果）' : '(waiting for result)');
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
