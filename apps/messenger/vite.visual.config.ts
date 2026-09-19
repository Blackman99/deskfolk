import UnoCSS from 'unocss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * A bare Vite app that mounts one component, for the visual baselines. Never shipped.
 *
 * The root is the package, not `tests/visual`: the stylesheets live under `src/lib/styles` and
 * are pulled in through CSS `@import`. Rooted at `tests/visual` those files sit outside the root,
 * Vite does not watch them, and the baselines get taken against whatever CSS the server started
 * with — a check that cannot fail is worse than no check.
 */
export default defineConfig({
	plugins: [UnoCSS(), svelte({ compilerOptions: { runes: true } })],
	server: { port: 5199, strictPort: true }
});
