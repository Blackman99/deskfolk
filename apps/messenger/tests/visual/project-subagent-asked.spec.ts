import { chromium, expect, test, webkit, type Page } from '@playwright/test';

/**
 * What a subagent was asked stays readable at the top of its popup, however long its transcript.
 * The bubble scrolls on its own past 16em, and a box that scrolls may shrink to nothing in a flex
 * column: a long transcript crushed it to its padding, one clipped line (2026-11-02). The popup's
 * body scrolls instead.
 *
 * Both engines, because the Mac window is WebKit; happy-dom lays nothing out.
 */
const SHORT = '找出会话过期时跳回登录页的原因';
const LONG = `${'把登录循环的每条路径都走一遍，记下每一步读了什么。\n'.repeat(40)}`;

/** The bubble with `text` as what was asked: how tall it is, and whether the popup itself scrolls. */
function asked(page: Page, text: string) {
	return page.locator('[data-subagent-prompt]').evaluate((bubble, words) => {
		bubble.textContent = words;
		const body = bubble.closest('.subagent-body')!;
		return {
			shown: bubble.clientHeight,
			whole: bubble.scrollHeight,
			cap: Math.round(16 * parseFloat(getComputedStyle(bubble).fontSize)),
			bodyScrolls: body.scrollHeight > body.clientHeight
		};
	}, text);
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		for (const viewport of [{ width: 1280, height: 820 }, { width: 390, height: 844 }]) {
			test(`at ${viewport.width}px a long transcript leaves what it was asked whole`, async ({ baseURL }, info) => {
				const browser = await engine.launch();
				const page = await browser.newPage({ viewport });
				await page.goto(`${baseURL}index.html?story=project-subagent`);
				await page.waitForSelector('html[data-ready="yes"]');
				await page.locator('[data-subagent="a1"]').click();
				await page.waitForSelector('[data-subagent-prompt]');
				await page.waitForSelector('.subagent-say');

				const short = await asked(page, SHORT);
				expect(short.bodyScrolls).toBe(true);
				expect(short.shown).toBe(short.whole);
				await page.screenshot({ path: info.outputPath('short.png') });

				// Past 16em it is the bubble's own scroll, not all of it, and still not squeezed.
				const long = await asked(page, LONG);
				expect(long.bodyScrolls).toBe(true);
				expect(long.shown).toBe(long.cap);
				expect(long.whole).toBeGreaterThan(long.cap);
				await browser.close();
			});
		}
	});
}
