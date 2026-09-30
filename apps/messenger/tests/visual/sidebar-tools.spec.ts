import { chromium, expect, test, webkit, type Locator } from '@playwright/test';

const shownLabels = (footer: Locator) =>
	footer.evaluate((el) => [...el.querySelectorAll('.foot-label')].filter((label) => getComputedStyle(label).display !== 'none').length);

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test(`${name}: a sidebar under 240px shows its footer as icons even where the words fit`, async ({ baseURL }) => {
		const browser = await engine.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
			await page.goto(`${baseURL}index.html?story=sidebar&theme=light`);
			await page.waitForSelector('html[data-ready="yes"]');
			const footer = page.locator('.foot');
			for (const [width, words] of [[300, true], [240, true], [239, false], [200, false], [240, true]] as const) {
				await page.locator('#story').evaluate((el, value) => { el.style.width = `${value}px`; }, width);
				await expect.poll(() => shownLabels(footer), { message: `${width}px` }).toEqual(words ? 3 : 0);
				expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			}
			const buttons = footer.locator('.foot-action');
			await expect(buttons).toHaveCount(3);
			await page.locator('#story').evaluate((el) => { el.style.width = '200px'; });
			await expect.poll(() => shownLabels(footer)).toEqual(0);
			expect(await buttons.evaluateAll((all) => all.map((button) => [button.getAttribute('aria-label'), !!button.querySelector('svg')]))).toEqual([
				['工作区', true], ['工具', true], ['设置', true]
			]);
			expect(await page.locator('.tools-chevron').evaluate((el) => getComputedStyle(el).display)).toBe('none');
		} finally {
			await browser.close();
		}
	});

	test(`${name}: sidebar tools fit English labels and move between desktop and phone`, async ({ baseURL }) => {
		const browser = await engine.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
			await page.goto(`${baseURL}index.html?story=sidebar-tools&theme=light`);
			await page.waitForSelector('html[data-ready="yes"]');
			const footer = page.locator('.foot');
			const toggle = page.locator('.tools-entry');
			const menu = page.locator('.tools-menu');
			await expect(footer.locator('button')).toHaveText(['Workspace', 'Tools', 'Settings']);
			for (const width of [300, 260, 200]) {
				await page.locator('#story').evaluate((el, value) => { el.style.width = `${value}px`; }, width);
				const within = await footer.evaluate((el) => {
					const bounds = el.getBoundingClientRect();
					return [...el.querySelectorAll('button')].every((button) => {
						const box = button.getBoundingClientRect();
						return box.left >= bounds.left && box.right <= bounds.right && box.height >= 36;
					});
				});
				expect(within).toBe(true);
			}
			// Written out while they fit, icons once they no longer do, and back again.
			for (const [width, words] of [[300, true], [290, true], [260, true], [250, false], [200, false], [260, true], [300, true]] as const) {
				await page.locator('#story').evaluate((el, value) => { el.style.width = `${value}px`; }, width);
				await expect.poll(() => shownLabels(footer), { message: `${width}px` }).toEqual(words ? 3 : 0);
			}
			await toggle.click();
			await expect(menu.getByRole('menuitem')).toHaveText(['Routines', 'Spend', 'New terminal', 'Archived sessions']);
			await expect(menu.getByRole('menuitem').first()).toBeFocused();
			await page.keyboard.press('End');
			await expect(menu.getByRole('menuitem').last()).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(toggle).toBeFocused();
			await expect(menu).toHaveCount(0);
			await toggle.click();
			await page.locator('#story').evaluate((el) => { el.style.width = '260px'; });
			await expect.poll(async () => {
				const anchor = await toggle.boundingBox();
				const box = await menu.boundingBox();
				return Math.abs(box!.x - anchor!.x);
			}).toBeLessThan(1);
			await page.keyboard.press('Tab');
			await expect(menu).toHaveCount(0);
			// WebKit follows macOS keyboard preferences, which can skip buttons on Tab.
			if (name === 'chromium') await expect(footer.getByRole('button', { name: 'Settings' })).toBeFocused();
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(footer).toHaveCount(0);
			await toggle.click();
			await expect(menu.getByRole('menuitem')).toHaveText(['Routine calendar', 'Spend', 'Terminal', 'Archived sessions']);
			const box = await menu.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(390);
			await menu.getByRole('menuitem', { name: 'Archived sessions' }).click();
			await expect(page.locator('.archived-empty-hint')).toBeVisible();
			await page.getByRole('button', { name: 'Back to sessions' }).click();
			await toggle.click();
			await page.setViewportSize({ width: 1000, height: 820 });
			await expect(menu).toHaveCount(0);
			await expect(footer.locator('button')).toHaveCount(3);
		} finally {
			await browser.close();
		}
	});
}
