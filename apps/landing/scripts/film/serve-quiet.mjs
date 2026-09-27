/**
 * A Vite dev server that does not watch the tree, run from the app's own directory (its SvelteKit
 * and UnoCSS configs are found relative to the working directory). Used by live.ts for the demo
 * messenger, so an edit landing in the tree mid-recording cannot reload the page.
 *
 * HMR stays on: UnoCSS sends the utilities of components loaded later (the chat, the preview)
 * over it. With nothing watched, the only full reload left is the dependency optimizer finding
 * something new, which the first run after a fresh install does; live.ts refuses to record through
 * one.
 *
 *   cd apps/messenger && node ../landing/scripts/film/serve-quiet.mjs 5217
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.argv[2]);
const vite = await import(pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')).href);
const server = await vite.createServer({
  configFile: path.resolve('vite.config.ts'),
  logLevel: process.env.QUIET_LOG ?? 'warn',
  server: { port, strictPort: true, watch: null }
});
await server.listen();
console.log(`listening on ${port}`);
process.on('SIGTERM', () => void server.close().finally(() => process.exit(0)));
