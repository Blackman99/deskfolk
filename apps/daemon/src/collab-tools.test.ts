import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBoringAvatar } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function ctxFor(store: Store, botId: string, sessionId: string): ToolCtx {
  return {
    store,
    botId,
    sessionId,
    turnId: "turn_1",
    parentId: null,
  };
}

describe("update_profile", () => {
  test("renames the calling bot without inserting a profile_change", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { name: "Scribe" },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.name).toBe("Scribe");
    expect(result.data?.message_id).toBeUndefined();
    expect(store.getBot(created.bot.id).name).toBe("Scribe");
    expect(store.listMainMessages(created.direct_session.id, 10)).toEqual([]);
    expect(result.emitted.some((item) => item.kind === "message")).toBe(false);
    store.close();
  });

  test("a taken name is conflict", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, writer.bot.id, writer.direct_session.id),
      "update_profile",
      { name: "Reviewer" },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "conflict", message: "that name is already used" },
      emitted: [],
    });
    expect(store.getBot(writer.bot.id).name).toBe("Writer");
    store.close();
  });

  test("avatar_style writes a generated SVG", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { avatar_style: "pixel" },
    );
    expect(result.ok).toBe(true);
    const expected = generateBoringAvatar({ name: "Writer", variant: "pixel" });
    expect(result.data?.avatar).toBe(expected);
    expect(store.getBot(created.bot.id).avatar).toBe(expected);
    store.close();
  });

  test("avatar_path inside the workspace stores a raster data URI", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-avatar-")));
    dirs.push(root);
    writeFileSync(join(root, "face.png"), PNG_1X1);
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: root });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { avatar_path: "face.png" },
    );
    expect(result.ok).toBe(true);
    const avatar = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
    expect(result.data?.avatar).toBe(avatar);
    expect(store.getBot(created.bot.id).avatar).toBe(avatar);
    store.close();
  });

  test("avatar_path outside the workspace parks for outside-read approval", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-avatar-ws-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-avatar-out-")));
    dirs.push(workspace, outside);
    const outsideFile = join(outside, "face.png");
    writeFileSync(outsideFile, PNG_1X1);
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: workspace });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { avatar_path: outsideFile },
    );
    expect(result.ok).toBe(false);
    expect(result.waitApproval?.kind_key).toBe("outside-read");
    expect(result.waitApproval?.target).toBe(outsideFile);
    expect(store.getBot(created.bot.id).avatar?.startsWith("<svg")).toBe(true);
    store.close();
  });

  test("avatar_style and avatar_path together are invalid_args", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { avatar_style: "pixel", avatar_path: "face.png" },
    );
    expect(result.error?.code).toBe("invalid_args");
    store.close();
  });

  test("duties-only still works and does not require a name", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, created.bot.id, created.direct_session.id),
      "update_profile",
      { duties: "draft the report" },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.name).toBe("Writer");
    expect(result.data?.duties).toBe("draft the report");
    store.close();
  });
});

describe("send_message artifacts", () => {
  test("paths and body citations attach workspace files without copying", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-art-")));
    dirs.push(root);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "mock.png"), PNG_1X1);
    writeFileSync(join(root, "report.md"), "# hi\n");
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: root });
    const designer = store.createBot({ name: "设计师", duties: "design", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, designer.bot.id, designer.direct_session.id),
      "send_message",
      {
        body: "稿在 [mock](out/mock.png)，报告 `report.md`。",
        paths: ["out/mock.png"],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.paths).toEqual(["out/mock.png", "report.md"]);
    expect(result.data?.unresolved_paths).toEqual([]);
    const message = store.getMessage(String(result.data?.message_id));
    expect(message.body).toContain("[mock](out/mock.png)");
    expect(message.body).toContain("[report.md](report.md)");
    expect(message.attachments.map((a) => a.workspace_relpath)).toEqual(["out/mock.png", "report.md"]);
    expect(message.attachments.every((a) => a.workspace_relpath.startsWith("inbox/"))).toBe(false);
    store.close();
  });

  test("outside paths are unresolved and not attached", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-art-ws-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-art-out-")));
    dirs.push(workspace, outside);
    writeFileSync(join(outside, "secret.txt"), "nope");
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: workspace });
    const designer = store.createBot({ name: "设计师", duties: "design", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, designer.bot.id, designer.direct_session.id),
      "send_message",
      {
        body: "看这个",
        paths: ["../secret.txt", join(outside, "secret.txt")],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.paths).toEqual([]);
    expect((result.data?.unresolved_paths as string[]).length).toBe(2);
    const message = store.getMessage(String(result.data?.message_id));
    expect(message.attachments).toEqual([]);
    store.close();
  });

  test("missing inside paths still attach", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-art-miss-")));
    dirs.push(root);
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: root });
    const designer = store.createBot({ name: "设计师", duties: "design", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, designer.bot.id, designer.direct_session.id),
      "send_message",
      { body: "稍后会有图", paths: ["out/later.png"] },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.paths).toEqual(["out/later.png"]);
    const message = store.getMessage(String(result.data?.message_id));
    expect(message.body).toContain("[out/later.png](out/later.png)");
    expect(message.attachments[0]?.exists).toBe(false);
    store.close();
  });
});

