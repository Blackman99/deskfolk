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
 * - A rule of the page's own over the NSH runtime's sheet (`PAGE_STYLE`): a scroll view that only
 *   scrolls sideways passes a vertical swipe on to the conversation around it.
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
import { join, resolve } from "node:path";
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
 * contain` on both axes, so one that only scrolls sideways (a code block, a table in a reply) keeps a
 * vertical swipe too: Chrome latches the swipe on it, it cannot move that way, and the conversation
 * around it stays put. Its vertical axis goes back to `auto`, so the swipe passes on to the
 * conversation; sideways it still keeps its own. Three classes, over the runtime's one, wherever its
 * sheet sits in the cascade.
 */
export const PAGE_STYLE = '<style id="deskfolk-page">.nsh-scroll.nsh-ox.nsh-ox { overscroll-behavior-y: auto; }</style>';
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

/** Adds the worker, its files and the icons to the packaged site at `site`. Run again, it changes nothing more. */
export function addPhoneStatic(site: string, from: string = PHONE_ASSETS): void {
  for (const name of PHONE_STATIC) copyFileSync(join(from, name), join(site, name));

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
