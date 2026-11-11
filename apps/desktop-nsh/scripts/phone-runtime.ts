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
    console.log(
      JSON.stringify({
        origin: handle.origin,
        token: handle.token,
        dataDir,
        writerDirect: writer.direct_session.id,
        editorDirect: editor.direct_session.id,
        group: group.id,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await stop();
  }
}
