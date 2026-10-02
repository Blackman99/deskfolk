import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  test(`${name}: attribution tags and dialog work at desktop and phone widths`, async ({ baseURL }) => {
    const browser = await engine.launch();
    try {
      for (const width of [900, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1100 } });
        await page.goto(`${baseURL}index.html?story=ticket23d`);
        await expect(page.locator('.group-lead-card')).toHaveCount(0, { timeout: 3000 });
        const chip = page.locator('[data-message-id="filing-user"] .attribution-chip');
        await expect(chip).toContainText('EP01');
        await expect(chip).toContainText('剪辑 · Shot 01');
        const tag = await chip.boundingBox();
        expect(tag).not.toBeNull();
        expect(tag!.x + tag!.width).toBeLessThanOrEqual(width);
        await expect(page.locator('[data-message-id="filing-bot"] .attribution-chip')).toContainText('未归属');
        await chip.click();
        const dialog = page.getByRole('dialog', { name: '归到哪件事' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: /显示其他/ }).click();
        await dialog.getByLabel('海报', { exact: true }).check();
        await dialog.getByLabel('分件 · EP01').fill('Shot 02');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await expect(dialog.getByRole('status')).toContainText('你的选择已保留');
        await expect(dialog.getByLabel('分件 · EP01')).toHaveValue('Shot 02');
        await expect(dialog.getByLabel('海报', { exact: true })).toBeChecked();
        await expect(dialog.getByRole('button', { name: '不归到任何事' })).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(1100);
        await expect(dialog).toHaveScreenshot(`ticket23d-editor-${name}-${width}.png`);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(chip).toContainText('EP01');
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
