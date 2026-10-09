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

		/**
		 * A reply in several parts has no bubble to tell one part from the next, so the part under
		 * the pointer takes a faint ground, lighter than a selected or found message's teal tint.
		 * The pointer's ground steps aside for those, and for every part while a message's menu is open.
		 */
		test('the part of a reply under the pointer is marked apart from a selected one', async ({ baseURL }) => {
			const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
			await page.goto(`${baseURL}index.html?story=chat-stage-segments`);
			await page.waitForSelector('html[data-ready="yes"]');
			const parts = page.locator('.msg-wrap.is-bot.is-group .msg-segment');
			await expect(parts).toHaveCount(3);
			const ground = (i: number) => parts.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
			const ring = (i: number) => parts.nth(i).evaluate((el) => getComputedStyle(el).boxShadow);
			const idle = await ground(1);

			await parts.nth(1).hover();
			await expect.poll(() => ground(1)).not.toBe(idle);
			// The ground fades in; a read before it settles is an in-between colour.
			await page.waitForTimeout(200);
			expect(await ground(0)).toBe(idle);
			expect(await ground(2)).toBe(idle);
			expect(await ring(1)).toBe('none');
			const washed = await ground(1);

			// A found message keeps its own tint and ring, not the pointer's lighter ground. The pulse
			// animates the ring, so compare presence, not the shadow string.
			await parts.nth(0).evaluate((el) => el.classList.add('is-search-hit'));
			await parts.nth(1).evaluate((el) => el.classList.add('is-search-hit'));
			await expect.poll(() => ring(1)).not.toBe('none');
			await expect.poll(() => ring(0)).not.toBe('none');
			await expect.poll(async () => {
				const [found, underPointer] = await Promise.all([ground(0), ground(1)]);
				return found === underPointer && found !== washed && found !== idle;
			}).toBe(true);
			await parts.nth(0).evaluate((el) => el.classList.remove('is-search-hit'));
			await parts.nth(1).evaluate((el) => el.classList.remove('is-search-hit'));
			await expect.poll(() => ring(1)).toBe('none');
			await expect.poll(() => ground(1)).toBe(washed);

			// With a part's menu open, the ring says which part it is for and no other part is marked.
			await parts.nth(0).click({ button: 'right', position: { x: 8, y: 8 } });
			await expect(page.locator('.msg-context-menu')).toBeVisible();
			await expect.poll(() => ring(0)).not.toBe('none');
			const last = await parts.nth(2).boundingBox();
			if (!last) throw new Error('nothing to measure');
			await page.mouse.move(last.x + last.width - 24, last.y + last.height - 6);
			await expect.poll(() => ground(2)).toBe(idle);
			await expect.poll(() => ground(1)).toBe(idle);

			// Closed, the pointer marks the part again.
			await page.keyboard.press('Escape');
			await expect(page.locator('.msg-context-menu')).toHaveCount(0);
			await page.mouse.move(last.x + last.width - 30, last.y + last.height - 8);
			await expect.poll(() => ground(2)).toBe(washed);
			await page.close();
		});

		/** A reply in one part gets the same ground; only your own bubbles go without. */
		test('a one-part reply under the pointer is marked too', async ({ baseURL }) => {
			const page = await openStage(baseURL);
			const reply = page.locator('.msg-wrap.is-bot:not(.is-group):not(.is-system-row) .msg-segment').first();
			const ground = () => reply.evaluate((el) => getComputedStyle(el).backgroundColor);
			const idle = await ground();
			await reply.hover();
			await expect.poll(ground).not.toBe(idle);
			const yours = page.locator('.msg-wrap.is-user .msg-segment').first();
			const yoursIdle = await yours.evaluate((el) => getComputedStyle(el).backgroundColor);
			await yours.hover();
			await expect.poll(ground).toBe(idle);
			expect(await yours.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(yoursIdle);
			await page.close();
		});
	});
}
