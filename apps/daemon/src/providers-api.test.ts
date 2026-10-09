import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "./ids";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("empty roster and settings", () => {
  test("providers can be added, patched, and listed without echoing keys", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: workspace }),
    });
    const created = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
        models: ["gpt-4o"],
        available_models: ["gpt-4o", " gpt-4o-mini ", "gpt-4o", "o3"],
        default_model: "gpt-4o",
      }),
    });
    expect(created.status).toBe(201);
    const openai = (await created.json()) as {
      id: string;
      key_set: boolean;
      models: string[];
      available_models: string[];
    };
    expect(openai.key_set).toBe(true);
    expect(openai.available_models).toEqual(["gpt-4o", "gpt-4o-mini", "o3"]);
    expect(JSON.stringify(openai)).not.toContain("sk-openai");
    const second = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-deepseek",
        models: ["deepseek-chat"],
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { available_models: string[] }).available_models).toEqual([]);
    const listed = await fetch(`${h.origin}/v1/providers`, { headers: auth(h) });
    const page = (await listed.json()) as {
      items: Array<{ name: string; key_set: boolean; available_models: string[] }>;
    };
    expect(page.items.map((item) => item.name).sort()).toEqual(["DeepSeek", "OpenAI"]);
    expect(page.items.every((item) => item.key_set)).toBe(true);
    expect(page.items.find((item) => item.name === "OpenAI")?.available_models).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
    ]);
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      default_provider_id: openai.id,
      endpoint_models: ["gpt-4o"],
      wizard_complete: true,
    });
    const patched = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ models: ["gpt-4o", "gpt-4o-mini"], default_model: "gpt-4o-mini" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      available_models: ["gpt-4o", "gpt-4o-mini", "o3"],
      default_model: "gpt-4o-mini",
    });
    const refetched = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ available_models: ["gpt-4o", "gpt-4o-mini"] }),
    });
    expect(refetched.status).toBe(200);
    expect(await refetched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      available_models: ["gpt-4o", "gpt-4o-mini"],
    });
    const rejected = await fetch(`${h.origin}/v1/providers/${openai.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ available_models: "gpt-4o" }),
    });
    expect(rejected.status).toBe(422);
    rmSync(workspace, { recursive: true, force: true });
  });

  test("provider model catalog round-trips price, thinking levels, and strengths", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: workspace }),
    });
    const created = await fetch(`${h.origin}/v1/providers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai",
        models: [
          {
            name: "gpt-4o",
            price: 2.5,
            thinking_levels: ["low", "medium", "high"],
            strengths: ["code", "writing"],
          },
        ],
        default_model: "gpt-4o",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      models: ["gpt-4o"],
      model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
      ],
      default_model: "gpt-4o",
    });
    const listed = await fetch(`${h.origin}/v1/providers`, { headers: auth(h) });
    const page = (await listed.json()) as {
      items: Array<{
        id: string;
        models: string[];
        model_catalog: unknown[];
      }>;
    };
    expect(page.items[0]?.models).toEqual(["gpt-4o"]);
    expect(page.items[0]?.model_catalog).toEqual([
      {
        name: "gpt-4o",
        price: 2.5,
        thinking_levels: ["low", "medium", "high"],
        strengths: ["code", "writing"],
      },
    ]);
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      endpoint_models: ["gpt-4o"],
      endpoint_model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
      ],
    });
    const patched = await fetch(`${h.origin}/v1/providers/${page.items[0]!.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        models: [
          {
            name: "gpt-4o",
            price: 2.5,
            thinking_levels: ["low", "medium", "high"],
            strengths: ["code", "writing"],
          },
          {
            name: "gpt-4o-mini",
            price: 0.15,
            thinking_levels: ["none"],
            strengths: ["chat"],
          },
        ],
        default_model: "gpt-4o-mini",
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      models: ["gpt-4o", "gpt-4o-mini"],
      model_catalog: [
        {
          name: "gpt-4o",
          price: 2.5,
          thinking_levels: ["low", "medium", "high"],
          strengths: ["code", "writing"],
        },
        {
          name: "gpt-4o-mini",
          price: 0.15,
          thinking_levels: ["none"],
          strengths: ["chat"],
        },
      ],
      default_model: "gpt-4o-mini",
    });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("POST /v1/models/probe requires baseUrl and returns probed models", async () => {
    const h = await start();
    const missing = await fetch(`${h.origin}/v1/models/probe`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(422);

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "mock-model-1", reasoning_efforts: ["low", "high", "xhigh"] },
                { id: "mock-model-2" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url);
      }) as unknown as typeof fetch;

      const res = await originalFetch(`${h.origin}/v1/models/probe`, {
        method: "POST",
        headers: auth(h, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          endpoint_base_url: "https://api.example.com/v1",
          endpoint_api_key: "test-key",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        models: ["mock-model-1", "mock-model-2"],
        catalog: [
          { name: "mock-model-1", thinking_levels: ["low", "high", "xhigh"] },
          { name: "mock-model-2", thinking_levels: [] },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a provider's Anthropic workspace round-trips, clears with null or an empty string, and refuses a malformed id", async () => {
    const h = await start();
    const send = (method: string, path: string, body: unknown) =>
      fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    const created = await send("POST", "/v1/providers", { name: "Claude", base_url: "https://api.anthropic.com", api_format: "anthropic", api_key: "sk-ant-usr-x", workspace_id: "wrkspc_01Test", models: ["claude-opus-5-5"] });
    expect(created.status).toBe(201);
    const made = (await created.json()) as { id: string; workspace_id: string | null };
    expect(made.workspace_id).toBe("wrkspc_01Test");
    const listed = (await (await fetch(`${h.origin}/v1/providers`, { headers: auth(h) })).json()) as { items: Array<{ id: string; workspace_id: string | null }> };
    expect(listed.items.find((row) => row.id === made.id)?.workspace_id).toBe("wrkspc_01Test");
    // A patch that leaves it out leaves it be.
    const renamed = await send("PATCH", `/v1/providers/${made.id}`, { name: "Claude 2" });
    expect(((await renamed.json()) as { workspace_id: string | null }).workspace_id).toBe("wrkspc_01Test");
    const bad = await send("PATCH", `/v1/providers/${made.id}`, { workspace_id: "ws-1" });
    expect(bad.status).toBe(422);
    expect((await send("POST", "/v1/providers", { name: "Bad", base_url: "https://api.anthropic.com", workspace_id: "nope" })).status).toBe(422);
    const cleared = await send("PATCH", `/v1/providers/${made.id}`, { workspace_id: "" });
    expect(((await cleared.json()) as { workspace_id: string | null }).workspace_id).toBeNull();
    await send("PATCH", `/v1/providers/${made.id}`, { workspace_id: "wrkspc_02Other" });
    const nulled = await send("PATCH", `/v1/providers/${made.id}`, { workspace_id: null });
    expect(((await nulled.json()) as { workspace_id: string | null }).workspace_id).toBeNull();
    const plain = await send("POST", "/v1/providers", { name: "Plain", base_url: "https://api.openai.com/v1" });
    expect(((await plain.json()) as { workspace_id: string | null }).workspace_id).toBeNull();
  });

  test("POST /v1/models/probe sends the form's workspace, or the named endpoint's saved one", async () => {
    const h = await start();
    const send = (path: string, body: unknown) =>
      fetch(`${h.origin}${path}`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    const created = await send("/v1/providers", { name: "Claude", base_url: "https://api.anthropic.com", api_format: "anthropic", api_key: "sk-ant-usr-x", workspace_id: "wrkspc_01Saved", models: ["claude-opus-5-5"] });
    const id = ((await created.json()) as { id: string }).id;
    const originalFetch = globalThis.fetch;
    const seen: Array<string | undefined> = [];
    try {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes("/v1/models")) return originalFetch(url, init);
        seen.push((init?.headers as Record<string, string>)["anthropic-workspace-id"]);
        return Response.json({ data: [{ type: "model", id: "claude-opus-5-5" }], has_more: false });
      }) as unknown as typeof fetch;
      const probe = (body: unknown) => originalFetch(`${h.origin}/v1/models/probe`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      const base = { endpoint_base_url: "https://api.anthropic.com", endpoint_api_key: "sk-ant-usr-x", api_format: "anthropic" };
      expect((await probe({ ...base, workspace_id: "wrkspc_01Form" })).status).toBe(200);
      expect((await probe({ ...base, provider_id: id })).status).toBe(200);
      expect((await probe({ ...base, provider_id: id, workspace_id: "" })).status).toBe(200);
      expect((await probe({ ...base, provider_id: id, workspace_id: null })).status).toBe(200);
      expect((await probe({ ...base })).status).toBe(200);
      expect((await probe({ ...base, workspace_id: "bad" })).status).toBe(422);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toEqual(["wrkspc_01Form", "wrkspc_01Saved", undefined, undefined, undefined]);
  });

  test("POST /v1/models/probe hands the scope's guard to the probe, so a revoke during key hydration sends nothing", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const api = createLocalApi({ store, token: "test-token", schedule: false });
    await store.patchSettings({ endpoint_base_url: "https://api.example.com/v1", endpoint_api_key: "fixture-only" });
    let revoked = false;
    const original = store.endpointKey.bind(store);
    const hydrate = spyOn(store, "endpointKey").mockImplementation(async (...args) => {
      const key = await original(...args);
      revoked = true;
      return key;
    });
    let outbound = 0;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        outbound++;
        return Response.json({ data: [{ id: "never" }] });
      }) as unknown as typeof fetch;
      const probe = api.dispatchBusiness(
        new Request("http://fixture/v1/models/probe", { method: "POST", body: "{}" }),
        {
          deviceId: "paired-device",
          requestId: ulid(),
          guard: () => {
            if (revoked) throw new Error("revoked");
          },
        },
      );
      await expect(probe).rejects.toThrow("revoked");
      expect(outbound).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      hydrate.mockRestore();
      await api.engine.close();
      store.close();
    }
  });
});
