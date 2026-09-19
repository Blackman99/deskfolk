import { expect, test } from '@playwright/test';
import { STORY_SIZES } from './story-list.ts';

/**
 * One shot per pane per theme, against the component mounted on its own with fixture data.
 * The story page sets `data-ready` once it is mounted, so a shot never races the first paint.
 *
 * A pane that throws on mount still paints something, and a shot of the wreckage is a baseline
 * like any other — so the errors are an assertion, not a warning. This is how the malformed arc
 * in the code-block copy icon was found.
 */
for (const [name, size] of Object.entries(STORY_SIZES)) {
	for (const theme of ['dark', 'light'] as const) {
		test(`${name} · ${theme}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(String(e)));
			page.on('console', (m) => {
				if (m.type() === 'error') errors.push(m.text());
			});
			await page.setViewportSize(size);
			await page.goto(`index.html?story=${name}&theme=${theme}`);
			await page.waitForSelector('html[data-ready="yes"]');
			await page.evaluate(() => document.fonts.ready);
			await expect(page).toHaveScreenshot(`${name}-${theme}.png`);
			expect(errors).toEqual([]);
		});
	}
}
