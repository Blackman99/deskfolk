/**
 * The one export of NSH's renderer module (`nsh:rt`, the module compiled JSX imports) the app
 * calls itself: `setup`, which the entry's first statement calls with `nsh.json`'s theme. NSH
 * declares it internal (`Ts::Internal` in `nsh-js`'s `dom.rs`), so its types are not generated;
 * this is them, for `theme.ts` alone (ADR 0108). Arguments: the Tailwind theme (JSON), the theme
 * of the components (shadcn's `cssVars` JSON: the app's design tokens), the appearance
 * (`"light"` / `"dark"` / `"system"`) and the status bar's default (JSON); null leaves one as it is.
 */
declare module "nsh:rt" {
  export function setup(tailwind: string | null, theme: string | null, appearance: string | null, statusBar: string | null): void;
}
