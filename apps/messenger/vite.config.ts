import adapter from "@sveltejs/adapter-static";
import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { localApiDiscovery } from "./vite-plugin-local-api.ts";

const monacoCss = fileURLToPath(
  new URL("./node_modules/monaco-editor/min/vs/editor/editor.main.css", import.meta.url),
);
const monacoEsm = fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "monaco-editor-css": monacoCss,
      "monaco-editor/esm/vs": monacoEsm,
    },
  },
  plugins: [
    localApiDiscovery(),
    sveltekit({
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      adapter: adapter({
        fallback: "index.html",
      }),
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    // Huge TextMate JSON grammars 504 as stale Vite dep chunks (`shiki_langs_html__mjs.js`).
    exclude: ["shiki", "@shikijs/langs", "@shikijs/themes", "@shikijs/monaco"],
  },
});
