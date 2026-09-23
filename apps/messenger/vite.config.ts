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
      // No `version.pollInterval`: the hosted page runs its own poll over the same
      // `_app/version.json` (see build-version.ts), because a dismissible notice needs the
      // version itself and `updated` only latches a boolean. The window never polls — it is
      // updated by the app installer.
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
  build: {
    // Vite 8 builds on rolldown; `rolldownOptions` is its own output config, not Rollup's
    // `manualChunks` (that Rollup option still exists here but is ignored once `codeSplitting`
    // is set). `codeSplitting.groups` — the current name; this rolldown release still accepts
    // the older `advancedChunks` key but warns that it is deprecated — pulls matching
    // node_modules code into a chunk named `[group.name]-[hash].js` instead of letting it ride
    // along inside whichever chunk first imports it. Two things that matters for:
    //  - a deploy that only touches app code must not change vendor bytes the phone already has
    //    cached (see static/sw.js): vendor chunks only change when a dependency itself changes.
    //  - monaco-editor, shiki/@shikijs and @xterm must stay behind their existing dynamic
    //    `import()` calls, not get folded into an eagerly-loaded vendor chunk.
    // The `$initial` tag (built into rolldown) is what keeps the second promise: it only tags
    // modules reachable by *static* import from an entry, so anything reached solely through a
    // lazy `import()` — Monaco, Shiki, xterm, svelte5plus-calendar, @dagrejs/dagre — is invisible
    // to the `vendor` group below.
    //
    // @dagrejs/dagre gets its own named group: it is a self-contained library with no import of
    // its own on `svelte`, so pulling it out is a clean, unconditional win regardless of how many
    // lazy entry points end up reaching it.
    //
    // svelte5plus-calendar deliberately has NO named group, even though it is exactly the kind of
    // rarely-changing dependency this config exists to isolate. It ships its components as
    // `.svelte` source (compiled by this build, not pre-bundled), and those components import
    // from `svelte` — so a named group for it, with `includeDependenciesRecursively` at its
    // rolldown default of `true`, pulled the entire svelte runtime along with it and then fought
    // the `vendor` group over which chunk owns those shared runtime files; the two candidate
    // chunks kept merging into one eagerly-loaded blob no matter how `priority` was set (verified
    // by dumping each output chunk's `moduleIds` from a `generateBundle` hook — the merge
    // reproduced with or without an explicit `priority`). Leaving it out of `groups` entirely and
    // letting rolldown's ordinary automatic chunking handle it was the one setup, of everything
    // tried, that both kept it out of the eager `vendor` chunk and did not merge it back into the
    // runtime: it lands in its own plain shared chunk, reused by every lazy importer, with no
    // named-group priority fight to lose. If this library ever changes to import something else
    // widely shared, re-check chunk membership with the same kind of `generateBundle` dump before
    // trusting a new named group for it.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-dagre",
              test: /[\\/]node_modules[\\/]@dagrejs[\\/]/,
              priority: 2,
            },
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
              tags: ["$initial"],
              priority: 1,
            },
          ],
        },
      },
    },
  },
});
