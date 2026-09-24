import { chromium, expect, test, webkit } from '@playwright/test';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
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
