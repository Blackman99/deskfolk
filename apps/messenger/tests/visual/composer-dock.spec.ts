import { chromium, expect, test, webkit, type Locator } from '@playwright/test';

/**
 * A conversation as narrow as a phone — a phone, a small window, a narrow workbench pane — docks
 * its composer: a bar flush with the bottom and both sides, which the transcript ends above
 * (2026-09-24). It used to float over the transcript as a rounded card with a margin all round,
 * its suggestion chips in a frosted bubble above it, and a chip past the right edge was cut off
 * with no way to reach it under a mouse, whose wheel only scrolls down.
 *
 * Suggestions are drafted only when ✨ is pressed now; each draft is a model call.
 *
 * Both engines, because the Mac window is WebKit: the layout is a container query and the chip
 * row a mask with a non-passive wheel listener, and happy-dom evaluates none of those.
 */
async function geometry(composer: Locator) {
	return composer.evaluate((el) => {
		const stage = el.parentElement!.getBoundingClientRect();
		const stream = el.parentElement!.querySelector('.stream')!;
		const box = el.getBoundingClientRect();
		return {
			position: getComputedStyle(el).position,
			bottom: Math.round(stage.bottom - box.bottom),
			left: Math.round(box.left - stage.left),
			right: Math.round(stage.right - box.right),
			gap: Math.round(box.top - stream.getBoundingClientRect().bottom),
			stuck: stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 1,
			radius: getComputedStyle(el.querySelector('.composer-card')!).borderTopLeftRadius
		};
	});
}

