/**
 * The phone's page: `nsh package Hosted.tsx --target web` under the released name, and what the
 * page needs beside what NSH writes.
 *
 * - From `assets/phone/`: the service worker (`sw.js`, which
 *   loads `media-stream.js`) that web push, a tapped notification, the app badge and remote media go
 *   through (`src/platform/page-service-worker.ts` registers it); the picture a notification shows
 *   (`icon-192.png`, `notification-badge.png`); and the home-screen icons. An iPhone gets web push
 *   only for a page added to the home screen, which takes the manifest's icons and the
 *   apple-touch-icon.
 * - The manifest keeps the identity the page was first installed under (`id: "./"`, its name and
 *   icons): a phone that added the page to its home screen keeps the same app.
 * - The two chunks only a local window runs (`local-api`, `local-discovery`: the loopback endpoint
 *   and its bearer) leave the package. The hosted page never imports them (`HOSTED_MESSENGER`), and
 *   the relay's page carries no code that asks for a local token.
 * - The build's version, one digest of what the package serves: in `_app/version.json`, which an
 *   open page polls (`BuildUpdateNotice`), and in the page's params (`#nsh-params`,
 *   `host.params.build`), so the page knows which build it is.
 * - A rule of the page's own over the NSH runtime's sheet (`PAGE_STYLE`): a scroll view inside
 *   another (a code block, a table, a command's output in a reply) passes a swipe it cannot take on
 *   to the conversation around it.
 * - The code colours' grammars and themes (`addCodeColours`): giallo's dump, which the desktop app
 *   carries in its binary and the web build leaves out. The page fetches it as the runtime's data
 *   `giallo` (`app/native/src/highlight.rs`), named by its content as NSH names its own files.
 * - Before any of that, `--build` checks what the first screen downloads (`checkFirstScreen`): only
 *   the small parts of `nsh/base` beside the engine, and the app's own Rust a module of its own.
 *
 * NSH writes a `.br` / `.gz` beside each file for a server that sends them precompressed (Caddy's
 * `precompressed`, nginx's `gzip_static`), so the files changed here get theirs again.
 *
 *   bun apps/desktop-nsh/scripts/phone-package.ts --build [--out <dir>]   # package, then this
 *   bun apps/desktop-nsh/scripts/phone-package.ts [<package dir>]         # after `nsh package` alone
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nshCli } from "./nsh-cli";
import { RELEASE_APP_NAME, RELEASE_BUNDLE_ID } from "./package";

export const PHONE_ASSETS = resolve(import.meta.dir, "..", "assets", "phone");

export const PHONE_STATIC = ["sw.js", "media-stream.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "notification-badge.png"] as const;

/** The chunks only a local window imports, by their id in the page's `nsh-app` config. */
export const LOCAL_ONLY_CHUNKS = ["local-api.js", "local-discovery.js"] as const;

/** The file an open page polls for the build being served (SvelteKit's name, kept for the pages still open). */
export const VERSION_FILE = "_app/version.json";

/** Where `--build` writes the package; the site is `<out>/<RELEASE_APP_NAME>`. */
export const PHONE_OUT = resolve(import.meta.dir, "..", "build", "phone");

