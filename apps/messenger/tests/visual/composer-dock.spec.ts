import { chromium, expect, test, webkit, type Locator, type Page } from '@playwright/test';

/**
 * A conversation as narrow as a phone itself — 480px and under, a phone or a pane that thin — docks
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

/** The story's column at another width, the way a workbench pane is dragged narrower. */
async function storyWidth(page: Page, px: number) {
	await page.evaluate((width) => {
		document.body.style.width = `${width}px`;
		document.getElementById('story')!.style.width = `${width}px`;
	}, px);
}

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

		/*
		 * Between a phone and 680px (2026-10-21): a 500px pane docked its composer like a phone,
		 * where the floating card read well. The card floats there now, on the 12px the transcript
		 * has at that width, and the stream keeps room for it; at 480px and under it docks.
		 */
		test('a pane wider than a phone floats the card on the transcript\'s margins, and docks at 480', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 900, height: 844 } });
			await page.goto(`${baseURL}index.html?story=chat-stage-narrow`);
			await page.waitForSelector('html[data-ready="yes"]');
			const composer = page.locator('.composer');
			const floating = () =>
				composer.evaluate((el) => {
					const stage = el.parentElement!.getBoundingClientRect();
					const card = el.querySelector('.composer-card')!;
					const box = card.getBoundingClientRect();
					const inner = getComputedStyle(el.parentElement!.querySelector('.stream-inner')!);
					return {
						position: getComputedStyle(el).position,
						left: Math.round(box.left - stage.left),
						right: Math.round(stage.right - box.right),
						text: parseFloat(inner.paddingLeft),
						room: parseFloat(inner.paddingBottom) >= Math.round(el.getBoundingClientRect().height),
						radius: getComputedStyle(card).borderTopLeftRadius
					};
				});
			for (const px of [560, 481]) {
				await storyWidth(page, px);
				await expect.poll(floating).toEqual({ position: 'absolute', left: 12, right: 12, text: 12, room: true, radius: '18px' });
			}
			await storyWidth(page, 480);
			await expect.poll(() => geometry(composer)).toEqual(docked);
			await browser.close();
		});

		/*
		 * The Mac window draws classic scrollbars, 15px off the list's right edge, and the card floats
		 * over the list: on the stage's 12px it ran into the bar, its right margin gone (2026-10-21).
		 * It sits on the transcript's column now, as wide as the text and centred on it.
		 */
		test('a floating card keeps its margin off a classic scrollbar', async ({ baseURL }) => {
			test.skip(name === 'chromium', 'Playwright runs Chromium with its scrollbars hidden');
			const browser = await engine.launch();
			const context = await browser.newContext({ viewport: { width: 900, height: 844 } });
			await context.addInitScript(() =>
				document.addEventListener('DOMContentLoaded', () => {
					const style = document.createElement('style');
					style.textContent = '::-webkit-scrollbar{width:15px}::-webkit-scrollbar-thumb{background:#888}';
					document.head.append(style);
				})
			);
			const page = await context.newPage();
			await page.goto(`${baseURL}index.html?story=chat-stage-narrow`);
			await page.waitForSelector('html[data-ready="yes"]');
			// Short enough that the list scrolls, so its bar shows.
			await page.evaluate(() => (document.getElementById('story')!.style.height = '420px'));
			const column = () =>
				page.locator('.composer').evaluate((el) => {
					const stream = el.parentElement!.querySelector<HTMLElement>('.stream')!;
					const inner = stream.querySelector('.stream-inner')!;
					const box = inner.getBoundingClientRect();
					const textLeft = box.left + parseFloat(getComputedStyle(inner).paddingLeft);
					const textRight = box.right - parseFloat(getComputedStyle(inner).paddingRight);
					const card = el.querySelector('.composer-card')!.getBoundingClientRect();
					return {
						bar: stream.offsetWidth - stream.clientWidth,
						left: Math.round(card.left - textLeft),
						right: Math.round(textRight - card.right),
						centre: Math.round((card.left + card.right - textLeft - textRight) / 2)
					};
				});
			for (const px of [560, 481]) {
				await storyWidth(page, px);
				await expect.poll(column).toEqual({ bar: 15, left: 0, right: 0, centre: 0 });
			}
			await storyWidth(page, 900);
			// Wide, the card is the chat's width and the text a little narrower: they share a centre.
			await expect.poll(async () => {
				const { bar, centre } = await column();
				return { bar, centre };
			}).toEqual({ bar: 15, centre: 0 });
			await browser.close();
		});

		/*
		 * A project session's composer is its own (ADR 0095), and it only ever asked the window: in
		 * a 500px pane it kept the wide card and margins (2026-10-21). It follows the conversation's
		 * width now, as a Bot's does: the phone's 12px up to 680px, docked at 480px and under.
		 */
		test('a project session\'s composer follows the pane\'s width, and docks at 480', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
			await page.goto(`${baseURL}index.html?story=project-chat`);
			await page.waitForSelector('html[data-ready="yes"]');
			const shape = () =>
				page.locator('.project-chat').evaluate((el) => {
					const chat = el.getBoundingClientRect();
					const composer = el.querySelector('.composer')!;
					const box = el.querySelector('.composer-box')!;
					const bar = composer.getBoundingClientRect();
					const card = box.getBoundingClientRect();
					return {
						text: parseFloat(getComputedStyle(el.querySelector('.transcript-inner')!).paddingLeft),
						left: Math.round(card.left - chat.left),
						right: Math.round(chat.right - card.right),
						bottom: Math.round(chat.bottom - bar.bottom),
						rounded: getComputedStyle(box).borderTopLeftRadius !== '0px',
						rule: getComputedStyle(composer).borderTopWidth,
						filled: getComputedStyle(composer).backgroundColor !== 'rgba(0, 0, 0, 0)'
					};
				});
			await storyWidth(page, 760);
			await expect.poll(shape).toEqual({ text: 24, left: 24, right: 24, bottom: 0, rounded: true, rule: '0px', filled: false });
			for (const px of [560, 481]) {
				await storyWidth(page, px);
				await expect.poll(shape).toEqual({ text: 12, left: 12, right: 12, bottom: 0, rounded: true, rule: '0px', filled: false });
			}
			// Docked, the bar is the field: filled to both sides, a rule on top, its line on the bar's own margins.
			await storyWidth(page, 480);
			await expect.poll(shape).toEqual({ text: 12, left: 12, right: 8, bottom: 0, rounded: false, rule: '1px', filled: true });
			await browser.close();
		});

		/*
		 * A project session's composer sat in the chat's flow, so its transcript, and the scrollbar
		 * with it, stopped above the card, where a Bot's runs on under its floating card to the
		 * pane's bottom: the bar looked as if it could not reach the end (2026-10-22). The card
		 * floats now, the list keeps room for it, and the card keeps its margin off the bar.
		 */
		test('a project session\'s transcript and its scrollbar run under the floating composer', async ({ baseURL }) => {
			test.skip(name === 'chromium', 'Playwright runs Chromium with its scrollbars hidden');
			const browser = await engine.launch();
			const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
			await context.addInitScript(() =>
				document.addEventListener('DOMContentLoaded', () => {
					const style = document.createElement('style');
					style.textContent = '::-webkit-scrollbar{width:15px}::-webkit-scrollbar-thumb{background:#888}';
					document.head.append(style);
				})
			);
			const page = await context.newPage();
			await page.goto(`${baseURL}index.html?story=project-chat`);
			await page.waitForSelector('html[data-ready="yes"]');
			// Short enough that the list scrolls, so its bar shows.
			await page.evaluate(() => (document.getElementById('story')!.style.height = '260px'));
			const atEnd = () =>
				page.locator('.project-chat').evaluate((el) => {
					const list = el.querySelector<HTMLElement>('.transcript')!;
					list.scrollTop = list.scrollHeight;
					const inner = list.querySelector('.transcript-inner')!;
					const box = inner.getBoundingClientRect();
					const textLeft = box.left + parseFloat(getComputedStyle(inner).paddingLeft);
					const textRight = box.right - parseFloat(getComputedStyle(inner).paddingRight);
					const composer = el.querySelector('.composer')!;
					const card = el.querySelector('.composer-box')!.getBoundingClientRect();
					return {
						bar: list.offsetWidth - list.clientWidth,
						under: Math.round(el.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom),
						position: getComputedStyle(composer).position,
						left: Math.round(card.left - textLeft),
						right: Math.round(textRight - card.right),
						lastClear: inner.lastElementChild!.getBoundingClientRect().bottom <= card.top
					};
				});
			for (const px of [900, 560, 481]) {
				await storyWidth(page, px);
				await expect.poll(atEnd).toEqual({ bar: 15, under: 0, position: 'absolute', left: 0, right: 0, lastClear: true });
			}
			// Docked, the bar is in the chat's flow again: the list ends on its top edge.
			await storyWidth(page, 480);
			await expect.poll(() =>
				page.locator('.project-chat').evaluate((el) => {
					const composer = el.querySelector('.composer')!;
					const list = el.querySelector('.transcript')!.getBoundingClientRect();
					return { position: getComputedStyle(composer).position, gap: Math.round(composer.getBoundingClientRect().top - list.bottom) };
				})
			).toEqual({ position: 'relative', gap: 0 });
			await browser.close();
		});

		/*
		 * The account, model and thinking level are one cascading picker (2026-10-22): its columns
		 * open over the composer, in the top layer, inside the window. WebKit does not focus a
		 * button it was clicked on, and the keys are read on the picker's field: opening focuses it.
		 */
		test('a project session\'s picker opens its columns over the composer, and takes the keys', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
			await page.goto(`${baseURL}index.html?story=project-chat`);
			await page.waitForSelector('html[data-ready="yes"]');
			await storyWidth(page, 480);
			const trigger = page.locator('.tune-trigger');
			await trigger.click();
			const panel = page.locator('.tune-panel');
			await expect(panel).toBeVisible();
			// Measured where it comes to rest: it rises into place.
			await panel.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
			const place = await page.evaluate(() => {
				const p = document.querySelector('.tune-panel')!.getBoundingClientRect();
				const t = document.querySelector('.tune-trigger')!.getBoundingClientRect();
				return { above: Math.round(t.top - p.bottom), left: Math.round(p.left - t.left), inside: p.top >= 0 && p.right <= innerWidth };
			});
			expect(place).toEqual({ above: 4, left: 0, inside: true });
			await expect(page.locator('[data-tune-column]')).toHaveCount(3);
			// To the accounts, down to the other one, over to its models: the keys walk the cascade.
			await page.keyboard.press('ArrowLeft');
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowRight');
			await expect(page.locator('[data-tune-column="account"] .tune-row.is-focus')).toHaveAttribute('data-value', '/Users/me/.claude-team');
			await expect(page.locator('[data-tune-column="model"] .tune-row.is-keyed')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(panel).toHaveCount(0);
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
