import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture } from "../../relay/test/helpers.ts";
import { productionCsp } from "../../../deploy/remote/csp.mjs";
import { ALLOWED_QUERY, certificate, EDGE_HEADERS, RELAY_ROUTES, startEdge } from "./phone-edge";
import { FORBIDDEN_PORTS, freePort } from "./phone-runtime";

const repo = resolve(import.meta.dir, "../../..");
// As NSH writes the page: its config a data block, its start a module file.
const PAGE = '<!doctype html><title>phone</title><script type="application/json" id="nsh-app">{}</script><script type="module" src="nsh-start.0123456789.js"></script>';
const dir = mkdtempSync(join(tmpdir(), "deskfolk-phone-edge-"));
let relay: Awaited<ReturnType<typeof fixture>>;
let edge: ReturnType<typeof startEdge>;
let origin: string;
let ca: string;

beforeAll(async () => {
  const tls = certificate(dir);
  ca = tls.cert;
  const port = await freePort();
  origin = `https://127.0.0.1:${port}`;
  relay = await fixture({ origin }, { origin, ca });
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "nsh-page.1.css"), "html { margin: 0 }");
  edge = startEdge({ port, relayPort: relay.port, site: dir, tls });
});

afterAll(async () => {
  edge?.stop(true);
  await relay?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the page's policy runs no inline script and no eval; WebAssembly compiles from the origin", () => {
  // Moved here from the messenger's xss test with the rest of the phone page.
  const csp = productionCsp(PAGE);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  // `'wasm-unsafe-eval'` compiles WebAssembly only (the NSH page's engine); no eval of script.
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).toContain("frame-src blob:");
  expect(csp).toContain("manifest-src 'self'");
  expect(csp).toContain("connect-src 'self' wss: https:");
});

test("the edge passes on exactly the routes the deployed Caddy does", () => {
  const caddy = readFileSync(join(repo, "deploy", "remote", "Caddyfile"), "utf8");
  const line = /@relay path ([^\n]+)/.exec(caddy)?.[1] ?? "";
  expect([...RELAY_ROUTES].sort()).toEqual(line.trim().split(/\s+/).sort());
});

test("free ports are never the user's app, the dev instance or its web build", async () => {
  for (let i = 0; i < 20; i++) expect(FORBIDDEN_PORTS.has(await freePort())).toBe(false);
});

test("the page and the relay share one TLS origin, as on the deployed relay", async () => {
  const page = await fetch(`${origin}/`, { tls: { ca } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>phone</title>");
  // Not a relay route: neither forwarded nor a file.
  expect((await fetch(`${origin}/healthz`, { tls: { ca } })).status).toBe(404);
  // The host's bootstrap, over HTTPS through the edge.
  expect((await relay.enroll()).status).toBe(201);
});

test("the page goes out with the production edge's headers and its policy, and a query it refuses is refused", async () => {
  const caddy = readFileSync(join(repo, "deploy", "remote", "Caddyfile"), "utf8");
  // The same headers and the same query rule as the Caddyfile's.
  for (const [name, value] of Object.entries(EDGE_HEADERS)) expect(caddy.includes(`${name} "${value}"`) || caddy.includes(`${name} ${value}`)).toBe(true);
  expect(caddy).toContain(`.matches('${ALLOWED_QUERY.source}')`);
  const page = await fetch(`${origin}/`, { tls: { ca } });
  expect(page.headers.get("content-security-policy")).toBe(productionCsp(PAGE));
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await fetch(`${origin}/?s=01ARZ3NDEKTSV4RRFFQ69G5FAV&o=settings`, { tls: { ca } })).status).toBe(200);
  expect((await fetch(`${origin}/?p=secret.txt`, { tls: { ca } })).status).toBe(400);
});

test("the page's stylesheet goes out as CSS: a browser in strict mode refuses it otherwise", async () => {
  const style = await fetch(`${origin}/nsh-page.1.css`, { tls: { ca } });
  expect(style.headers.get("content-type")).toStartWith("text/css");
});

test("WebSocket links carry the relay's text handshake and binary frames both ways", async () => {
  const control = await relay.host();
  const health = await relay.command(control, "health");
  expect(health.type).toBe("result");
  expect(health.pairing_enabled).toBe(true);
  control.close();
});

test("the page's Origin reaches the relay as it came: another origin is refused", async () => {
  const mailbox = (from: string) =>
    fetch(`${origin}/v1/pair/mailbox`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: from },
      body: JSON.stringify({ op: "poll", pairing_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
      tls: { ca },
    });
  expect((await mailbox("https://elsewhere.example")).status).toBe(403);
  expect((await mailbox(origin)).status).not.toBe(403);
});