const ICONS = [
  { src: "icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
];

const TOUCH_ICON = '<link rel="apple-touch-icon" href="apple-touch-icon.png">';

/**
 * The page's own rule over the NSH runtime's sheet. NSH gives every scroll view `overscroll-behavior:
 * contain` on both axes, so a scroll view inside the conversation keeps a swipe it cannot take: a code
 * block or a table, which scroll only sideways, a vertical one; a command's output or its card, short
 * enough to have nothing to scroll, any. Chrome latches the swipe on it, it cannot move, and the
 * conversation around it stays put. A scroll view inside another goes back to `auto`, so what it
 * cannot take passes on to the one around it; the outermost keeps `contain`, so nothing reaches the
 * page. Two classes, over the runtime's one, wherever its sheet sits in the cascade.
 */
export const PAGE_STYLE = '<style id="deskfolk-page">.nsh-scroll .nsh-scroll { overscroll-behavior: auto; }</style>';
const PAGE_STYLE_TAG = /<style id="deskfolk-page">[^<]*<\/style>\n?/;
const PARAMS = /\n?<script type="application\/json" id="nsh-params">[^<]*<\/script>/;
const APP_CONFIG = /<script type="application\/json" id="nsh-app">([^<]*)<\/script>/;

/** Writes `text` to `path` and, where NSH left precompressed copies, makes them again. */
function rewrite(path: string, text: string): void {
  writeFileSync(path, text);
  const bytes = Buffer.from(text);
  if (existsSync(`${path}.br`)) writeFileSync(`${path}.br`, brotliCompressSync(bytes));
  if (existsSync(`${path}.gz`)) writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
}

/** Every file under `dir`, as paths relative to it. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? files(dir, path) : [path];
  });
}

/** The manifest as the page was first installed: its identity and icons over what NSH wrote. */
function phoneManifest(written: Record<string, unknown>, from: string): Record<string, unknown> {
  const installed = JSON.parse(readFileSync(join(from, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
  return { ...written, id: installed.id, name: installed.name, short_name: installed.short_name, description: installed.description, icons: ICONS };
}

/** The runtime data the page fetches for the code colours (`nsh_core::runtime_data`, `highlight.rs`). */
export const CODE_COLOURS_DATA = "giallo";
const CODE_COLOURS_FILE = /^nsh-giallo\.[0-9a-f]{10}\.bin$/;

/** giallo's dump of its grammars and themes (`builtin.zst`), from the crate the app's workspace resolves. */
export function gialloDump(): string {
  const root = resolve(import.meta.dir, "..");
  const meta = spawnSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", join(root, "Cargo.toml")], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` },
  });
  if (meta.status !== 0) throw new Error(`cargo metadata failed (${meta.status}): ${meta.stderr}`);
  const giallo = (JSON.parse(meta.stdout) as { packages: Array<{ name: string; manifest_path: string }> }).packages.find((p) => p.name === "giallo");
  if (!giallo) throw new Error("the app's workspace has no giallo: the code colours have nothing to fetch");
  const dump = join(dirname(giallo.manifest_path), "builtin.zst");
  if (!existsSync(dump)) throw new Error(`no ${dump}: giallo ${giallo.manifest_path} carries no dump`);
  return dump;
}

/**
 * Puts the code colours' grammars and themes (`dump`, giallo's `builtin.zst`) into the packaged site
 * at `site` as `nsh-giallo.<10 hex of its content>.bin`, the pattern the edges cache for good, and
 * names it in the page's `nsh-app` config as the runtime's data `giallo`. It is zstd already: no
 * compressed copies. Run again, it leaves one.
 */
export function addCodeColours(site: string, dump: string = gialloDump()): void {
  const bytes = readFileSync(dump);
  const name = `nsh-giallo.${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.bin`;
  for (const file of readdirSync(site)) if (CODE_COLOURS_FILE.test(file) && file !== name) rmSync(join(site, file));
  writeFileSync(join(site, name), bytes);
  const indexPath = join(site, "index.html");
  const index = readFileSync(indexPath, "utf8");
  const config = APP_CONFIG.exec(index);
  if (!config) throw new Error(`no nsh-app config in ${indexPath}: nsh package wrote another page than this expects`);
  const app = JSON.parse(config[1]!) as { data?: Record<string, string> };
  app.data = { ...app.data, [CODE_COLOURS_DATA]: name };
  rewrite(indexPath, index.replace(config[0], `<script type="application/json" id="nsh-app">${JSON.stringify(app)}</script>`));
}

/** The chunk the entry imports, which the first screen waits for (`App.tsx`: `import("./src/Main")`). */
export const FIRST_CHUNK = "Main.js";

/**
 * The parts of `nsh/base` the first screen may load beside the engine: small, and on most screens.
 * Every other part, and the app's own Rust, is a side module a later chunk loads (`src/ui/lazy-views.ts`).
 */
export const FIRST_SCREEN_SIDES = ["nsh_part_core", "nsh_part_menu", "nsh_part_overlays", "nsh_part_select", "nsh_part_combobox"] as const;

/** The app's own Rust (`app/native`), which must stay a side module, out of the engine every page downloads first. */
export const APP_NATIVE_GATE = "nsh_ui_set_deskfolk_native";

/**
 * Fails when the first screen would download more than it should: a side module the first chunk
 * loads beyond `FIRST_SCREEN_SIDES`, or the app's own Rust linked into the engine (no side module of
 * its own) because something the entry imports took it. Either comes from a static import of a heavy
 * view or of `deskfolk/native` in what the app loads at start (ADR 0107 addendum 62).
 */
export function checkFirstScreen(index: string): void {
  const config = APP_CONFIG.exec(index);
  if (!config) throw new Error("no nsh-app config: nsh package wrote another page than this expects");
  const app = JSON.parse(config[1]!) as { chunks?: Record<string, string>; chunkSides?: Record<string, string[]>; sides?: Record<string, { gate?: string }> };
  if (!app.chunks?.[FIRST_CHUNK]) throw new Error(`no ${FIRST_CHUNK} chunk: the entry no longer imports the app the way this expects`);
  const extra = (app.chunkSides?.[FIRST_CHUNK] ?? []).filter((gate) => !(FIRST_SCREEN_SIDES as readonly string[]).includes(gate));
  if (extra.length) {
    throw new Error(`the first screen would load ${extra.join(", ")}: something ${FIRST_CHUNK} imports statically draws with it; import its view from src/ui/lazy-views.ts`);
  }
  if (!Object.values(app.sides ?? {}).some((side) => side.gate === APP_NATIVE_GATE)) {
    throw new Error(`the app's own Rust (${APP_NATIVE_GATE}) is linked into the engine: something the entry imports takes deskfolk/native`);
  }
}

/** Takes the local-only chunks out of the package and out of the page's map of chunks. */
function dropLocalOnly(site: string, index: string): string {
  const config = APP_CONFIG.exec(index);
  if (!config) throw new Error(`no nsh-app config in ${join(site, "index.html")}: nsh package wrote another page than this expects`);
  const app = JSON.parse(config[1]!) as { chunks?: Record<string, string> };
  for (const id of LOCAL_ONLY_CHUNKS) {
    const file = app.chunks?.[id];
    if (!file) continue;
    for (const suffix of ["", ".br", ".gz"]) rmSync(join(site, `${file}${suffix}`), { force: true });
    delete app.chunks![id];
  }
  return index.replace(config[0], `<script type="application/json" id="nsh-app">${JSON.stringify(app)}</script>`);
}

/** One digest of what the site serves, the page's own params left out (they carry it). */
export function siteVersion(site: string): string {
  const hash = createHash("sha256");
  for (const path of files(site).filter((p) => !/\.(br|gz)$/.test(p) && p !== VERSION_FILE).sort()) {
    hash.update(path);
    hash.update(path === "index.html" ? readFileSync(join(site, path), "utf8").replace(PARAMS, "") : readFileSync(join(site, path)));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Adds the worker, its files, the icons, the page's rule and the code colours (`dump`) to the
 * packaged site at `site`. Run again, it changes nothing more.
 */
export function addPhoneStatic(site: string, from: string = PHONE_ASSETS, dump: string = gialloDump()): void {
  for (const name of PHONE_STATIC) copyFileSync(join(from, name), join(site, name));
  addCodeColours(site, dump);

  const manifestPath = join(site, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  rewrite(manifestPath, `${JSON.stringify(phoneManifest(manifest, from), null, 2)}\n`);

  const indexPath = join(site, "index.html");
  let index = dropLocalOnly(site, readFileSync(indexPath, "utf8"));
  if (!index.includes(TOUCH_ICON)) {
    const manifestLink = /<link rel="manifest"[^>]*>/.exec(index);
    if (!manifestLink) throw new Error(`no manifest link in ${indexPath}: nsh package wrote another page than this expects`);
    const at = manifestLink.index + manifestLink[0].length;
    index = `${index.slice(0, at)}\n${TOUCH_ICON}${index.slice(at)}`;
  }
  // Last in the head, after NSH's page sheet; again on a second run, as this file has it now.
  index = index.replace(PAGE_STYLE_TAG, "");
  const head = index.indexOf("</head>");
  if (head === -1) throw new Error(`no </head> in ${indexPath}: nsh package wrote another page than this expects`);
  index = `${index.slice(0, head)}${PAGE_STYLE}\n${index.slice(head)}`;
  // The version covers the page as it is served, so it is worked out once the page is otherwise
  // done; the params go right after the app's config, before the start script reads both.
  index = index.replace(PARAMS, "");
  writeFileSync(indexPath, index);
  const version = siteVersion(site);
  const config = APP_CONFIG.exec(index)!;
  const end = config.index + config[0].length;
  rewrite(indexPath, `${index.slice(0, end)}\n<script type="application/json" id="nsh-params">${JSON.stringify({ build: version })}</script>${index.slice(end)}`);
  mkdirSync(join(site, "_app"), { recursive: true });
  writeFileSync(join(site, VERSION_FILE), `${JSON.stringify({ version })}\n`);

  for (const path of files(site).filter((p) => /\.(js|html)$/.test(p))) {
    if (readFileSync(join(site, path), "utf8").includes("__local-api")) throw new Error(`${path} still asks for the local API: the hosted page must not`);
  }
}

/** `nsh package Hosted.tsx --target web` under the released name and id, into `out`; then the above. Returns the site. */
export function buildPhoneSite(out: string = PHONE_OUT): string {
  const llvmAr =
    process.env.AR_wasm32_unknown_unknown ??
    spawnSync("find", [join(homedir(), ".rustup", "toolchains"), "-name", "llvm-ar", "-path", "*apple-darwin/bin/*"], { encoding: "utf8" })
      .stdout.split("\n")
      .find(Boolean) ??
    "llvm-ar";
  const site = join(out, RELEASE_APP_NAME);
  rmSync(site, { recursive: true, force: true });
  const nsh = nshCli({ build: true });
  const done = spawnSync(nsh, ["package", "Hosted.tsx", "--target", "web", "--name", RELEASE_APP_NAME, "--id", RELEASE_BUNDLE_ID, "--out", out], {
    cwd: resolve(import.meta.dir, "..", "app"),
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
      CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? (process.platform === "darwin" ? "/usr/bin/clang" : "clang"),
      AR_wasm32_unknown_unknown: llvmAr,
    },
  });
  if (done.status !== 0) throw new Error(`nsh package Hosted.tsx --target web failed (${done.status})`);
  checkFirstScreen(readFileSync(join(site, "index.html"), "utf8"));
  addPhoneStatic(site);
  return site;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  if (process.argv.includes("--build")) {
    const site = buildPhoneSite(at === -1 ? PHONE_OUT : resolve(process.argv[at + 1]!));
    console.log(`the phone's page: ${site} (build ${siteVersion(site)})`);
  } else {
    const site = resolve(process.argv[2] ?? join(PHONE_OUT, RELEASE_APP_NAME));
    addPhoneStatic(site);
    console.log(`added ${PHONE_STATIC.join(", ")}, the icons and the version to ${site}`);
  }
}
