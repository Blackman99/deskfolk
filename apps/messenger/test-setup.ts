/**
 * Component tests run on the same `bun test` as everything else: a Bun loader compiles `.svelte`
 * on import, and happy-dom supplies the document. Keeping one runner is the point — the pure
 * modules and the components they back are checked by the same command.
 */
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { compile, compileModule } from "svelte/compiler";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const calendarRoot = dirname(require.resolve("svelte5plus-calendar/package.json"));

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

const tsToJs = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte",
  setup(build) {
    // svelte5plus-calendar publishes a `svelte` condition and no `import` one, so bun's
    // resolver never sees the package. Point the bare import at the file the condition names.
    // The package's own `.svelte` files live outside this app, so the loader below
    // would miss them and bun would try to import the component as JavaScript.
    build.onResolve({ filter: /^\./ }, (args) => {
      if (!args.importer.startsWith(calendarRoot)) return;
      let path = join(dirname(args.importer), args.path);
      if (path.endsWith(".svelte.svelte")) path = path.slice(0, -".svelte".length);
      else if (!path.endsWith(".svelte") && !path.includes(".")) path = `${path}.svelte`;
      return { path };
    });
    // `.svelte.ts` carries runes outside a component; it needs the module compiler, not the
    // component one. Tests use it to hand a pane a genuinely reactive draft.
    build.onLoad({ filter: /\.svelte\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      // `compileModule` takes JS, so the types come off first. Bun's own transpiler does that
      // properly — hand-rolled regexes used to trip over `type X` inside an import list.
      const stripped = tsToJs.transformSync(source);
      const { js } = compileModule(stripped, { filename: args.path, generate: "client", dev: false });
      return { contents: js.code, loader: "js" };
    });

    build.onLoad({ filter: /\.svelte$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const { js } = compile(source, {
        filename: args.path,
        generate: "client",
        runes: true,
        css: "injected",
        dev: false,
      });
      return { contents: js.code, loader: "js" };
    });
  },
});
