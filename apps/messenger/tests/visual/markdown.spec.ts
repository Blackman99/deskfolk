import { chromium, expect, test, webkit } from '@playwright/test';

/**
 * The sanitizer's one test in a real browser. `bun test` runs on happy-dom, where DOMPurify's own
 * tag walk does not work, so a config that stripped every message to plain text in Chromium passed
 * every unit test (2026-09-23). Rendered here in Chromium and WebKit, iOS Safari's engine.
 */
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
	test.describe(name, () => {
		test('markdown keeps its formatting and loses anything active', async ({ baseURL }) => {
			const browser = await engine.launch();
			const page = await browser.newPage();
			await page.goto(`${baseURL}index.html?story=none`);
			const out = await page.evaluate(async () => {
				// Served by the story server's Vite; a variable keeps the type checker out of the browser's module graph.
				const modulePath = '/src/lib/markdown.ts';
				const { renderMarkdown } = (await import(/* @vite-ignore */ modulePath)) as {
					renderMarkdown: (source: string, options: object) => string;
				};
				const render = (source: string) => renderMarkdown(source, {});
				return {
					bold: render('**bold** and [link](https://example.com)'),
					blocks: render('# Title\n\n- a\n- b\n\n1. one'),
					table: render('| a | b |\n|:-|-:|\n| 1 | 2 |'),
					code: render('```ts\nconst a = 1;\n```'),
					artifact: render('[shot](artifact:shots/a.png)'),
					script: render('<script>alert(1)</script><p onclick="x()">hi</p>'),
					image: render('<img src=x onerror=alert(1)>ok'),
					js: render('[a](javascript:alert(1))'),
					styled: render('<a href="https://x.test" style="color:red" class="evil" onmouseover="x()">x</a>'),
					svg: render('<svg><g onload=alert(1)></g></svg>text'),
					math: render('<math><mi xlink:href="javascript:alert(1)">m</mi></math>'),
					noscript: render('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'),
				};
			});
			expect(out.bold).toContain('<strong>bold</strong>');
			expect(out.bold).toContain('<a href="https://example.com" class="md-external-link" target="_blank" rel="noopener noreferrer"');
			expect(out.blocks).toContain('<h1>Title</h1>');
			expect(out.blocks).toContain('<li>a</li>');
			expect(out.blocks).toContain('<ol>');
			expect(out.table).toContain('<th align="left">a</th>');
			expect(out.code).toMatch(/<pre><code class="language-ts">/);
			expect(out.artifact).toContain('class="md-artifact-link"');
			for (const [name, html] of Object.entries(out)) {
				expect(html, name).not.toMatch(/<script|<img|<svg><g|<math|onerror|onclick|onload|onmouseover|javascript:|style=|class="evil"/i);
			}
			expect(out.script).toContain('<p>hi</p>');
			expect(out.js).toContain('a');
			await browser.close();
		});
	});
}
