import { chromium, expect, test, webkit, type BrowserType } from '@playwright/test';

/**
 * A subagent's popup is a transcript to read, on whatever screen you have.
 *
 * What it was asked lies flat at the top, however long, and only the popup's body scrolls. The
 * bubble used to scroll on its own past 16em, and a box that scrolls may shrink to nothing in a flex
 * column: a long transcript crushed it to its padding, one clipped line (2026-11-02).
 *
 * The popup follows the window instead of staying one width: a phone's page edge to edge, nearly
 * all of a narrow window, and up to a ceiling on a large screen.
 *
 * Both engines, because the Mac window is WebKit; happy-dom lays nothing out.
 */
const SHORT = '找出会话过期时跳回登录页的原因';
const LONG = '把登录循环的每条路径都走一遍，记下每一步读了什么。\n'.repeat(40);

/** [window width, the popup's width in it] */
const WIDTHS = [
	[390, 390],
	[800, 736],
	[1280, 900],
	[1728, 900],
	[2304, 1037],
	[2560, 1080],
	[3200, 1080]
] as const;

async function opened(engine: BrowserType, baseURL: string | undefined, viewport: { width: number; height: number }) {
	const browser = await engine.launch();
	const page = await browser.newPage({ viewport });
	await page.goto(`${baseURL}index.html?story=project-subagent`);
	await page.waitForSelector('html[data-ready="yes"]');
	await page.locator('[data-subagent="a1"]').click();
	await page.waitForSelector('[data-subagent-prompt]');
	await page.waitForSelector('.subagent-say');
	return { browser, page };
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		for (const viewport of [{ width: 1280, height: 820 }, { width: 390, height: 844 }]) {
			test(`at ${viewport.width}px what it was asked lies flat, however long either side is`, async ({ baseURL }) => {
				const { browser, page } = await opened(engine, baseURL, viewport);
				const bubble = page.locator('[data-subagent-prompt]');
				const asked = (text: string) => bubble.evaluate((el, words) => {
					el.textContent = words;
					const body = el.closest('.subagent-body')!;
					return {
						shown: el.clientHeight,
						whole: el.scrollHeight,
						em: parseFloat(getComputedStyle(el).fontSize),
						bodyScrolls: body.scrollHeight > body.clientHeight
					};
				}, text);

				const short = await asked(SHORT);
				expect(short.bodyScrolls).toBe(true);
				expect(short.shown).toBe(short.whole);

				const long = await asked(LONG);
				expect(long.bodyScrolls).toBe(true);
				expect(long.shown).toBe(long.whole);
				expect(long.shown).toBeGreaterThan(16 * long.em);
				await browser.close();
			});
		}

		for (const [width, expected] of WIDTHS) {
			test(`in a ${width}px window the popup is ${expected}px wide`, async ({ baseURL }) => {
				const { browser, page } = await opened(engine, baseURL, { width, height: 820 });
				// offsetWidth, as the popup scales in on opening.
				expect(await page.locator('.subagent-dialog').evaluate((el: HTMLElement) => el.offsetWidth)).toBe(expected);
				await browser.close();
			});
		}
	});
}
