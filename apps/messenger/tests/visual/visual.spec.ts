import { expect, test } from '@playwright/test';
import { STORY_SIZES } from './story-list.ts';

/**
 * One shot per pane per theme, against the component mounted on its own with fixture data.
 * The story page sets `data-ready` once it is mounted, so a shot never races the first paint.
 */
for (const [name, size] of Object.entries(STORY_SIZES)) {
	for (const theme of ['dark', 'light'] as const) {
		test(`${name} · ${theme}`, async ({ page }) => {
			await page.setViewportSize(size);
			await page.goto(`index.html?story=${name}&theme=${theme}`);
			await page.waitForSelector('html[data-ready="yes"]');
			await page.evaluate(() => document.fonts.ready);
			await expect(page).toHaveScreenshot(`${name}-${theme}.png`);
		});
	}
}
