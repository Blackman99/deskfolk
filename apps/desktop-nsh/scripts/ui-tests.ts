/**
 * The app's screen tests against a real, isolated runtime: a throwaway data directory, a free
 * loopback port, an in-memory keystore, the scheduler off and a model endpoint that refuses at once
 * (a line sent from a test makes a turn that fails fast; no model is called). Seeds two Bots, a
 * direct with Markdown in it and a group, and a directory for a project session, writes what
 * the tests need to `app/.ui/.fixture.json`, runs every `app/.ui/*.test.tsx` headless (a hidden
 * directory, so a plain `nsh test` leaves them out), and stops the runtime. Never the dev or
 * stable instance.
 *
 *   bun apps/desktop-nsh/scripts/ui-tests.ts [name filter] [--retry]
 *
 * `--retry` runs a file that failed once more and goes by that second run, naming the file: a slow
 * CI runner can miss a test's own time limit or a timing-bound check now and then, while a real
 * regression fails both times.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_KINDS, type AgentStatus } from "@real-bot/protocol";
import { AGENT_LAUNCH } from "../../daemon/src/agents/registry";
import { ptyHelperPath } from "../../daemon/src/pty";
import { startRuntime } from "../../daemon/src/runtime";
import { memoryKeyStore } from "../../daemon/src/secrets";
import { nshCli } from "./nsh-cli";
import { trimTargets } from "./trim-target";

const root = resolve(import.meta.dir, "..");
const retry = process.argv.includes("--retry");
const filter = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

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
const workspaceAlt = join(dataDir, "workspace-alt");
mkdirSync(workspace, { recursive: true });
mkdirSync(workspaceAlt, { recursive: true });
const port = await freePort();
// Isolate agent probing from whatever CLIs happen to be installed on the developer's machine so
// local runs see the same "not installed" state as a clean CI runner.
const isolatedAgentDescribe = async (runner: keyof typeof AGENT_LAUNCH, custom: { id: string; name: string } | null): Promise<AgentStatus> => ({
  runner,
  custom_id: custom?.id ?? null,
  label: runner === "custom" && custom ? custom.name : AGENT_KINDS[runner].label,
  path: null,
  source: null,
  version: null,
  logged_in: null,
  auth: null,
  login_command: AGENT_LAUNCH[runner].login,
  models: [],
  default_model: null,
  proxy: null,
  proxy_source: null,
  checked_at: new Date().toISOString(),
  error: "not found",
});
const handle = await startRuntime({
  dataDir,
  bind: `127.0.0.1:${port}`,
  endpointKey: memoryKeyStore(),
  schedule: false,
  supervisor: "none",
  agentDescribe: isolatedAgentDescribe,
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
    workspaceAlt,
    projectDir,
    elsewhere,
    pty: hasPtyHelper(),
  };
  writeFileSync(join(root, "app", ".ui", ".fixture.json"), JSON.stringify(fixture), { mode: 0o600 });

  trimTargets();
  const nsh = nshCli({ build: true });
  const files = readdirSync(join(root, "app", ".ui"))
    .filter((f) => f.endsWith(".test.tsx") && (!filter || f.includes(filter)))
    .sort();
  status = 0;
  const runFile = async (file: string) => {
    const test = Bun.spawn([nsh, "test", `.ui/${file}`], {
      cwd: join(root, "app"),
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` },
    });
    return (await test.exited) === 0;
  };
  const flaky: string[] = [];
  for (const file of files) {
    if (await runFile(file)) continue;
    if (retry && (await runFile(file))) {
      flaky.push(file);
      continue;
    }
    status = 1;
  }
  if (flaky.length) console.log(`passed on a second run: ${flaky.join(", ")}`);
} finally {
  rmSync(join(root, "app", ".ui", ".fixture.json"), { force: true });
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(status);
