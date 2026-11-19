// npm dependencies are kept fresh by taze, not Dependabot: `.github/workflows/deps.yml` runs
// `pnpm dlx taze@19 -w` weekly and commits what changed to main. Locally, `pnpm dlx taze@19` lists
// what would move, `-w` writes it (then `pnpm install`), and `pnpm dlx taze@19 major` lists what
// is past the ranges.
//
// Each package.json moves within the range it already allows; majors and exact pins (`"5.5.0"`)
// stay where they are, so a pin is how a package is held back.
export default {
  recursive: true,
  // Ask the registry every time, not taze's cache.
  force: true,
  // The workflow refreshes the lockfile itself.
  install: false,
  ignorePaths: ['**/node_modules/**', '**/.claude/**', '**/.scratch/**'],
  depFields: {
    // pnpm itself (`packageManager`) moves by hand: every workflow, releases included, runs it.
    packageManager: false,
    // pnpm-workspace.yaml holds no catalogs, only overrides that drop packages (`"a>b": "-"`),
    // which are not versions to bump.
    'pnpm-workspace': false,
    'pnpm.overrides': false,
    overrides: false,
  },
  // taze still reads those overrides with the fields above off, so selectors with `>` are
  // excluded by name too.
  exclude: ['/>/'],
}
