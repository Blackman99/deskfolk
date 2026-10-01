import { expect, test } from '@playwright/test';

for (const mode of ['desktop', 'phone'] as const) {
  test(`actual ChatStage ${mode}: explicit exact answer, refused draft, held receipt, readonly saved event`, async ({ page }, testInfo) => {
    const phone = mode === 'phone';
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1100, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`?story=${phone ? 'work-question-en' : 'work-question'}&theme=dark`);
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'yes');
    const card = page.locator('[data-message-id="fixture-question"] .work-question-card');
    await expect(card).toContainText('Synthetic Director · Synthetic Trailer · Vertical cut');
    await expect(card.locator('.work-question-text')).toHaveText('片长要多少？\nWhich aspect ratio? 🦊');
    await expect(page.locator('.ask-card,.control-actions,.btn-continue-turn')).toHaveCount(0);
    const answer = '  ９０ 秒 🎬\n竖屏 9:16\n ';
    await card.locator('textarea').fill(answer);
    await card.locator('textarea').press('Enter');
    expect(await page.evaluate(() => JSON.parse(document.body.dataset.workAnswerCalls!))).toEqual([]);
    // Enter edits the text; it is not a send shortcut. Refill independently known exact bytes.
    await card.locator('textarea').fill(answer);
    await page.locator('#story').dispatchEvent('fixture-refuse');
    await card.getByRole('button', { name: phone ? 'Save answer' : '保存回答', exact: true }).click();
    await expect(card.locator('[role="alert"]')).toContainText(phone ? 'your draft is kept' : '你的草稿已保留');
    await expect(card.locator('textarea')).toHaveValue(answer);
    await page.locator('#story').dispatchEvent('fixture-allow');
    await page.locator('#story').dispatchEvent('fixture-defer');
    await card.getByRole('button', { name: phone ? 'Save answer' : '保存回答', exact: true }).click();
    await expect(card.getByRole('button')).toBeDisabled();
    await page.locator('#story').dispatchEvent('fixture-release');
    await expect(card.locator('.work-question-answer')).toHaveText(answer);
    expect(await card.locator('.work-question-answer').textContent()).toBe(answer);
    await expect(card.locator('[role="status"]')).toContainText(phone ? 'remains stopped' : '仍处于叫停状态');
    await expect(card.locator('time')).toHaveAttribute('datetime', '2026-10-01T02:00:00.000Z');
    await expect(card.locator('button,textarea')).toHaveCount(0);
    const calls = await page.evaluate(() => JSON.parse(document.body.dataset.workAnswerCalls!));
    expect(calls).toHaveLength(2);
    expect(calls.map((row: { method: string; path: string; body: string }) => [row.method, row.path, row.body])).toEqual([
      ['POST', '/v1/messages/fixture-question/work-answer', answer], ['POST', '/v1/messages/fixture-question/work-answer', answer],
    ]);
    expect(calls[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const rect = await card.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(phone ? 390 : 1100);
    await page.screenshot({ path: testInfo.outputPath(`work-question-${mode}-held.png`), fullPage: true });
    await page.locator('#story').dispatchEvent('fixture-reload-answer');
    expect(await card.locator('.work-question-answer').textContent()).toBe(' saved on another device\n✅ ');
    await expect(card.locator('button,textarea')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(document.body.dataset.workAnswerCalls!).length)).toBe(2);
    expect(errors).toEqual([]);
  });
}
