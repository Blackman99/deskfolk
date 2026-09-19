/**
 * Component tests run on the same `bun test` as everything else: a Bun loader compiles `.svelte`
 * on import, and happy-dom supplies the document. Keeping one runner is the point — the pure
 * modules and the components they back are checked by the same command.
 */
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { compile, compileModule } from "svelte/compiler";
import { readFileSync } from "node:fs";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

const tsToJs = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte",
  setup(build) {
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
