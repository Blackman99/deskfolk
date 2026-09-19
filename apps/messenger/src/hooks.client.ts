/**
 * UnoCSS's generated sheet is loaded here, not from `+layout.svelte`.
 *
 * `virtual:uno.css` is produced asynchronously in dev — the plugin waits for its first scan —
 * and a route component that imports it can still be mid-evaluation when SvelteKit reads the
 * `component` re-export out of `.svelte-kit/generated/client/nodes/N.js`. That read is a TDZ
 * error (`Cannot access 'component' before initialization`) with no application frame in the
 * stack, and it only shows up on some cold starts: two runs in three in the Tauri window, never
 * in a browser tab that opens a moment later. `hooks.client.ts` is outside the route node graph
 * and runs before the app starts, so there is nothing to race.
 */
import 'virtual:uno.css';
