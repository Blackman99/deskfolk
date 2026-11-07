/**
 * The TLS edge of `phone-web-e2e.ts`, standing where Caddy stands in `deploy/remote`: one origin
 * that serves the hosted page and passes the relay's routes through, so the page reaches the relay
 * same-origin, with its own `Origin`, as a phone does. Loopback only, a certificate made for the run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { PAIR_MAILBOX_CONTRACT } from "../../../packages/remote/src/index.ts";

/** The relay's routes, exactly as `deploy/remote/Caddyfile` forwards them (`@relay`). */
export const RELAY_ROUTES: ReadonlySet<string> = new Set(["/v1/relay/host", "/v1/relay/device", "/v1/relay/bootstrap", PAIR_MAILBOX_CONTRACT.path]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".bin": "application/octet-stream",
};

/** A frame on its way upstream: text, or bytes in a buffer of their own (what `WebSocket.send` takes). */
type Frame = string | Uint8Array<ArrayBuffer>;
type Link = { path: string; origin: string | null; upstream?: WebSocket; queue: Frame[] };
// lib.dom's constructor has no options; Bun's takes the handshake's headers.
const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/**
 * A certificate for `localhost` and 127.0.0.1 that is its own authority (as the relay's Caddy test
 * makes one): the edge serves it, and a process given it in `NODE_EXTRA_CA_CERTS` trusts it.
 */
export function certificate(dir: string): { cert: string; key: string; certPath: string } {
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
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), certPath };
}

/**
 * Serves `site` (the hosted package) on https://127.0.0.1:`port` and passes `RELAY_ROUTES`, HTTP
 * and WebSocket, to the relay on 127.0.0.1:`relayPort` with their `Origin` and `Content-Type` as
 * they came (the relay checks both); anything else is a file of the site or a 404.
 */
export function startEdge(options: { port: number; relayPort: number; site: string; tls: { cert: string; key: string } }) {
  const relay = `127.0.0.1:${options.relayPort}`;
  const site = options.site;
  return Bun.serve<Link>({
    hostname: "127.0.0.1",
    port: options.port,
    tls: options.tls,
    async fetch(req, srv) {
      const url = new URL(req.url);
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
      const file = join(site, normalize(url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
      if (!file.startsWith(site) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" } });
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
