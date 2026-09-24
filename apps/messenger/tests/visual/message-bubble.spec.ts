import { chromium, expect, test, webkit, type Browser } from '@playwright/test';

/**
 * What a narrow bubble has to hold. Layout, so nothing happy-dom can measure; WebKit is the desktop
 * window's engine. Each case pins a bubble of the chat-stage story to the width the report had.
 */
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		let browser: Browser;
		test.beforeAll(async () => {
			browser = await engine.launch();
		});
		test.afterAll(async () => {
			await browser.close();
		});

		async function openStage(baseURL: string | undefined) {
			const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
			await page.goto(`${baseURL}index.html?story=chat-stage`);
			await page.waitForSelector('html[data-ready="yes"]');
			return page;
		}

		/**
		 * The hover pill is absolutely placed inside the bubble, so it shrank to it: "✓ 已复制" broke
		 * after every character (a 78px pill over a 57px "你好", 2026-09-23), and once it stopped
		 * breaking it ran across the avatar.
		 */
		test('the copied pill stays on one line and grows away from the avatar', async ({ baseURL }) => {
			const page = await openStage(baseURL);
			for (const side of ['is-user', 'is-bot'] as const) {
				const msg = page.locator(`.msg-wrap.${side}:not(.is-system-row) article.msg`).first();
				await msg.evaluate((el) => {
					el.style.width = '48px';
				});
				await msg.hover();
				const pill = msg.locator('.msg-toolbar-pill');
				const idle = await pill.boundingBox();
				await msg.locator('.act-btn').last().click();
				await expect(msg.locator('.copied-badge')).toBeVisible();
				const copied = await pill.boundingBox();
				const bubble = await msg.boundingBox();
				if (!idle || !copied || !bubble) throw new Error(`${side}: nothing to measure`);
				expect(copied.height, side).toBeLessThan(idle.height + 8);
				// Your avatar is to the right of your bubble, a Bot's to the left of its.
				if (side === 'is-user') expect(copied.x + copied.width, side).toBeLessThanOrEqual(bubble.x + bubble.width);
				else expect(copied.x, side).toBeGreaterThanOrEqual(bubble.x);
			}
			await page.close();
		});

		/**
		 * A file chip sized itself to its name, up to 240px, whatever the bubble: in a narrow window
		 * a screenshot's chip ran past the bubble and under the avatar (2026-09-23).
		 */
		test('a file chip gives way to a bubble the window narrowed', async ({ baseURL }) => {
			const page = await openStage(baseURL);
			const msg = page.locator('article.msg', { has: page.locator('.attachment-file-btn') }).first();
			await msg.evaluate((el) => {
				el.style.maxWidth = '180px';
				el.querySelector('.file-title')!.textContent = 'Screenshot_20260923_154512.png';
				el.querySelector('.file-sub')!.textContent = 'inbox/Screenshot_20260923_154512.png';
			});
			const chip = await msg.locator('.attachment-file-btn').boundingBox();
			const bubble = await msg.boundingBox();
			if (!chip || !bubble) throw new Error('nothing to measure');
			expect(chip.x).toBeGreaterThanOrEqual(bubble.x);
			expect(chip.x + chip.width).toBeLessThanOrEqual(bubble.x + bubble.width);
			await page.close();
		});
	});
}
