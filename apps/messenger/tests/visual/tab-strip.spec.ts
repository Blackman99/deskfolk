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

		test('an empty pane under another starts at the gutter, its ⋯ and × in its corner', async ({ baseURL }) => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
				await page.goto(`${baseURL}index.html?story=workbench-split-empty`);
				await page.waitForSelector('html[data-ready="yes"]');
				await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
				const box = (selector: string) =>
					page.$eval(selector, (element) => {
						const r = element.getBoundingClientRect();
						return { top: r.top, right: r.right, bottom: r.bottom };
					});
				const upper = await box('[data-leaf="p1"] > .wb-body');
				const lower = await box('[data-leaf="p2"] > .wb-body');
				const close = await box('[data-leaf="p2"] .wb-pane-close');
				// 4px under the upper card, the one-pixel seam, 4px over the lower one.
				expect(lower.top - upper.bottom).toBe(9);
				expect(close.top).toBeGreaterThanOrEqual(lower.top);
				expect(close.right).toBeLessThanOrEqual(lower.right);
			} finally {
				await browser.close();
			}
		});

		test('a junction draws nothing at rest, and its middle drags it with the pointer', async ({ baseURL }) => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
				await page.goto(`${baseURL}index.html?story=workbench`);
				await page.waitForSelector('html[data-ready="yes"]');
				const junction = page.locator('.wb-junction').first();
				const paint = () =>
					junction.evaluate((element) => getComputedStyle(element, '::before').backgroundColor);
				expect(await paint()).toBe('rgba(0, 0, 0, 0)');
				const box = (await junction.boundingBox())!;
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await expect.poll(paint).not.toBe('rgba(0, 0, 0, 0)');
				// Its middle is its own, not the divider's under it, and in hand it goes with the pointer.
				await page.mouse.down();
				await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 4 });
				const held = (await junction.boundingBox())!;
				expect(Math.round(held.x - box.x)).toBe(-60);
				expect(Math.round(held.y - box.y)).toBe(-40);
				await expect.poll(paint).not.toBe('rgba(0, 0, 0, 0)');
				await page.mouse.up();
				// Released, it is placed from the layout again. The story's `onLayout` keeps nothing,
				// so that is where it started.
				const after = (await page.locator('.wb-junction').first().boundingBox())!;
				expect(Math.round(after.x - box.x)).toBe(0);
				expect(Math.round(after.y - box.y)).toBe(0);
			} finally {
				await browser.close();
			}
		});

		test('a row with more tabs than fit fades and shows an arrow at the edge there is more past', async ({ baseURL }) => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage({ viewport: { width: 520, height: 320 } });
				await page.goto(`${baseURL}index.html?story=workbench-tabs`);
				await page.waitForSelector('html[data-ready="yes"]');
				const row = page.locator('.wb-tabs').first();
				const fades = () =>
					row.evaluate((element) => ({
						start: element.classList.contains('has-more-start'),
						end: element.classList.contains('has-more-end'),
						mask: getComputedStyle(element).webkitMaskImage || getComputedStyle(element).maskImage
					}));
				await row.evaluate((element) => (element.scrollLeft = 0));
				await expect.poll(fades).toMatchObject({ start: false, end: true });
				expect((await fades()).mask).toContain('gradient');
				await expect(page.locator('.wb-tabs-step.is-back')).toHaveCount(0);
				await page.locator('.wb-tabs-step.is-forward').click();
				await expect.poll(() => row.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
				await expect(page.locator('.wb-tabs-step.is-back')).toHaveCount(1);
				await row.evaluate((element) => (element.scrollLeft = element.scrollWidth));
				await expect.poll(fades).toMatchObject({ start: true, end: false });
				await expect(page.locator('.wb-tabs-step.is-forward')).toHaveCount(0);
				await row.evaluate((element) => (element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2));
				await expect.poll(fades).toMatchObject({ start: true, end: true });

				// A row that fits fades at neither edge.
				await page.setViewportSize({ width: 1280, height: 820 });
				await page.goto(`${baseURL}index.html?story=workbench`);
				await page.waitForSelector('html[data-ready="yes"]');
				for (const each of await page.locator('.wb-tabs').all()) {
					expect(await each.evaluate((element) => element.className)).not.toMatch(/has-more/);
				}
				await expect(page.locator('.wb-tabs-step')).toHaveCount(0);
			} finally {
				await browser.close();
			}
		});
	});
}
