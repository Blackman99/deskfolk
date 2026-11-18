/**
 * The Mac of `phone-web-e2e.ts`: an isolated runtime (a throwaway data directory, a free loopback
 * port, an in-memory keystore, the scheduler off, a model endpoint that refuses at once), seeded as
 * `ui-tests.ts` seeds its own, with remote access on the development channel
 * (`REAL_BOT_DEV_REMOTE=1` in this process's environment: credentials in a 0600 file in the data
 * directory, confirmations by stand-in, no Keychain, no Touch ID). Run as a child so the relay's
 * test certificate reaches it through `NODE_EXTRA_CA_CERTS`. Prints one JSON line (address, token,
 * data directory, the seeded ids) and runs until SIGTERM or SIGINT, then stops and removes it all.
 *
 *   REAL_BOT_DEV_REMOTE=1 NODE_EXTRA_CA_CERTS=<cert> bun apps/desktop-nsh/scripts/phone-runtime.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../../daemon/src/runtime";
import { memoryKeyStore } from "../../daemon/src/secrets";

/** The user's app, the dev instance and its web build: never these. */
export const FORBIDDEN_PORTS = new Set([17890, 17990, 17991]);

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((done, fail) => {
      const server = createServer();
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => done(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port && !FORBIDDEN_PORTS.has(port)) return port;
  }
}

if (import.meta.main) {
  if (process.env.REAL_BOT_DEV_REMOTE !== "1") throw new Error("start this with REAL_BOT_DEV_REMOTE=1");
  const dataDir = mkdtempSync(join(tmpdir(), "deskfolk-phone-mac-"));
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
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await handle.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${handle.origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
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
    // History that fills more than a phone's screen, so the conversation scrolls; the reply below has
    // a code block and a table wider than the phone, each scrolling sideways in it.
    for (let n = 1; n <= 24; n++) store.postMessage(writer.direct_session.id, { body: `早先的第 ${n} 行` });
    const ask = store.postMessage(writer.direct_session.id, { body: "帮我写个摘要" });
    const turn = store.createTurn({ sessionId: writer.direct_session.id, botId: writer.bot.id, triggerMessageId: ask.id });
    store.insertMessage({
      sessionId: writer.direct_session.id,
      turnId: turn.id,
      kind: "bot",
      author: writer.bot.id,
      body:
        "好的，这是摘要：\n\n- 第一点\n- **第二点**\n\n```ts\nconst x = 1;\nexport function summarize(items: string[], options: { limit: number; separator: string }): string { return items.slice(0, options.limit).join(options.separator); }\n```\n\n" +
        "| 项目 | 负责人 | 开始 | 结束 | 状态 | 备注 |\n|---|---|---|---|---|---|\n| 周报整理 | Writer | 11-01 | 11-07 | 完成 | 第一版已经交给审稿 |\n| 摘要改写 | Editor | 11-08 | 11-14 | 进行中 | 等第二轮意见回来再合并 |\n\n收尾一行。",
    });
    // A command the turn ran, with a file's code as its output: the card under the reply paints it.
    store.recordTurnRun({
      turnId: turn.id,
      tool: "shell",
      command: "cat src/summary.ts",
      exitCode: 0,
      ok: true,
      toolCallId: "call-summary",
      durationMs: 40,
      output: 'export const limit = 3;\nexport function join(items: string[]): string {\n  return items.slice(0, limit).join(", ");\n}\n',
    });
    store.setTurnStatus(turn.id, "completed");
    const group = (await api("POST", "/v1/sessions", { name: "周报小组", members: [writer.bot.id, editor.bot.id] })) as { id: string };
    // A Claude Code project session, so the projects tab draws Claude's logo; it never starts a turn.
    const claudeProject = store.createProjectSession({ dir: workspace, agent: "claude_code", configDir: null, locale: "zh" });
    console.log(
      JSON.stringify({
        origin: handle.origin,
        token: handle.token,
        dataDir,
        writerDirect: writer.direct_session.id,
        editorDirect: editor.direct_session.id,
        group: group.id,
        claudeProject: claudeProject.id,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await stop();
  }
}