const docked = { position: 'relative', bottom: 0, left: 0, right: 0, gap: 0, stuck: true, radius: '0px' };

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		test('a phone-width conversation docks its composer and keeps every chip reachable', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
			await page.goto(`${baseURL}index.html?story=chat-stage-narrow`);
			await page.waitForSelector('html[data-ready="yes"]');
			const composer = page.locator('.composer');
			await expect.poll(() => geometry(composer)).toEqual(docked);

			const button = page.locator('.suggest-btn');
			await expect(page.locator('.composer-suggest-bar')).toHaveCount(0);
			await button.click();
			const row = page.locator('.suggest-scroll');
			await expect(row.locator('.suggest-chip')).toHaveCount(4);
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			// The chips are in the bar, and the transcript made room for them rather than going under.
			await expect.poll(() => geometry(composer)).toEqual(docked);
			const [bar, card] = await Promise.all([
				page.locator('.composer-suggest-bar').boundingBox(),
				page.locator('.composer-card').boundingBox()
			]);
			const outer = await composer.boundingBox();
			expect(bar!.y).toBeGreaterThanOrEqual(outer!.y);
			expect(bar!.y + bar!.height).toBeLessThanOrEqual(card!.y + 1);

			// More chips than the row holds: the far edge fades, and the wheel turns sideways.
			expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
			await expect(row).toHaveClass(/has-more-end/);
			await row.hover();
			await page.mouse.wheel(0, 120);
			await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
			await expect(row).toHaveClass(/has-more-start/);

			// The same press puts them away.
			await button.click();
			await expect(page.locator('.composer-suggest-bar')).toHaveCount(0);
			await expect(button).toHaveAttribute('aria-pressed', 'false');
			await browser.close();
		});

		/*
		 * On a phone (2026-09-24): a quad-curved screen curves away under the bar's corners and
		 * reports no safe area for it, and ✨ right beside the attachment button was two 34px targets
		 * 38px apart under one thumb. ✨ sits on the far side of the input, in send's place while
		 * there is nothing to send (2026-10-12), and gives that place to send once there is text.
		 */
		test('on a touch screen the bar keeps clear of curved edges, and ✨ and send take turns in one place', async ({ baseURL }) => {
			const browser = await engine.launch();
			const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
			const page = await context.newPage();
			await page.goto(`${baseURL}index.html?story=chat-stage-narrow`);
			await page.waitForSelector('html[data-ready="yes"]');
			expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
			const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
			// Greyed with nothing to send, send is not drawn: ✨ can be pressed instead.
			await expect(page.locator('.composer-action')).toBeHidden();
			const [bar, attach, suggest, editor] = await Promise.all(
				['.composer', '.attach-btn', '.suggest-btn', '.composer-editor-wrap'].map(box)
			);
			for (const target of [attach, suggest]) {
				expect(target.width).toBeGreaterThanOrEqual(40);
				expect(target.height).toBeGreaterThanOrEqual(40);
				expect(bar.y + bar.height - (target.y + target.height)).toBeGreaterThanOrEqual(12);
			}
			expect(attach.x).toBeGreaterThanOrEqual(16);
			expect(390 - (suggest.x + suggest.width)).toBeGreaterThanOrEqual(16);
			// One on each side of the input.
			expect(attach.x + attach.width).toBeLessThan(editor.x + 1);
			expect(suggest.x).toBeGreaterThan(editor.x + editor.width - 1);

			await page.locator('.suggest-btn').tap();
			const firstChip = page.locator('.suggest-chip').first();
			await expect(firstChip).toBeVisible();
			expect((await firstChip.boundingBox())!.x).toBeGreaterThanOrEqual(16);

			// Typing: send takes ✨'s place, so the two are never side by side.
			await page.locator('.composer-input').click();
			await page.keyboard.type('先看第三场');
			await expect(page.locator('.suggest-btn')).toBeHidden();
			const send = await box('.composer-action');
			expect(send.width).toBeGreaterThanOrEqual(40);
			expect(Math.abs(send.x - suggest.x)).toBeLessThanOrEqual(1);
			expect(Math.abs((await box('.composer-editor-wrap')).width - editor.width)).toBeLessThanOrEqual(1);
			await browser.close();
		});

		/*
		 * The phone shot of 2026-10-12: a direct whose Bot worked had attach, mic, a greyed ✨, Stop
		 * and a greyed send round an input left with 40% of the row. Only what can be pressed is drawn.
		 */
		test('a direct whose Bot works shows Stop in send\'s place, and send beside it once there is text', async ({ baseURL }) => {
			const browser = await engine.launch();
			const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
			const page = await context.newPage();
			await page.goto(`${baseURL}index.html?story=chat-stage-narrow-working`);
			await page.waitForSelector('html[data-ready="yes"]');
			const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
			await expect(page.locator('.suggest-btn')).toBeHidden();
			await expect(page.locator('.composer-action.send')).toBeHidden();
			const stop = await box('.composer-action.stop');
			expect(stop.width).toBeGreaterThanOrEqual(40);
			expect(390 - (stop.x + stop.width)).toBeGreaterThanOrEqual(16);
			const editor = await box('.composer-editor-wrap');
			// Attach on the left, the microphone and Stop on the right: the input has the rest of the row.
			await expect(page.locator('.voice-btn')).toBeVisible();
			expect(editor.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 3 * 40 - 3 * 8 - 1);

			await page.locator('.composer-input').click();
			await page.keyboard.type('换成对 KT 那一局');
			const send = await box('.composer-action.send');
			const stopNow = await box('.composer-action.stop');
			expect(Math.abs(send.x - stop.x)).toBeLessThanOrEqual(1);
			expect(send.x - (stopNow.x + stopNow.width)).toBeGreaterThanOrEqual(8);
			await expect(page.locator('.suggest-btn')).toBeHidden();
			await browser.close();
		});

		test('a wide conversation keeps the floating card, and ✨ waits for the reply in progress', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
			await page.goto(`${baseURL}index.html?story=chat-stage`);
			await page.waitForSelector('html[data-ready="yes"]');
			const shape = await geometry(page.locator('.composer'));
			expect(shape.position).toBe('absolute');
			expect(shape.radius).toBe('24px');
			// This story's group has a Bot still replying: drafts made now would be stale when it lands.
			await expect(page.locator('.suggest-btn')).toBeDisabled();
			await browser.close();
		});
	});
}
