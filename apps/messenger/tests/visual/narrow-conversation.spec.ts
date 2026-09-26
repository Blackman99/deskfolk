import { chromium, expect, test, webkit } from '@playwright/test';

/**
 * A conversation narrower than a phone in a wide window takes the phone layout. It used to ask
 * the window, so a workbench pane of 380px kept the desktop header and message lines: three
 * labelled actions squeezed the name, and a Bot's name and model broke onto lines of their own
 * (2026-09-23). The width is the conversation's own, through the `conversation` container.
 *
 * In a pane the tab above is the header at every width (2026-09-25): the tab always carries the
 * avatar and the name, a ⋯ shows while the tab is hovered, and a right-click on the tab offers
 * the same actions. The conversation itself has no second header.
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
			const tab = page.locator('.main .wb-tab').filter({ has: page.locator('.chat-tab') }).first();
			const picture = tab.locator('.wb-tab-icon');
			const more = tab.locator('.wb-tab-more');
			const paneMenu = page.locator('[data-testid="wb-context-menu"]');
			// The tab is the header at every width; the conversation has no second one.
			await expect(header).toHaveCount(0);
			await expect(picture).toBeVisible();
			await expect(index).toBeVisible();
			expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight))).toBe(180);

			const widen = (px: number) =>
				page.locator('.main').evaluate((el, width) => {
					el.style.maxWidth = `${width}px`;
				}, px);
			await widen(681);
			await expect(header).toHaveCount(0);
			await expect(picture).toBeVisible();
			await widen(680);
			await expect(header).toHaveCount(0);
			await expect(picture).toBeVisible();

			// The conversation as narrow as the report's workbench pane, in the same 1280px window.
			await widen(400);

			await expect(header).toBeHidden();
			await expect(picture).toBeVisible();
			await expect(tab.locator('.chat-tab-name')).toBeVisible();
			// The ⋯ keeps its room, so it is there to find, and shows once the tab is hovered.
			await page.mouse.move(0, 0);
			expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
			await tab.hover();
			await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
			await more.click();
			await expect(paneMenu.locator('[data-action]')).toHaveCount(3);
			await expect(paneMenu.locator('[data-split]')).toHaveCount(0);
			await paneMenu.locator('[data-action="settings"]').click();
			await expect(page.locator('.main .pane-side')).toBeVisible();
			await page.locator('.main .pane-side-scrim').click({ position: { x: 4, y: 200 } });
			await expect(page.locator('.main .pane-side')).toBeHidden();
			// A right-click on the tab offers the same, above the splits.
			await tab.locator('[role="tab"]').click({ button: 'right' });
			await expect(paneMenu.locator('[data-action]')).toHaveCount(3);
			await expect(paneMenu.locator('[data-split]')).toHaveCount(4);
			await page.keyboard.press('Escape');
			await expect(paneMenu).toBeHidden();

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
