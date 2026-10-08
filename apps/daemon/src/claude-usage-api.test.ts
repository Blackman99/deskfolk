import { afterEach, expect, test } from "bun:test";
import type { ClaudeCodeStatus, ClaudeUsage } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./claude-code/probe";
import type { ClaudeUsageProbe } from "./claude-code/usage";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { validateBusiness } from "./remote/routes";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });

const usage: ClaudeUsage = {
  available: true, reason: null, plan: "pro", checked_at: "2026-10-08T11:00:00.000Z", error: null,
  windows: [{ kind: "five_hour", model: null, percent: 2, resets_at: "2026-10-08T15:50:00.000Z" }],
};

function start(options: { claudeUsage?: ClaudeUsageProbe; claudeCode?: ClaudeCodeProbe } = {}) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "usage-test", schedule: false, ...options });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  closes.push(async () => { await api.engine.close(); store.close(); await server.stop(true); });
  const origin = `http://${server.hostname}:${server.port}`;
  const get = (query = "") => fetch(`${origin}/v1/claude-usage${query}`, { headers: { Authorization: "Bearer usage-test" } });
  return { store, api, get, origin };
}

test("the window reads the usage, and a refresh asks for a younger answer", async () => {
  const ages: Array<number | undefined> = [];
  const h = start({ claudeUsage: { current: async (maxAgeMs) => { ages.push(maxAgeMs); return usage; } } });
  const plain = await h.get();
  expect(plain.status).toBe(200);
  expect(await plain.json()).toEqual(usage);
  expect((await h.get("?refresh=1")).status).toBe(200);
  expect(ages).toEqual([undefined, 30_000]);
  expect((await fetch(`${h.origin}/v1/claude-usage`)).status).toBe(401);
});

test("a phone reads it too: the bare GET and a refresh are whitelisted, nothing else is", async () => {
  const h = start({ claudeUsage: { current: async () => usage } });
  const id = ulid();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/claude-usage" })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/claude-usage", query: { refresh: "1" } })).not.toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "GET", path: "/v1/claude-usage", query: { refresh: "yes" } })).toThrow();
  expect(() => validateBusiness({ v: 1, id, method: "POST", path: "/v1/claude-usage" })).toThrow();
  const remote = await h.api.dispatchBusiness(new Request("http://remote.invalid/v1/claude-usage"), { deviceId: "paired-device", requestId: ulid() });
  expect(remote.status).toBe(200);
  expect(await remote.json()).toEqual(usage);
});

test("until a Bot runs on Claude Agent, nothing about Claude Code is even looked up", async () => {
  let looked = 0;
  const status = { path: null } as unknown as ClaudeCodeStatus;
  const claudeCode: ClaudeCodeProbe = {
    last: () => null,
    current: async () => { looked += 1; return status; },
    detect: async () => { looked += 1; return status; },
  };
  const h = start({ claudeCode });
  h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
  expect(await (await h.get()).json()).toMatchObject({ available: false, reason: "unused" });
  expect(looked).toBe(0);
  h.store.createBot({ name: "Coder", duties: "code", boundaries: "stay", runner: "claude_code" });
  expect(await (await h.get()).json()).toMatchObject({ available: false, reason: "missing" });
  expect(looked).toBe(1);
});
