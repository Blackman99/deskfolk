import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing under `src` may reach a build-time package.
 *
 * UnoCSS's Vite plugin pulls every `.ts` and `.svelte` under the project into the client module
 * graph so it can regenerate on change. A single `import { createGenerator } from "unocss"` in a
 * test file there was enough to put postcss — and its `fs` / `path` / `url` imports — in the
 * browser, which broke route evaluation: the window showed `Cannot access 'component' before
 * initialization` from SvelteKit's client, nowhere near the actual cause. The production bundle
 * was clean the whole time, so `pnpm build` said nothing either.
 *
 * Such a test belongs in `tests/`, which Vite never sees.
 */
const FORBIDDEN = ["unocss", "vite", "@playwright/test", "svelte/compiler", "unconfig", "postcss"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|svelte)$/.test(path)) out.push(path);
  }
  return out;
}

test("no file under src imports a build-time package", () => {
  const offenders: string[] = [];
  for (const path of walk("src")) {
    // Comments first: this file's own prose quotes the import that started all this.
    const text = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (FORBIDDEN.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        offenders.push(`${path}: ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
