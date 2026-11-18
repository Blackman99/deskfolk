/**
 * The logic tests run on `bun test`: happy-dom supplies the document, and a Bun loader compiles
 * the rune modules (`*.svelte.ts`) on import.
 */
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { compileModule } from "svelte/compiler";
import { readFileSync } from "node:fs";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

// happy-dom takes navigator.platform from the host OS. The suite is written against the Mac window
// (⌘ labels, Ctrl-click as a right-click, Finder wording), and the Windows branches are tested by
// passing the platform in; pinned, a Windows CI host runs the same suite as a Mac.
Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });

// happy-dom's IntersectionObserver never reports anything, so a component that waits to be seen
// (a transcript picture, see when-visible.ts) would wait forever. In a test everything rendered
// is on screen, and it is seen as it is observed.
(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = class {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean; target: Element }>, observer: unknown) => void) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target }], this);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
};

const tsToJs = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte-runes",
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
  },
});
