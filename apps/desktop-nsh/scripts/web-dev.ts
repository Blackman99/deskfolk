/**
 * The app's web build on this Mac, against the dev runtime: packages it (`nsh package --target
 * web`, the app's Rust crate compiled to wasm) and serves it on 127.0.0.1:17991 with one more path
 * the page's host module asks, `/__deskfolk/endpoint` (the dev runtime's address and token, as the
 * messenger's Vite plugin hands the token to its dev page). Loopback only; never the stable runtime.
 *
 *   bun apps/desktop-nsh/scripts/web-dev.ts [--no-build]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { assertApartFromStable, DEV_APP_NAME, devInstance } from "./dev-instance";
import { nshCli } from "./nsh-cli";
import { trimTargets } from "./trim-target";

export const WEB_DEV_PORT = 17991;
const root = resolve(import.meta.dir, "..");
const out = join(root, "build", "web");
// `nsh package` writes the site into a directory named after the app.
const site = join(out, DEV_APP_NAME);
const instance = devInstance();
assertApartFromStable(instance);

function llvmAr(): string | undefined {
  const found = spawnSync("find", [join(homedir(), ".rustup", "toolchains"), "-name", "llvm-ar", "-path", "*apple-darwin/bin/*"], { encoding: "utf8" });
  return found.stdout.split("\n").find(Boolean);
}

if (!process.argv.includes("--no-build")) {
  trimTargets();
  const nsh = nshCli({ build: true });
  const env = {
    ...process.env,
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
    CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? "/usr/bin/clang",
    AR_wasm32_unknown_unknown: process.env.AR_wasm32_unknown_unknown ?? llvmAr() ?? "llvm-ar",
  };
  const built = spawnSync(nsh, ["package", "App.tsx", "--target", "web", "--out", out], { cwd: join(root, "app"), env, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".bin": "application/octet-stream",
};

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: WEB_DEV_PORT,
  fetch(req, srv) {
    if (!loopback(srv.requestIP(req)?.address)) return new Response("loopback only", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/__deskfolk/endpoint") {
      // Same-origin pages only: a cross-site page gets no CORS headers and so cannot read it.
      const { port, token } = JSON.parse(readFileSync(join(instance.dataDir, "local-api.json"), "utf8")) as { port: number; token: string };
      if (port !== instance.port) return new Response("not the dev runtime", { status: 503 });
      return Response.json({ origin: `http://127.0.0.1:${port}`, token }, { headers: { "Cache-Control": "no-store" } });
    }
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = join(site, path);
    if (!file.startsWith(site) || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers: { "Content-Type": types[extname(file)] ?? "application/octet-stream" } });
  },
});
console.log(`web build on http://${server.hostname}:${server.port}/ (dev runtime ${instance.bind})`);
