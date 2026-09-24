import UnoCSS from "unocss/vite";
import adapter from "@sveltejs/adapter-static";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * What pdf.js needs besides its own code while it parses a PDF.
 *
 * The CMaps (Chinese, Japanese and Korean text in fonts the file does not embed) and the Symbol and
 * ZapfDingbats standard fonts (the other standard fonts come from the system): each is a lazily
 * imported JS module holding its base64, fetched only when an open PDF needs it. They are not
 * static files for pdf.js to fetch because the window's CSP has no `'self'` in `connect-src`, and a
 * module import is a script load, which it allows.
 *
 * The JPEG 2000 and JBIG2 image decoders: neither CSP lets a page compile WebAssembly (and both
 * must stay free of `unsafe-eval`, see `xss.test.ts`), so pdf.js runs without wasm and its worker
 * imports the plain-JS builds of the two instead. The worker looks for them in a directory, so they
 * sit at a fixed, versioned path: served by this plugin in dev, emitted into the client build.
 *
 * See `src/lib/overlays/pdfjs.ts`.
 */
export function pdfjsData(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  /** Under SvelteKit's default `appDir`; the hosted Caddyfile caches `/_app/immutable/*` for a year, hence the version. */
  const decoderDir = `_app/immutable/pdfjs-${version}/`;
  const decoders = ["openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js"];
  const index = "virtual:pdfjs-data";
  const prefix = `${index}/`;
  let listed: string[] | null = null;
  let ssr = false;
  const files = (): string[] =>
    (listed ??= [
      ...readdirSync(join(root, "cmaps"))
        .filter((name) => name.endsWith(".bcmap"))
        .sort()
        .map((name) => `cmaps/${name}`),
      "standard_fonts/FoxitSymbol.pfb",
      "standard_fonts/FoxitDingbats.pfb",
    ]);
  return {
    name: "pdfjs-data",
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        const file = path.startsWith(`/${decoderDir}`) ? path.slice(decoderDir.length + 1) : "";
        if (!decoders.includes(file)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/javascript");
        res.end(readFileSync(join(root, "wasm", file)));
      });
    },
    generateBundle() {
      // SvelteKit builds twice; only the client build's output is served.
      if (ssr) return;
      for (const file of decoders) {
        this.emitFile({ type: "asset", fileName: `${decoderDir}${file}`, source: readFileSync(join(root, "wasm", file)) });
      }
    },
    resolveId(id) {
      if (id === index || id.startsWith(prefix)) return `\0${id}`;
      return;
    },
    load(id) {
      if (id === `\0${index}`) {
        const entries = files().map((file) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(`${prefix}${file}.js`)}),`);
        return [
          `export const files = {\n${entries.join("\n")}\n};`,
          `export const decoderPath = ${JSON.stringify(`/${decoderDir}`)};`,
          "",
        ].join("\n");
      }
      if (!id.startsWith(`\0${prefix}`) || !id.endsWith(".js")) return;
      const file = id.slice(prefix.length + 1, -".js".length);
      if (!files().includes(file)) this.error(`not a bundled pdf.js data file: ${file}`);
      return `export default ${JSON.stringify(readFileSync(join(root, file)).toString("base64"))};\n`;
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
    pdfjsData(),
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
    // Only ever imported dynamically, on the first PDF: without this the dev server discovers it
    // then, re-optimizes, and reloads the page out from under the preview.
    include: ["pdfjs-dist/legacy/build/pdf.mjs"],
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
