/**
 * Permission modes on the app's setup and in what a Bot is told (ADR 0092). The file and command
 * gates are tested beside each runner (`workspace-tools`, `claude-code/policy`, the agent runners).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { situationUserMessage } from "./context/situation";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function setup(mode?: "read_only" | "ask_first" | "auto" | "allow_all") {
  const store = new Store({ endpointKey: memoryKeyStore() });
  stores.push(store);
  const { bot, direct_session } = store.createBot({ name: "Admin", duties: "set things up", boundaries: "none", permission_mode: mode ?? null });
  const line = store.postMessage(direct_session.id, { body: "set it up" });
  const turn = store.createTurn({ sessionId: direct_session.id, botId: bot.id, triggerMessageId: line.id });
  const ctx: ToolCtx = { store, botId: bot.id, sessionId: direct_session.id, turnId: turn.id, parentId: null };
  return { store, bot, session: direct_session.id, line, turn, ctx };
}

const STDIO = { name: "probe", command: "bun", args: ["run", "fix.ts"], enabled: false };

describe("changes to the app's setup", () => {
  test("auto asks before adding an MCP server; allow_all adds it with no card", async () => {
    const auto = setup("auto");
    expect((await runCollabTool(auto.ctx, "add_mcp_server", STDIO)).waitApproval?.kind_key).toBe("mcp-add");
    expect(auto.store.listMcpServers()).toHaveLength(0);

    const all = setup("allow_all");
    const added = await runCollabTool(all.ctx, "add_mcp_server", STDIO);
    expect(added.ok).toBe(true);
    expect(added.waitApproval).toBeUndefined();
    expect(all.store.listMcpServers().map((row) => row.name)).toEqual(["probe"]);
    const id = String(added.data?.id);
    const edited = await runCollabTool(all.ctx, "update_mcp_server", { id, command: "npx" });
    expect(edited.ok).toBe(true);
    expect(edited.waitApproval).toBeUndefined();
  });

  test("a card that carries your key still comes up in allow_all: the key is yours to paste", async () => {
    const { ctx } = setup("allow_all");
    const http = await runCollabTool(ctx, "add_mcp_server", { name: "remote", url: "https://mcp.example.invalid/mcp" });
    expect(http.waitApproval).toMatchObject({ kind_key: "mcp-add", requiresApiKey: true });
    const endpoint = await runCollabTool(ctx, "add_endpoint", { name: "Cloud", base_url: "https://api.example.invalid/v1" });
    expect(endpoint.waitApproval).toMatchObject({ kind_key: "endpoint-add", requiresApiKey: true });
    // A model server on this machine takes no key: nothing to ask.
    const local = await runCollabTool(ctx, "add_endpoint", { name: "Local", base_url: "http://127.0.0.1:11434/v1" });
    expect(local.ok).toBe(true);
    expect(local.waitApproval).toBeUndefined();
  });

  test("read-only changes nothing in the setup, removals and notes included, and puts up no card", async () => {
    const { store, bot, ctx } = setup("allow_all");
    const added = await runCollabTool(ctx, "add_mcp_server", STDIO);
    const id = String(added.data?.id);
    store.patchBot(bot.id, { permission_mode: "read_only" });
    for (const [name, args] of [
      ["add_mcp_server", { ...STDIO, name: "other" }],
      ["update_mcp_server", { id, usage_note: "use it for probes" }],
      ["delete_mcp_server", { id }],
      ["add_endpoint", { name: "Local", base_url: "http://127.0.0.1:11434/v1" }],
    ] as const) {
      const refused = await runCollabTool(ctx, name, args);
      expect([name, refused.error?.code]).toEqual([name, "refused"]);
      expect(refused.waitApproval).toBeUndefined();
    }
    expect(store.listMcpServers().map((row) => [row.name, row.usage_note ?? null])).toEqual([["probe", null]]);
    // Looking is still free.
    expect((await runCollabTool(ctx, "list_mcp_servers", {})).ok).toBe(true);
  });
});

describe("what a Bot is told", () => {
  test("the situation names the mode only where it changes how the Bot works", () => {
    for (const [mode, zh, en] of [
      ["read_only", "你的权限模式：只读。", "Your permission mode: read-only."],
      ["ask_first", "你的权限模式：改动先问。", "Your permission mode: ask first."],
    ] as const) {
      const { store, bot, session, line, turn } = setup(mode);
      expect(String(situationUserMessage(store, session, line.id, "zh", bot.id, turn.id)?.content)).toContain(zh);
      expect(String(situationUserMessage(store, session, line.id, "en", bot.id, turn.id)?.content)).toContain(en);
    }
    for (const mode of ["auto", "allow_all"] as const) {
      const { store, bot, session, line, turn } = setup(mode);
      expect(String(situationUserMessage(store, session, line.id, "zh", bot.id, turn.id)?.content ?? "")).not.toContain("权限模式");
    }
  });

  test("a Bot following the app's mode is told the app's", () => {
    const { store, bot, session, line, turn } = setup();
    store.patchSettingsSync({ permission_mode: "read_only" });
    expect(String(situationUserMessage(store, session, line.id, "zh", bot.id, turn.id)?.content)).toContain("你的权限模式：只读。");
  });
});
