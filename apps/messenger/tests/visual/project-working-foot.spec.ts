import { chromium, expect, test, webkit, type Page } from '@playwright/test';

/**
 * A project session's working line says where the agent is, then how long the whole run has taken.
 * The line was only as wide as its text, so the run's time sat right after the command and jumped
 * with every command's length (2026-10-31). It stays at the line's right end, as on a Bot's working
 * bubble, and a command too long for the line clips before it.
 *
 * Both engines, because the Mac window is WebKit; happy-dom lays nothing out.
 */
const SHORT = '思考中 · 跑完 ls';
const LONG = `思考中 · 跑完 ${'ls agent-mcp && wc -l agent-mcp/* permission-gate.ts '.repeat(8)}`;

/** The working line with `step` as its text: where the run's time sits, and whether the step fits. */
function withStep(page: Page, step: string) {
	return page.locator('[data-line="working"]').evaluate((line, text) => {
		const words = line.querySelector<HTMLElement>('.stream-step')!;
		words.textContent = text;
		const box = line.getBoundingClientRect();
		const time = line.querySelector('.duration-badge')!.getBoundingClientRect();
		return {
			fromRight: Math.round(box.right - time.right),
			left: Math.round(time.left - box.left),
			clear: words.getBoundingClientRect().right <= time.left,
			clipped: words.scrollWidth > words.clientWidth
		};
	}, step);
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		for (const width of [760, 420]) {
			test(`at ${width}px the run's time stays put, however long the command`, async ({ baseURL }) => {
				const browser = await engine.launch();
				const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
				await page.goto(`${baseURL}index.html?story=project-chat-working`);
				await page.waitForSelector('html[data-ready="yes"]');
				await page.evaluate((px) => {
					document.body.style.width = `${px}px`;
					document.getElementById('story')!.style.width = `${px}px`;
				}, width);

				const short = await withStep(page, SHORT);
				const long = await withStep(page, LONG);
				expect(short).toMatchObject({ fromRight: 0, clear: true, clipped: false });
				expect(long).toMatchObject({ fromRight: 0, clear: true, clipped: true });
				expect(long.left).toBe(short.left);
				await browser.close();
			});
		}
	});
}
