import UnoCSS from "unocss/vite";
import adapter from "@sveltejs/adapter-static";
import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { localApiDiscovery } from "./vite-plugin-local-api.ts";

const monacoCss = fileURLToPath(
  new URL("./node_modules/monaco-editor/min/vs/editor/editor.main.css", import.meta.url),
);
const monacoEsm = fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs", import.meta.url));
const hosted = process.env.REAL_BOT_HOSTED === "1";
const localDiscovery = fileURLToPath(new URL("./src/lib/local-discovery.ts", import.meta.url));
const localApi = fileURLToPath(new URL("./src/lib/local-api.ts", import.meta.url));
const localDiscoveryStub = fileURLToPath(new URL("./src/lib/remote/local-discovery-stub.ts", import.meta.url));
const localApiStub = fileURLToPath(new URL("./src/lib/remote/local-api-stub.ts", import.meta.url));

function hostedLocalIsolation(): Plugin {
  return {
    name: "hosted-local-isolation",
    enforce: "pre",
    resolveId(id) {
      if (!hosted) return;
      const normalized = id.split("?")[0]!.replace(/\\/g, "/");
      const file = normalized.split("/").pop() ?? "";
      if (file === "local-discovery.ts" || file === "local-discovery") return localDiscoveryStub;
      if (file === "local-api.ts" || file === "local-api") return localApiStub;
      return;
    },
  };
}

export default defineConfig({
  define: {
    __REAL_BOT_HOSTED__: hosted,
  },
  resolve: {
    alias: {
      "monaco-editor-css": monacoCss,
      "monaco-editor/esm/vs": monacoEsm,
      ...(hosted
        ? {
            [localDiscovery]: localDiscoveryStub,
            [localApi]: localApiStub,
          }
        : {}),
    },
  },
  plugins: [
    ...(hosted ? [hostedLocalIsolation()] : [localApiDiscovery()]),
    // Ordinary styles are utilities; see uno.config.ts and docs/development.md.
    UnoCSS(),
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
