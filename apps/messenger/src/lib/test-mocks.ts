import { mock } from "bun:test";

/**
 * Monaco's Vite-only stylesheet aliases mean nothing to bun. Call this where `mock.module` used to
 * be written, before the component that lazily imports Monaco is loaded.
 */
export function mockMonacoCss(): void {
  mock.module("monaco-editor-css", () => ({}));
  mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
  mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
}

/**
 * The xterm addons and stylesheet, which draw to a canvas happy-dom does not have. The terminal
 * class and the search addon are left to each test, as what they record differs.
 */
export function mockXtermAddons(): void {
  mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
  mock.module("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
  mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
  mock.module("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
  mock.module("@xterm/xterm/css/xterm.css", () => ({}));
}
