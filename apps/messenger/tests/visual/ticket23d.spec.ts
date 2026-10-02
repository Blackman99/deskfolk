import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  test(`${name}: attribution controls work at desktop and phone widths`, async ({ baseURL }) => {
    const browser = await engine.launch();
    try {
      for (const width of [900, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1100 } });
        await page.goto(`${baseURL}index.html?story=ticket23d`);
        await expect(page.locator('[data-message-id="filing-user"] .message-attribution')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('.group-lead-card')).toHaveCount(0);
        const attribution = page.locator('[data-message-id="filing-user"] .message-attribution');
        await expect(attribution).toContainText('归到：EP01 · 剪辑 · Shot 01');
        await attribution.getByRole('button', { name: '改', exact: true }).click();
        await attribution.getByLabel('海报', { exact: true }).check();
        await attribution.getByLabel('分件 · EP01').fill('Shot 02');
        await attribution.getByRole('button', { name: '保存', exact: true }).click();
        await expect(attribution.getByRole('status')).toContainText('你的选择已保留');
        await expect(attribution.getByLabel('分件 · EP01')).toHaveValue('Shot 02');
        await expect(attribution.getByLabel('海报', { exact: true })).toBeChecked();
        await expect(attribution).toContainText('归到：EP01 · 剪辑 · Shot 01');
        const editor = attribution.locator('form');
        const box = await editor.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await expect(editor).toHaveScreenshot(`ticket23d-editor-${name}-${width}.png`);
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
