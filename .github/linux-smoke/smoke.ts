/**
 * The installed Linux app, end to end, on a headless X server: tauri-driver starts the real binary
 * from the deb under WebKitWebDriver, and this drives it over plain W3C WebDriver HTTP. Every check
 * is recorded and the run goes on, so one run shows everything that is broken; screenshots and
 * results.json land in the output folder for the workflow to upload.
 *
 *   bun smoke.ts <app binary> <output dir>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [app, out] = process.argv.slice(2);
if (!app || !out) throw new Error("usage: bun smoke.ts <app binary> <output dir>");
mkdirSync(out, { recursive: true });

const WD = "http://127.0.0.1:4444";
const results: Array<{ check: string; ok: boolean; detail: unknown }> = [];
function record(check: string, ok: boolean, detail: unknown = null): void {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check}${detail === null ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}
async function attempt(check: string, run: () => Promise<{ ok: boolean; detail?: unknown }>): Promise<void> {
  try {
    const { ok, detail } = await run();
    record(check, ok, detail ?? null);
  } catch (error) {
    record(check, false, String(error));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await sleep(500);
    last = await read();
  }
  return last;
}

async function wd(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${WD}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { value: any };
  if (json.value && typeof json.value === "object" && "error" in json.value) {
    throw new Error(`${json.value.error}: ${json.value.message}`);
  }
  return json.value;
}

const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
const sid: string = session.sessionId;
const run = (script: string, args: unknown[] = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
const runAsync = (script: string, args: unknown[] = []) => wd("POST", `/session/${sid}/execute/async`, { script, args });
async function shot(name: string): Promise<void> {
  try {
    const png = await wd("GET", `/session/${sid}/screenshot`);
    writeFileSync(join(out, `${name}.png`), Buffer.from(png, "base64"));
  } catch (error) {
    console.log(`screenshot ${name} failed: ${error}`);
  }
}

await attempt("the window loads the messenger", async () => {
  const text = await until(() => run("return document.body ? document.body.innerText : ''"), (value: string) => value.trim().length > 20, 60_000);
  return { ok: text.trim().length > 20, detail: text.slice(0, 300) };
});
await sleep(2000);
await shot("01-first-start");

await attempt("WebKitGTK has what the messenger leans on", async () => {
  const caps = await run(`
    const canvas = document.createElement('canvas');
    return {
      platform: navigator.platform,
      dataPlatform: document.documentElement.dataset.platform ?? null,
      webLocks: !!(navigator.locks && navigator.locks.request),
      highlights: typeof CSS !== 'undefined' && !!CSS.highlights,
      containerQueries: CSS.supports('container-type: inline-size'),
      webgl2: !!canvas.getContext('webgl2'),
      webgl: !!document.createElement('canvas').getContext('webgl'),
      tauri: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      userAgent: navigator.userAgent,
    };`);
  return { ok: caps.webLocks && caps.highlights && caps.containerQueries && caps.tauri && /linux/i.test(caps.platform), detail: caps };
});

const dataDir = join(homedir(), ".local", "share", "real-bot");
let api = { port: 0, token: "" };
await attempt("the data folder is ~/.local/share/real-bot and the daemon answers", async () => {
  const descriptor = join(dataDir, "local-api.json");
  await until(async () => existsSync(descriptor), Boolean, 30_000);
  api = JSON.parse(readFileSync(descriptor, "utf8"));
  const health = await until(() => fetch(`http://127.0.0.1:${api.port}/v1/health`, { headers: { Authorization: `Bearer ${api.token}` } }).then((r) => r.status).catch(() => 0), (status) => status === 200);
  return { ok: health === 200, detail: { descriptor, health } };
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

await attempt("remote access says it is not there yet on Linux", async () => {
  const { json } = await call("GET", "/v1/snapshot");
  return { ok: json?.remoteStatus?.diagnostic === "platform_unsupported", detail: json?.remoteStatus ?? null };
});

const workspace = join(homedir(), "smoke-workspace");
mkdirSync(workspace, { recursive: true });
await attempt("a workspace can be set", async () => {
  const { status, json } = await call("PATCH", "/v1/settings", { workspace_path: workspace });
  return { ok: status === 200, detail: { status, workspace_path: json?.workspace_path } };
});

await attempt("a file goes to the home Trash, where a file manager can put it back", async () => {
  writeFileSync(join(workspace, "notes 中.md"), "to the trash\n");
  const { status, json } = await call("POST", "/v1/workspace/trash", { paths: ["notes 中.md"] });
  const trash = join(homedir(), ".local", "share", "Trash");
  const info = join(trash, "info", "notes 中.md.trashinfo");
  const infoText = existsSync(info) ? readFileSync(info, "utf8") : null;
  const ok = status === 200 && json?.trashed?.length === 1 && existsSync(join(trash, "files", "notes 中.md")) && !existsSync(join(workspace, "notes 中.md")) && /Path=.*%E4%B8%AD/.test(infoText ?? "");
  return { ok, detail: { status, json, infoText } };
});

await attempt("a terminal runs a command in the packaged pty helper", async () => {
  const created = await call("POST", "/v1/terminals", { cwd: workspace });
  const id = created.json?.id;
  if (!id) return { ok: false, detail: created };
  const scrollback = async () => {
    const { json } = await call("GET", `/v1/terminals/${id}/scrollback?from=0`);
    return Buffer.from(json?.data ?? "", "base64").toString("utf8");
  };
  const send = (text: string) => call("POST", `/v1/terminals/${id}/input`, { data: Buffer.from(text).toString("base64") });
  await sleep(1500);
  await send("echo smoke-$((40+2)) \"$0\" \"$(tty)\"\n");
  const first = await until(scrollback, (text) => text.includes("smoke-42"));
  await send("sleep 100\n");
  await sleep(800);
  const signalled = await call("POST", `/v1/terminals/${id}/signal`, { signal: "SIGINT" });
  await sleep(500);
  await send("echo after-$?-$((1+1))\n");
  const second = await until(scrollback, (text) => /after-130-2/.test(text), 15_000);
  writeFileSync(join(out, "terminal.txt"), second);
  await call("DELETE", `/v1/terminals/${id}`);
  return { ok: first.includes("smoke-42") && /after-130-2/.test(second) && signalled.status === 204, detail: second.slice(-500) };
});

await attempt("the terminal's Paste reads the X clipboard through GTK", async () => {
  const text = await runAsync("const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('read_clipboard_text').then(done, (e) => done('ERR ' + e));");
  return { ok: text === "clip-from-x11", detail: text };
});

await attempt("Show in the file manager answers without an error", async () => {
  writeFileSync(join(workspace, "shown.md"), "x\n");
  const answer = await runAsync("const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('open_workspace_path', { path: arguments[0], reveal: true }).then(() => done('ok'), (e) => done('ERR ' + e));", [join(workspace, "shown.md")]);
  return { ok: answer === "ok", detail: answer };
});

await attempt("the update check does not offer the macOS .dmg", async () => {
  const answer = await runAsync("const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('check_for_update', { force: true }).then((v) => done(v), (e) => done('ERR ' + e));");
  const url = typeof answer === "object" ? answer?.download_url ?? "" : String(answer);
  return { ok: typeof answer === "object" && !/\.dmg$/.test(url), detail: answer };
});

await sleep(1000);
await shot("02-after-checks");
await attempt("the window still shows the messenger after the checks", async () => {
  const text = await run("return document.body ? document.body.innerText : ''");
  return { ok: text.trim().length > 20, detail: text.slice(0, 300) };
});

await wd("DELETE", `/session/${sid}`).catch(() => {});
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