describe("endpoint and MCP catalog tools", () => {
  test("add_endpoint parks for approval and does not write until approved with a key", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const parked = await runCollabTool(ctx, "add_endpoint", {
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/v1",
      models: ["deepseek-chat"],
    });
    expect(parked.waitApproval?.kind_key).toBe("endpoint-add");
    expect(parked.waitApproval?.summary).toContain("DeepSeek");
    expect(parked.waitApproval?.summary).toContain("https://api.deepseek.com/v1");
    expect(parked.waitApproval?.summary).not.toContain("sk-");
    expect((await store.listProviders()).length).toBe(0);

    const written = await runCollabTool(
      { ...ctx, approved: true, approvalApiKey: "sk-deepseek" },
      "add_endpoint",
      {
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        models: ["deepseek-chat"],
      },
    );
    expect(written.ok).toBe(true);
    expect(written.data?.name).toBe("DeepSeek");
    expect(written.data?.key_set).toBe(true);
    expect(written.data?.is_default).toBe(true);
    expect(JSON.stringify(written.data)).not.toContain("sk-deepseek");
    store.close();
  });

  test("the default endpoint cannot change URL or be deleted", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const first = await store.createProvider({
      name: "Home",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-home",
      models: ["gpt-4o"],
    });
    const extra = await store.createProvider({
      name: "Other",
      base_url: "https://api.deepseek.com/v1",
      api_key: "sk-other",
      models: ["deepseek-chat"],
    });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const url = await runCollabTool(ctx, "update_endpoint", {
      id: first.id,
      base_url: "https://evil.example/v1",
    });
    expect(url).toMatchObject({
      ok: false,
      error: { code: "failed", message: "cannot modify the default endpoint's URL or key, or delete it" },
    });
    const del = await runCollabTool(ctx, "delete_endpoint", { id: first.id });
    expect(del.error?.code).toBe("failed");
    const renamed = await runCollabTool(ctx, "update_endpoint", {
      id: first.id,
      name: "Primary",
      models: ["gpt-4o", "gpt-4o-mini"],
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.data?.name).toBe("Primary");
    expect(renamed.data?.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const removed = await runCollabTool(ctx, "delete_endpoint", { id: extra.id });
    expect(removed.ok).toBe(true);
    store.close();
  });

  test("update_profile can pin endpoint_id and model independently", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const provider = await store.createProvider({
      name: "Home",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-home",
      models: ["gpt-4o", "gpt-4o-mini"],
    });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const pinned = await runCollabTool(ctx, "update_profile", {
      endpoint_id: provider.id,
      model: "gpt-4o-mini",
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.data?.endpoint_id).toBe(provider.id);
    expect(pinned.data?.model).toBe("gpt-4o-mini");
    const modelOnly = await runCollabTool(ctx, "update_profile", { model: "gpt-4o" });
    expect(modelOnly.data?.model).toBe("gpt-4o");
    expect(modelOnly.data?.endpoint_id).toBe(provider.id);
    const cleared = await runCollabTool(ctx, "update_profile", { endpoint_id: null, model: null });
    expect(cleared.data?.model).toBeNull();
    expect(cleared.data?.endpoint_id).toBeNull();
    store.close();
  });

  test("add_mcp_server parks; rename and delete run immediately", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const parked = await runCollabTool(ctx, "add_mcp_server", {
      name: "probe",
      command: "bun",
      args: ["run", "fix.ts"],
    });
    expect(parked.waitApproval?.kind_key).toBe("mcp-add");
    expect(parked.waitApproval?.summary).toContain("bun run fix.ts");
    expect(store.listMcpServers()).toHaveLength(0);

    const added = await runCollabTool({ ...ctx, approved: true }, "add_mcp_server", {
      name: "probe",
      command: "bun",
      args: ["run", "fix.ts"],
    });
    expect(added.ok).toBe(true);
    const id = String(added.data?.id);
    const renamed = await runCollabTool(ctx, "update_mcp_server", { id, name: "time" });
    expect(renamed.ok).toBe(true);
    expect(renamed.waitApproval).toBeUndefined();
    expect(renamed.data?.name).toBe("time");
    const editCmd = await runCollabTool(ctx, "update_mcp_server", { id, command: "npx" });
    expect(editCmd.waitApproval?.kind_key).toBe("mcp-edit");
    const removed = await runCollabTool(ctx, "delete_mcp_server", { id });
    expect(removed.ok).toBe(true);
    expect(store.listMcpServers()).toHaveLength(0);
    store.close();
  });

  test("add_mcp_server with a URL parks HTTP MCP and writes auth from the approval card", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const parked = await runCollabTool(ctx, "add_mcp_server", {
      name: "cpa",
      url: "https://cpa.westlakedata.xyz/mcp",
      headers: "Authorization: Bearer secret-token",
    });
    expect(parked.waitApproval?.kind_key).toBe("mcp-add");
    expect(parked.waitApproval?.requiresApiKey).toBe(true);
    expect(parked.waitApproval?.summary).toContain("https://cpa.westlakedata.xyz/mcp");
    expect(parked.waitApproval?.summary).not.toContain("secret-token");
    expect(store.listMcpServers()).toHaveLength(0);

    const missing = await runCollabTool({ ...ctx, approved: true }, "add_mcp_server", {
      name: "cpa",
      url: "https://cpa.westlakedata.xyz/mcp",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("invalid_args");
    const leaked = await runCollabTool({ ...ctx, approved: true }, "add_mcp_server", {
      name: "cpa",
      url: "https://cpa.westlakedata.xyz/mcp",
      headers: "Authorization: Bearer secret-token",
    });
    expect(leaked.ok).toBe(false);
    expect(leaked.error?.code).toBe("invalid_args");
    expect(store.listMcpServers()).toHaveLength(0);

    const added = await runCollabTool(
      { ...ctx, approved: true, approvalApiKey: "Bearer secret-token" },
      "add_mcp_server",
      {
        name: "cpa",
        url: "https://cpa.westlakedata.xyz/mcp",
      },
    );
    expect(added.ok).toBe(true);
    expect(added.data?.transport).toBe("http");
    expect(added.data?.url).toBe("https://cpa.westlakedata.xyz/mcp");
    expect(added.data?.auth_set).toBe(true);
    expect(JSON.stringify(added.data)).not.toContain("secret-token");
    const id = String(added.data?.id);
    expect(await store.mcpAuth(id)).toBe("Bearer secret-token");
    store.close();
  });
});

