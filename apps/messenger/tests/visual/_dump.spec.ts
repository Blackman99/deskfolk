import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { STORY_SIZES } from './story-list.ts';

const OUT = process.env.DUMP_OUT!;
const NAME = process.env.DUMP_STORY!;

test('dump', async ({ page }) => {
	await page.setViewportSize(STORY_SIZES[NAME as keyof typeof STORY_SIZES]);
	await page.goto(`index.html?story=${NAME}&theme=dark`);
	await page.waitForSelector('html[data-ready="yes"]');
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
	const rows = await page.evaluate(() => {
		const props = ['display','flexDirection','alignItems','justifyContent','gap','padding','margin','width','height','minWidth','maxWidth','flex','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','border','borderRadius','whiteSpace','overflow','textOverflow','boxSizing','position','transform','opacity','boxShadow','textTransform','textAlign'];
		const out: string[] = []; let i = 0;
		const walk = (el: Element, path: string) => {
			const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
			out.push(`${String(i++).padStart(3,'0')} ${path} <${el.tagName.toLowerCase()}.${el.className?.toString().split(' ').filter(c=>!c.startsWith('svelte-')).join('.')}> rect=${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}\n      ${props.map(p=>`${p}=${(cs as never)[p]}`).join(' | ')}`);
			[...el.children].forEach((c, n) => walk(c, `${path}/${n}`));
		};
		walk(document.body, '');
		return out;
	});
	writeFileSync(OUT, rows.join('\n') + '\n');
});
