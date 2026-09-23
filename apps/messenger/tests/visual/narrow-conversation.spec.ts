import { chromium, expect, test, webkit } from '@playwright/test';

/**
 * A conversation narrower than a phone in a wide window takes the phone layout. It used to ask
 * the window, so a workbench pane of 380px kept the desktop header and message lines: three
 * labelled actions squeezed the name, and a Bot's name and model broke onto lines of their own
 * (2026-09-23). The width is the conversation's own, through the `conversation` container.
 *
 * The container is a size query and nothing more. `contain` was taken off panes because it made
 * `fixed` menus resolve against the pane, so the right-click menu is checked to open at the
 * pointer, not a column's width away from it.
 */
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		test('a narrow conversation in a wide window lays out like a phone', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
			await page.goto(`${baseURL}index.html?story=shell`);
			await page.waitForSelector('html[data-ready="yes"]');
			const header = page.locator('.main .top.has-session');
			const index = page.locator('.main .message-index');
			const input = page.locator('.main .composer-input');
			await expect(header.locator('.top-actions')).toBeVisible();
			await expect(header.locator('.mobile-actions')).toBeHidden();
			await expect(index).toBeVisible();
			expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight))).toBe(180);

			// The conversation as narrow as the report's workbench pane, in the same 1280px window.
			await page.locator('.main').evaluate((el) => {
				el.style.maxWidth = '400px';
			});

			await expect(header.locator('.top-actions')).toBeHidden();
			await expect(header.locator('.mobile-actions')).toBeVisible();
			// Back walks a phone out to the roster; here the roster is still on screen.
			await expect(header.locator('.btn-mobile-back')).toBeHidden();
			await expect(index).toBeHidden();
			expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight))).toBeLessThanOrEqual(120);

			const lines = await page.locator('.main .msg-header').evaluateAll((rows) =>
				rows.map((row) => {
					const name = row.querySelector('.sender-name');
					const lineHeight = name ? parseFloat(getComputedStyle(name).lineHeight) : 0;
					return name ? Math.round(name.getBoundingClientRect().height / lineHeight) : 1;
				})
			);
			expect(lines.length).toBeGreaterThan(0);
			expect(Math.max(...lines)).toBe(1);
			await expect(page.locator('.main .msg-header .model-badge').first()).toBeHidden();

			const bubble = await page.locator('.main article.msg').first().boundingBox();
			if (!bubble) throw new Error('no message to right-click');
			const at = { x: Math.round(bubble.x + 20), y: Math.round(bubble.y + bubble.height / 2) };
			await page.mouse.click(at.x, at.y, { button: 'right' });
			const menu = await page.locator('.msg-context-menu').boundingBox();
			if (!menu) throw new Error('no context menu');
			const dx = Math.max(menu.x - at.x, 0, at.x - (menu.x + menu.width));
			const dy = Math.max(menu.y - at.y, 0, at.y - (menu.y + menu.height));
			expect(Math.hypot(dx, dy)).toBeLessThan(16);
			await browser.close();
		});
	});
}
