/**
 * The TLS edge of `phone-web-e2e.ts`, standing where Caddy stands in `deploy/remote`: one origin
 * that serves the hosted page and passes the relay's routes through, so the page reaches the relay
 * same-origin, with its own `Origin`, as a phone does. Loopback only, a certificate made for the run.
 *
 * The page goes out with the production edge's headers (`deploy/remote/Caddyfile`): the policy
 * `deploy/remote/csp.mjs` makes from the page being served, `nosniff` (a script or a `.wasm` served
 * under another type is refused) and the rest; and a query the production edge refuses is refused
 * here too. What the page cannot do under them fails here, not on the relay.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { PAIR_MAILBOX_CONTRACT } from "../../../packages/remote/src/index.ts";
import { productionCsp } from "../../../deploy/remote/csp.mjs";

/** The relay's routes, exactly as `deploy/remote/Caddyfile` forwards them (`@relay`). */
export const RELAY_ROUTES: ReadonlySet<string> = new Set(["/v1/relay/host", "/v1/relay/device", "/v1/relay/bootstrap", PAIR_MAILBOX_CONTRACT.path]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // NSH's page style (`nsh-page.<hash>.css`, since NSH 48559f8): a browser in strict mode refuses
  // a stylesheet served as anything else, and the page is left without its layout.
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  // The Svelte page's (`--from-svelte`): its badge and fonts.
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".bin": "application/octet-stream",
};

/** The headers the production edge sends with every file (`deploy/remote/Caddyfile`), the page's policy aside. */
export const EDGE_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), publickey-credentials-get=(self)",
};

/** The production edge's query rule (`@illegal_query`): only the messenger's id-style keys. */
export const ALLOWED_QUERY = /^(?:(?:s|o|b|a|k)=[0-9A-Za-z._-]+)(?:&(?:s|o|b|a|k)=[0-9A-Za-z._-]+)*$/;

/** A frame on its way upstream: text, or bytes in a buffer of their own (what `WebSocket.send` takes). */
type Frame = string | Uint8Array<ArrayBuffer>;
type Link = { path: string; origin: string | null; upstream?: WebSocket; queue: Frame[] };
// lib.dom's constructor has no options; Bun's takes the handshake's headers.
const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/**
 * A certificate for `localhost` and 127.0.0.1 that is its own authority (as the relay's Caddy test
 * makes one): the edge serves it, and a process given it in `NODE_EXTRA_CA_CERTS` trusts it.
 */
export function certificate(dir: string): { cert: string; key: string; certPath: string; keyPath: string } {
  const config = join(dir, "certificate.cnf");
  writeFileSync(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n",
  );
  const certPath = join(dir, "certificate.pem");
  const keyPath = join(dir, "private.key");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", keyPath, "-out", certPath], {
    stdio: "ignore",
  });
  if (made.status !== 0) throw new Error("openssl could not make the test certificate");
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), certPath, keyPath };
}

/**
 * The production edge itself, for `phone-web-e2e.ts --edge caddy`: Caddy (`CADDY_BIN`, else
 * `caddy` on the PATH; 2.10.2 as the image) running `deploy/remote/Caddyfile` with only what ties
 * it to a host changed, as `apps/relay/integration/caddy.test.ts` runs it: loopback ports, the
 * run's certificate, `site` for `/srv`, the relay on loopback, the page's policy from `csp.mjs`.
 */