describe("send_message mentions", () => {
  function filmGroup(store: Store) {
    const director = store.createBot({ name: "导演", duties: "direct", boundaries: "stay" });
    const storyboard = store.createBot({ name: "分镜师", duties: "storyboard", boundaries: "stay" });
    store.createBot({ name: "选题策划", duties: "plan", boundaries: "stay" });
    const group = store.createGroup({ name: "Film", members: [director.bot.id, storyboard.bot.id] });
    return { director, storyboard, group };
  }

  test("a truncated @ resolves to the only matching member and the body stays as typed", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { director, group } = filmGroup(store);
    const result = await runCollabTool(
      { ...ctxFor(store, director.bot.id, group.id), mentionWarned: new Set() },
      "send_message",
      { body: "@分镜 请按锁点出六场镜表" },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.mentions).toEqual(["分镜师"]);
    expect(result.data?.corrected_mentions).toEqual([{ token: "分镜", name: "分镜师" }]);
    expect(result.data?.unresolved_mentions).toEqual([]);
    expect(store.getMessage(String(result.data?.message_id)).body).toBe("@分镜 请按锁点出六场镜表");
    store.close();
  });

  test("lenient matching only reaches members present, not the whole roster", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { director, group } = filmGroup(store);
    const result = await runCollabTool(
      { ...ctxFor(store, director.bot.id, group.id), mentionWarned: new Set() },
      "send_message",
      { body: "@选题 请看一下" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown_mention");
    expect(result.error?.message).toContain("@选题");
    expect(result.error?.message).toContain("Members here: 分镜师.");
    expect(result.error?.message).not.toContain("导演");
    expect(store.listMainMessages(group.id, 10)).toEqual([]);
    store.close();
  });

  test("an unknown @ in a group is rejected once, then the resend goes through", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const { director, group } = filmGroup(store);
    const ctx: ToolCtx = { ...ctxFor(store, director.bot.id, group.id), mentionWarned: new Set() };
    const first = await runCollabTool(ctx, "send_message", { body: "@张三 请出镜表" });
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("unknown_mention");
    expect(store.listMainMessages(group.id, 10)).toEqual([]);
    const second = await runCollabTool(ctx, "send_message", { body: "@张三 请出镜表" });
    expect(second.ok).toBe(true);
    expect(second.data?.unresolved_mentions).toEqual(["张三"]);
    expect(store.listMainMessages(group.id, 10)).toHaveLength(1);
    store.close();
  });

  test("an unknown @ in a direct session still sends", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, writer.bot.id, writer.direct_session.id),
      "send_message",
      { body: "@Nobody hello" },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.unresolved_mentions).toEqual(["Nobody"]);
    store.close();
  });
});
