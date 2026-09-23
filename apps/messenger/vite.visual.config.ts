import UnoCSS from 'unocss/vite';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { pdfjsData } from './vite.config.ts';

/**
 * A bare Vite app that mounts one component, for the visual baselines. Never shipped.
 *
 * The root is the package, not `tests/visual`: the stylesheets live under `src/lib/styles` and
 * are pulled in through CSS `@import`. Rooted at `tests/visual` those files sit outside the root,
 * Vite does not watch them, and the baselines get taken against whatever CSS the server started
 * with — a check that cannot fail is worse than no check.
 *
 * The Monaco aliases and the Shiki exclusion mirror `vite.config.ts`. A story that reaches the
 * artifact preview pulls in the code editor, and without them that import is a 500 for the whole
 * module graph — every story, not just that one. The same goes for the PDF viewer's data module
 * (`virtual:pdfjs-data`), which is why its plugin is imported rather than copied.
 */
const monacoCss = fileURLToPath(
	new URL('./node_modules/monaco-editor/min/vs/editor/editor.main.css', import.meta.url)
);
const monacoEsm = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs', import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'monaco-editor-css': monacoCss,
			'monaco-editor/esm/vs': monacoEsm
		}
	},
	plugins: [UnoCSS(), svelte({ compilerOptions: { runes: true } }), pdfjsData()],
	server: { port: 5199, strictPort: true },
	optimizeDeps: {
		exclude: ['shiki', '@shikijs/langs', '@shikijs/themes', '@shikijs/monaco'],
		include: ['pdfjs-dist/legacy/build/pdf.mjs']
	}
});
