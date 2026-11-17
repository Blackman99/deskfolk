/**
 * What the phone's page needs beside what `nsh package Hosted.tsx --target web` writes, taken from
 * the messenger's `static/` as the Svelte page has them: the service worker (`sw.js`, which loads
 * `media-stream.js`) that web push, a tapped notification, the app badge and remote media go
 * through (`src/platform/page-service-worker.ts` registers it); the picture a notification shows
 * (`icon-192.png`, `notification-badge.png`); and the home-screen icons. An iPhone gets web push only
 * for a page added to the home screen, which takes the manifest's icons and the apple-touch-icon.
 *
 * NSH writes the manifest without icons and a `.br` / `.gz` beside each file for a server that sends
 * them precompressed (Caddy's `precompressed`), so the two files changed here get theirs again.
 *
 *   bun apps/desktop-nsh/scripts/phone-package.ts [<package dir>]   # after `nsh package Hosted.tsx --target web`
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MESSENGER_STATIC = resolve(import.meta.dir, "..", "..", "messenger", "static");

export const PHONE_STATIC = ["sw.js", "media-stream.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "notification-badge.png"] as const;

const ICONS = [
  { src: "icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
];

const TOUCH_ICON = '<link rel="apple-touch-icon" href="apple-touch-icon.png">';

/** Writes `text` to `path` and, where NSH left precompressed copies, makes them again. */
function rewrite(path: string, text: string): void {
  writeFileSync(path, text);
  const bytes = Buffer.from(text);
  if (existsSync(`${path}.br`)) writeFileSync(`${path}.br`, brotliCompressSync(bytes));
  if (existsSync(`${path}.gz`)) writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
}

/** Adds the worker, its files and the icons to the packaged site at `site`. Run again, it changes nothing more. */
export function addPhoneStatic(site: string, from: string = MESSENGER_STATIC): void {
  for (const name of PHONE_STATIC) copyFileSync(join(from, name), join(site, name));

  const manifestPath = join(site, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { icons?: unknown[] };
  manifest.icons = ICONS;
  rewrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const indexPath = join(site, "index.html");
  const index = readFileSync(indexPath, "utf8");
  if (!index.includes(TOUCH_ICON)) {
    const manifestLink = /<link rel="manifest"[^>]*>/.exec(index);
    if (!manifestLink) throw new Error(`no manifest link in ${indexPath}: nsh package wrote another page than this expects`);
    const at = manifestLink.index + manifestLink[0].length;
    rewrite(indexPath, `${index.slice(0, at)}\n${TOUCH_ICON}${index.slice(at)}`);
  }
}

if (import.meta.main) {
  const site = resolve(process.argv[2] ?? join(import.meta.dir, "..", "build", "phone", "Deskfolk Dev"));
  addPhoneStatic(site);
  console.log(`added ${PHONE_STATIC.join(", ")} and the icons to ${site}`);
}
