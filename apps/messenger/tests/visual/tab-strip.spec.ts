import { chromium, expect, test, webkit } from '@playwright/test';

/**
 * A tab row scrolls only when its tabs do not fit. The active tab's flares reach out past its
 * sides, and the last tab's used to count as something to scroll to: with the last tab active —
 * which a pane of one tab always is — the row was a flare wider than its tabs, and bringing that
 * tab into view scrolled the whole strip by 8px, cutting into the first tab. Every switch to or
 * from the last tab jumped the strip sideways (2026-09-26).
 *
 * happy-dom has no layout, so this is measured in the browsers.
 */
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		test('a tab row that fits never scrolls, whichever of its tabs is active', async ({ baseURL }) => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
				await page.goto(`${baseURL}index.html?story=workbench`);
				await page.waitForSelector('html[data-ready="yes"]');
				await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				const rows = await page.$$eval('.wb-tabs', (elements) =>
					elements.map((row) => {
						const tabs = [...row.querySelectorAll(':scope > .wb-tab')];
						return {
							tabs: tabs.length,
							lastActive: tabs.at(-1)?.classList.contains('is-active') ?? false,
							scrollLeft: row.scrollLeft,
							overflow: row.scrollWidth - row.clientWidth
						};
					})
				);
				// The story holds panes of one tab, whose tab is both the active and the last one.
				expect(rows.some((row) => row.lastActive)).toBe(true);
				for (const row of rows) expect(row).toMatchObject({ scrollLeft: 0, overflow: 0 });
			} finally {
				await browser.close();
			}
		});
	});
}
