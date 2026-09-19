/**
 * Ask Uno what a set of utilities actually declares.
 *
 * Read from stdin as {key: [utility, ...]}, written back as {key: {prop: value}}. The converter
 * uses it to refuse any rewrite whose utilities do not reproduce the CSS they replace — `w-17`
 * meant 68px for a while because sizing had its own scale, and nothing but a comparison catches
 * that.
 */
import { createGenerator } from 'unocss';
import config from '../uno.config.ts';

const input = JSON.parse(await new Response(process.stdin).text());
const uno = await createGenerator(config);
const out = {};
for (const [key, utils] of Object.entries(input)) {
	const decls = {};
	for (const u of utils) {
		const { css } = await uno.generate(u, { preflights: false });
		const body = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{([^}]*)\}/)?.[1] ?? '';
		if (!body.trim()) {
			decls[`!unknown:${u}`] = '';
			continue;
		}
		for (const d of body.split(';')) {
			const i = d.indexOf(':');
			if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
		}
	}
	out[key] = decls;
}
process.stdout.write(JSON.stringify(out));
