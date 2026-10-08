import { afterEach, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import type { CompletionsClient } from "../completions";
import { createLocalApi, type LocalApi, type LocalApiOptions } from "../local-api";
import { memoryKeyStore } from "../secrets";
import { Store } from "../store";
import type { TurnEngine } from "../turn-engine";
import type { SharedInstall } from "../store/schema-gate";
import type { TrashMover } from "../workspace-trash";

export type Harness = {
  origin: string;
  token: string;
  store: Store;
  engine: TurnEngine;
  api: LocalApi;
  close: () => Promise<void>;
};

export const harnesses: Harness[] = [];
export const fixtures: Array<{ close: () => Promise<void> }> = [];

/** Call once at the top level of a test file so every test closes the servers it started. */
export function registerLocalApiCleanup(): void {
  afterEach(async () => {
    while (harnesses.length) await harnesses.pop()?.close();
    while (fixtures.length) await fixtures.pop()?.close();
  });
}

export async function startLocalApi(
  opts: {
    store?: Store;
    token?: string;
    /** Key for the store's key store when no store is passed. */
    key?: string | null;
    completions?: CompletionsClient;
    onQuit?: () => void;
    trash?: TrashMover;
    installedApp?: () => SharedInstall | null;
    log?: (line: string) => void;
    localEndpoint?: LocalApiOptions["localEndpoint"];
  } = {},
): Promise<Harness> {
  const token = opts.token ?? "test-token";
  const store = opts.store ?? new Store({ endpointKey: memoryKeyStore(opts.key ?? null) });
  const api = createLocalApi({
    store,
    token,
    onQuit: opts.onQuit,
    schedule: false,
    trash: opts.trash,
    installedApp: opts.installedApp,
    log: opts.log,
    completions: opts.completions,
    localEndpoint: opts.localEndpoint,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: api.fetch,
    websocket: api.websocket,
  });
  const harness: Harness = {
    origin: `http://${server.hostname}:${server.port}`,
    token,
    store,
    engine: api.engine,
    api,
    close: async () => {
      api.scheduler?.stop();
      await api.engine.close();
      store.close();
      await server.stop(true);
    },
  };
  harnesses.push(harness);
  return harness;
}

export function auth(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${h.token}`, ...extra };
}

/** `auth` with a JSON Content-Type already set. */
export function jsonAuth(h: Harness): Record<string, string> {
  return auth(h, { "Content-Type": "application/json" });
}

export function sse(chunks: unknown[]): Response {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(lines, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

export async function subscribe(h: Harness): Promise<{ events: Array<Record<string, unknown>>; close: () => void }> {
  const events: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  ws.addEventListener("message", (ev) => {
    events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
  });
  ws.send(JSON.stringify({ type: "auth", token: h.token }));
  await Bun.sleep(20);
  return {
    events,
    close: () => ws.close(),
  };
}

export async function waitFor(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for event; saw ${JSON.stringify(events)}`);
}

export async function createWriter(
  h: Harness,
  fixtureOrigin: string,
): Promise<{ botId: string; sessionId: string }> {
  mkdirSync("/tmp/real-bot-ws", { recursive: true });
  await fetch(`${h.origin}/v1/settings`, {
    method: "PATCH",
    headers: jsonAuth(h),
    body: JSON.stringify({
      workspace_path: "/tmp/real-bot-ws",
      endpoint_base_url: fixtureOrigin,
      endpoint_api_key: "sk-test",
      endpoint_models: ["test-model"],
      endpoint_default_model: "test-model",
    }),
  });
  const created = await fetch(`${h.origin}/v1/bots`, {
    method: "POST",
    headers: jsonAuth(h),
    body: JSON.stringify({
      name: "Writer",
      duties: "write the report",
      boundaries: "stay in the workspace",
    }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    bot: { id: string };
    direct_session: { id: string };
  };
  return { botId: body.bot.id, sessionId: body.direct_session.id };
}

export async function createGroupWithBots(
  h: Harness,
  fixtureOrigin: string,
  names: Array<{ name: string; duties: string }>,
): Promise<{ bots: Array<{ id: string; name: string }>; groupId: string }> {
  mkdirSync("/tmp/real-bot-ws", { recursive: true });
  await fetch(`${h.origin}/v1/settings`, {
    method: "PATCH",
    headers: jsonAuth(h),
    body: JSON.stringify({
      workspace_path: "/tmp/real-bot-ws",
      endpoint_base_url: fixtureOrigin,
      endpoint_api_key: "sk-test",
      endpoint_models: ["test-model"],
      endpoint_default_model: "test-model",
    }),
  });
  const bots: Array<{ id: string; name: string }> = [];
  for (const row of names) {
    const created = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: jsonAuth(h),
        body: JSON.stringify({ name: row.name, duties: row.duties, boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string; name: string } };
    bots.push(created.bot);
  }
  const group = (await (
    await fetch(`${h.origin}/v1/sessions`, {
      method: "POST",
      headers: jsonAuth(h),
      body: JSON.stringify({ name: "Brief", members: bots.map((b) => b.id) }),
    })
  ).json()) as { id: string };
  return { bots, groupId: group.id };
}
