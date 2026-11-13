/**
 * The app's screen tests against a real, isolated runtime: a throwaway data directory, a free
 * loopback port, an in-memory keystore, the scheduler off and a model endpoint that refuses at once
 * (a line sent from a test makes a turn that fails fast; no model is called). Seeds two Bots, a
 * direct with Markdown in it and a group, and a directory for a project session, writes what
 * the tests need to `app/.ui/.fixture.json`, runs every `app/.ui/*.test.tsx` headless (a hidden
 * directory, so a plain `nsh test` leaves them out), and stops the runtime. Never the dev or
 * stable instance.
 *
 *   bun apps/desktop-nsh/scripts/ui-tests.ts [name filter]
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ptyHelperPath } from "../../daemon/src/pty";
import { startRuntime } from "../../daemon/src/runtime";
import { memoryKeyStore } from "../../daemon/src/secrets";
import { nshCli } from "./nsh-cli";

const root = resolve(import.meta.dir, "..");
const filter = process.argv[2];

/** Whether this runtime can start a shell; without the helper the terminal tests are skipped. */
function hasPtyHelper(): boolean {
  try {
    ptyHelperPath();
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "deskfolk-nsh-ui-"));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });
const port = await freePort();
const handle = await startRuntime({
  dataDir,
  bind: `127.0.0.1:${port}`,
  endpointKey: memoryKeyStore(),
  schedule: false,
  supervisor: "none",
});

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${handle.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

let status = 1;
try {
  await api("PATCH", "/v1/settings", {
    workspace_path: workspace,
    endpoint_base_url: "http://127.0.0.1:9/v1",
    endpoint_api_key: "fixture-key",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
    locale: "zh",
  });
  const store = handle.store;
  const writer = store.createBot({ name: "Writer", duties: "写东西、改东西", boundaries: "只在工作区里动手", model: "fixture" });
  const editor = store.createBot({ name: "Editor", duties: "审稿", boundaries: "只读", model: "fixture" });
  const ask = store.postMessage(writer.direct_session.id, { body: "帮我写个摘要" });
  const turn = store.createTurn({ sessionId: writer.direct_session.id, botId: writer.bot.id, triggerMessageId: ask.id });
  store.insertMessage({
    sessionId: writer.direct_session.id,
    turnId: turn.id,
    kind: "bot",
    author: writer.bot.id,
    body: "好的，这是摘要：\n\n- 第一点\n- **第二点**\n\n```ts\nconst x = 1;\n```",
  });
  store.setTurnStatus(turn.id, "completed");
  const group = (await api("POST", "/v1/sessions", { name: "周报小组", members: [writer.bot.id, editor.bot.id] })) as { id: string };
  // A directory outside the workspace with a file to edit, for a project session a test makes on
  // it (ADR 0095) and takes away again: a seeded one would show in every sidebar.
  const projectDir = join(dataDir, "project");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "main.py"), "def main():\n    return 1\n");
  // A file an agent might cite from elsewhere on the Mac (`~/Downloads/…`): in neither the
  // workspace nor the project, it still opens beside the project's tree (decision 29).
  const elsewhere = join(dataDir, "elsewhere", "notes.md");
  mkdirSync(join(dataDir, "elsewhere"), { recursive: true });
  writeFileSync(elsewhere, "# Elsewhere\n\nA file from outside the project.\n");

  const fixture = {
    origin: handle.origin,
    token: handle.token,
    writerDirect: writer.direct_session.id,
    editorDirect: editor.direct_session.id,
    group: group.id,
    workspace,
    projectDir,
    elsewhere,
    pty: hasPtyHelper(),
  };
  writeFileSync(join(root, "app", ".ui", ".fixture.json"), JSON.stringify(fixture), { mode: 0o600 });

  const nsh = nshCli({ build: true });
  const files = readdirSync(join(root, "app", ".ui"))
    .filter((f) => f.endsWith(".test.tsx") && (!filter || f.includes(filter)))
    .sort();
  status = 0;
  for (const file of files) {
    const test = Bun.spawn([nsh, "test", `.ui/${file}`], {
      cwd: join(root, "app"),
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` },
    });
    if ((await test.exited) !== 0) status = 1;
  }
} finally {
  rmSync(join(root, "app", ".ui", ".fixture.json"), { force: true });
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(status);
