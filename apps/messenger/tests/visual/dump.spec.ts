import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { STORY_SIZES, type StoryName } from './story-list.ts';

/**
 * Not a check — a diagnostic. When a shot differs, do not squint at the diff image: dump every
 * rect and computed style in the pane before and after the change and `diff` the two files. The
 * line that moved says what happened. This is how the route log's missing `line-height` and the
 * onboarding button's lost `:global` were found; both looked fine in every property anyone
 * thought to measure by hand.
 *
 *   DUMP_STORY=route-log DUMP_OUT=/tmp/before.txt pnpm exec playwright test dump
 *
 * Skips itself unless `DUMP_STORY` is set, so `test:visual` stays about the baselines.
 */
const NAME = process.env.DUMP_STORY;
const OUT = process.env.DUMP_OUT ?? '/tmp/story-dump.txt';

test('dump', async ({ page }) => {
	test.skip(!NAME, 'set DUMP_STORY to the story to dump');
	await page.setViewportSize(STORY_SIZES[NAME as StoryName]);
	await page.goto(`index.html?story=${NAME}&theme=${process.env.DUMP_THEME ?? 'dark'}`);
	await page.waitForSelector('html[data-ready="yes"]');
	await page.evaluate(() => document.fonts.ready);
	// Mid-flight entrance animations are the commonest false positive in a dump diff.
	await page.evaluate(() =>
		document.getAnimations().forEach((a) => {
			try {
				a.finish();
			} catch {
				a.cancel(); // infinite ones cannot finish
			}
		})
	);
	const rows = await page.evaluate(() => {
		const props = ['display','flexDirection','alignItems','justifyContent','gap','padding','margin','width','height','minWidth','maxWidth','flex','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','border','borderRadius','whiteSpace','overflow','textOverflow','boxSizing','position','transform','opacity','boxShadow','textTransform','textAlign'];
		const out: string[] = [];
		let i = 0;
		const walk = (el: Element, path: string) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			// SVG elements hand back an SVGAnimatedString, not a string.
			const raw = el.className as unknown as string | { baseVal: string };
			const cls = String(typeof raw === 'string' ? raw : (raw?.baseVal ?? ''))
				.split(' ')
				.filter((c) => c && !c.startsWith('svelte-'))
				.join('.');
			out.push(
				`${String(i++).padStart(3, '0')} ${path} <${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}> ` +
					`rect=${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}\n      ` +
					props.map((p) => `${p}=${(cs as unknown as Record<string, string>)[p]}`).join(' | ')
			);
			[...el.children].forEach((c, n) => walk(c, `${path}/${n}`));
		};
		walk(document.body, '');
		return out;
	});
	writeFileSync(OUT, rows.join('\n') + '\n');
	console.log(`${rows.length} elements → ${OUT}`);
});