export async function startCaddyEdge(options: {
  port: number;
  httpPort: number;
  relayPort: number;
  site: string;
  tls: { cert: string; certPath: string; keyPath: string };
  dir: string;
}): Promise<{ stop(): Promise<void> }> {
  const caddy = process.env.CADDY_BIN ?? "caddy";
  const csp = join(options.dir, "csp.caddy");
  writeFileSync(csp, `header Content-Security-Policy "${productionCsp(readFileSync(join(options.site, "index.html"), "utf8"))}"\n`);
  let config = readFileSync(join(import.meta.dir, "..", "..", "..", "deploy", "remote", "Caddyfile"), "utf8");
  const swap = (from: string, to: string, all = false) => {
    if (!config.includes(from)) throw new Error(`deploy/remote/Caddyfile has no ${from}: the e2e's edge needs updating`);
    config = all ? config.replaceAll(from, to) : config.replace(from, to);
  };
  swap("admin off", "admin off\n\tdefault_bind 127.0.0.1");
  swap("http_port 8080", `http_port ${options.httpPort}`);
  swap("https_port 8443", `https_port ${options.port}`);
  swap("{$RELAY_DOMAIN}", "127.0.0.1", true);
  swap("{$ACME_EMAIL}", "e2e@localhost.invalid");
  swap("tls {", `tls ${options.tls.certPath} ${options.tls.keyPath} {`);
  swap("/etc/caddy/csp.caddy", csp);
  swap("root * /srv", `root * ${options.site}`, true);
  swap("reverse_proxy relay:8080", `reverse_proxy 127.0.0.1:${options.relayPort}`);
  const caddyfile = join(options.dir, "Caddyfile");
  writeFileSync(caddyfile, config);
  const child = Bun.spawn([caddy, "run", "--config", caddyfile, "--adapter", "caddyfile"], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, XDG_DATA_HOME: join(options.dir, "caddy-data"), XDG_CONFIG_HOME: join(options.dir, "caddy-config") },
  });
  const stop = async () => {
    child.kill();
    await child.exited;
  };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`caddy exited: ${await new Response(child.stderr).text()}`);
    const answer = await fetch(`https://127.0.0.1:${options.port}/`, { tls: { ca: options.tls.cert } } as RequestInit).catch(() => null);
    if (answer?.status === 200) return { stop };
    await Bun.sleep(50);
  }
  await stop();
  throw new Error("caddy did not serve the page");
}

/**
 * Serves `site` (the hosted package; a function to swap it while the edge runs, as a deploy does)
 * on https://127.0.0.1:`port` and passes `RELAY_ROUTES`, HTTP and WebSocket, to the relay on
 * 127.0.0.1:`relayPort` with their `Origin` and `Content-Type` as they came (the relay checks
 * both); anything else is a file of the site or a 404.
 */
export function startEdge(options: { port: number; relayPort: number; site: string | (() => string); tls: { cert: string; key: string } }) {
  const relay = `127.0.0.1:${options.relayPort}`;
  const siteNow = typeof options.site === "string" ? () => options.site as string : options.site;
  return Bun.serve<Link>({
    hostname: "127.0.0.1",
    port: options.port,
    tls: options.tls,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.search !== "" && !ALLOWED_QUERY.test(url.search.slice(1))) return new Response("", { status: 400, headers: { "cache-control": "no-store" } });
      if (RELAY_ROUTES.has(url.pathname)) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (srv.upgrade(req, { data: { path: url.pathname + url.search, origin: req.headers.get("origin"), queue: [] } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        const headers = new Headers();
        for (const name of ["content-type", "origin"]) {
          const value = req.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
        const answer = await fetch(`http://${relay}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
        return new Response(await answer.arrayBuffer(), {
          status: answer.status,
          headers: { "content-type": answer.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
        });
      }
      const site = siteNow();
      const file = join(site, normalize(url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
      if (!file.startsWith(site) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), {
        headers: {
          ...EDGE_HEADERS,
          "Content-Security-Policy": productionCsp(readFileSync(join(site, "index.html"), "utf8")),
          "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    },
    websocket: {
      open(ws) {
        const upstream = new BunWebSocket(`ws://${relay}${ws.data.path}`, { headers: ws.data.origin ? { origin: ws.data.origin } : {} });
        upstream.binaryType = "arraybuffer";
        ws.data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of ws.data.queue.splice(0)) upstream.send(message);
        };
        upstream.onmessage = (event) => ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
        upstream.onclose = (event) => {
          try {
            ws.close(event.code, event.reason);
          } catch {
            ws.close();
          }
        };
        upstream.onerror = () => ws.close();
      },
      message(ws, message) {
        const data: Frame = typeof message === "string" ? message : Uint8Array.from(message);
        if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(data);
        else ws.data.queue.push(data);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
}
