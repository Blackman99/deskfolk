import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER, generateBoringAvatar } from "@real-bot/protocol";
import { runCollabTool, staleMcpToolNames, type ToolCtx } from "./collab-tools";
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

  test("quoting a teammate prepends @Name and still participates", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const parent = store.insertMessage({
      sessionId: group.id,
      kind: "bot",
      author: writer.bot.id,
      body: "draft ready",
    });
    const result = await runCollabTool(
      ctxFor(store, reviewer.bot.id, group.id),
      "send_message",
      { body: "please revise the ending", parent_id: parent.id },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.mentions).toEqual(["Writer"]);
    const message = store.getMessage(String(result.data?.message_id));
    expect(message.parent_id).toBe(parent.id);
    expect(message.body.startsWith("@Writer ")).toBe(true);
    expect(result.emitted.some((item) => item.kind === "participation")).toBe(true);
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

  test("update_profile pins a thinking level the model supports and clears it with null", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const provider = await store.createProvider({
      name: "Home",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-home",
      models: [
        { name: "cheap-chat", thinking_levels: ["none", "low"] },
        { name: "code-pro", thinking_levels: ["medium", "high"] },
        { name: "grok-4.6", thinking_levels: ["low", "xhigh"] },
      ],
    });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    // A level belongs to a model: without one pinned there is nothing for it to apply to.
    const unpinnedModel = await runCollabTool(ctx, "update_profile", { thinking_level: "high" });
    expect(unpinnedModel.ok).toBe(false);
    expect(unpinnedModel.error?.message).toBe("thinking_level needs a pinned model");
    expect(store.getBot(created.bot.id).thinking_level).toBeNull();

    const unsupported = await runCollabTool(ctx, "update_profile", {
      endpoint_id: provider.id,
      model: "cheap-chat",
      thinking_level: "high",
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error?.code).toBe("invalid_args");
    expect(unsupported.error?.message).toBe("thinking_level must be one the pinned model supports");

    // A name the endpoint advertised is fine as long as that model lists it.
    const extra = await runCollabTool(ctx, "update_profile", {
      endpoint_id: provider.id,
      model: "grok-4.6",
      thinking_level: "xhigh",
    });
    expect(extra.ok).toBe(true);
    expect(extra.data?.thinking_level).toBe("xhigh");
    const bogus = await runCollabTool(ctx, "update_profile", { thinking_level: "high!" });
    expect(bogus.ok).toBe(false);
    expect(bogus.error?.message).toBe("thinking_level must be a reasoning_effort name");

    const pinned = await runCollabTool(ctx, "update_profile", {
      endpoint_id: provider.id,
      model: "code-pro",
      thinking_level: "medium",
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.data?.model).toBe("code-pro");
    expect(pinned.data?.thinking_level).toBe("medium");

    // Swapping to a model that cannot honour the pin moves it to that model's default.
    const switched = await runCollabTool(ctx, "update_profile", { model: "cheap-chat" });
    expect(switched.ok).toBe(true);
    expect(switched.data?.thinking_level).toBe("low");

    // Clearing the level alone lands on the pinned model's default, never on nothing.
    const cleared = await runCollabTool(ctx, "update_profile", { thinking_level: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.data?.thinking_level).toBe("low");

    // Dropping the model drops the level with it.
    const auto = await runCollabTool(ctx, "update_profile", { model: null });
    expect(auto.ok).toBe(true);
    expect(auto.data?.thinking_level).toBeNull();
    expect(
      (await runCollabTool(ctx, "list_bots", {})).data?.bots,
    ).toEqual([expect.objectContaining({ name: "Writer", thinking_level: null })]);
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

  test("read_skill flags mcp_ names the body cites that are not in this hop's tools", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const made = await runCollabTool(ctx, "create_skill", {
      name: "release",
      description: "when releasing",
      body: "1. `mcp_github_get_issue` to check blockers\n2. mcp_github_create_release, then mcp_time_now for the stamp.",
      uses: ["github", " Time ", "github"],
    });
    expect(made.ok).toBe(true);
    expect(made.data?.uses).toEqual(["github", "Time"]);

    const unchecked = await runCollabTool(ctx, "read_skill", { name: "release" });
    expect(unchecked.ok).toBe(true);
    expect(unchecked.data?.stale_tool_names).toBeUndefined();

    const checked = await runCollabTool(
      { ...ctx, availableToolNames: new Set(["read_skill", "mcp_time_now", "mcp_github_get_issue_2"]) },
      "read_skill",
      { name: "release" },
    );
    expect(checked.ok).toBe(true);
    expect(checked.data?.stale_tool_names).toEqual(["mcp_github_create_release", "mcp_github_get_issue"]);
    expect(String(checked.data?.hint)).toContain("update_skill");

    const cleared = await runCollabTool(ctx, "update_skill", { name: "release", uses: [] });
    expect(cleared.ok).toBe(true);
    expect(cleared.data?.uses).toEqual([]);
    const bad = await runCollabTool(ctx, "update_skill", { name: "release", uses: "github" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("invalid_args");
    expect(staleMcpToolNames("nothing cited", new Set())).toEqual([]);
    expect(staleMcpToolNames("form mcp_<server>_<tool>", new Set())).toEqual([]);
    store.close();
  });

  test("usage_note is set on add, edited without approval, and survives a connection change", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const created = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const ctx = ctxFor(store, created.bot.id, created.direct_session.id);
    const added = await runCollabTool({ ...ctx, approved: true }, "add_mcp_server", {
      name: "github",
      command: "bun",
      args: ["run", "gh.ts"],
      usage_note: "  Only for the real-bot repo.  ",
    });
    expect(added.ok).toBe(true);
    expect(added.data?.usage_note).toBe("Only for the real-bot repo.");
    const id = String(added.data?.id);

    const noted = await runCollabTool(ctx, "update_mcp_server", {
      id,
      usage_note: "Read-only: never open pull requests.",
    });
    expect(noted.ok).toBe(true);
    expect(noted.waitApproval).toBeUndefined();
    expect(noted.data?.usage_note).toBe("Read-only: never open pull requests.");
    expect(store.listMcpServers()[0]?.usage_note).toBe("Read-only: never open pull requests.");

    // Changing the connection resets the server-owned instructions but keeps the note.
    await store.patchMcpServer(id, { instructions: "from handshake", tool_catalog: [{ name: "x", description: "" }] });
    const reconnected = await runCollabTool({ ...ctx, approved: true }, "update_mcp_server", { id, command: "npx" });
    expect(reconnected.ok).toBe(true);
    expect(reconnected.data?.instructions).toBeNull();
    expect(reconnected.data?.usage_note).toBe("Read-only: never open pull requests.");

    const cleared = await runCollabTool(ctx, "update_mcp_server", { id, usage_note: "" });
    expect(cleared.ok).toBe(true);
    expect(cleared.data?.usage_note).toBeNull();

    const tooLong = await runCollabTool(ctx, "update_mcp_server", { id, usage_note: "x".repeat(2001) });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error?.code).toBe("invalid_args");
    expect(tooLong.error?.message).toBe("usage_note must be at most 2000 characters");
    const listed = await runCollabTool(ctx, "list_mcp_servers", {});
    expect((listed.data?.servers as Array<Record<string, unknown>>)[0]?.usage_note).toBeNull();
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

  test("skill tools only mutate the calling bot and skip the transcript", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const writerCtx = ctxFor(store, writer.bot.id, writer.direct_session.id);
    const reviewerCtx = ctxFor(store, reviewer.bot.id, reviewer.direct_session.id);
    const created = await runCollabTool(writerCtx, "create_skill", {
      name: "commits",
      description: "when committing",
      body: "use conventional commits",
    });
    expect(created.ok).toBe(true);
    const skillId = String(created.data?.id);
    expect(created.emitted.some((item) => item.kind === "skill")).toBe(true);
    expect(created.emitted.some((item) => item.kind === "message")).toBe(false);
    expect(store.listMainMessages(writer.direct_session.id, 10)).toEqual([]);
    const listed = await runCollabTool(writerCtx, "list_skills", {});
    expect(listed.data?.skills).toEqual([
      {
        id: skillId,
        name: "commits",
        description: "when committing",
        uses: [],
        enabled: true,
      },
    ]);
    const read = await runCollabTool(writerCtx, "read_skill", { name: "commits" });
    expect(read.data?.body).toBe("use conventional commits");
    const foreign = await runCollabTool(reviewerCtx, "read_skill", { id: skillId });
    expect(foreign.error?.code).toBe("not_found");
    const disabled = await runCollabTool(writerCtx, "update_skill", {
      id: skillId,
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    const hidden = await runCollabTool(writerCtx, "read_skill", { id: skillId });
    expect(hidden.error?.code).toBe("not_found");
    const removed = await runCollabTool(writerCtx, "delete_skill", { id: skillId });
    expect(removed.ok).toBe(true);
    expect(removed.emitted).toEqual([{ kind: "skill_removed", id: skillId }]);
    store.close();
  });
});

describe("create_direct", () => {
  /**
   * The unit of independence is the initiation: a Bot that goes to ask someone twice about two
   * different things is having two conversations, not appending to one long-running thread.
   */
  test("each trigger opens its own direct, stamped with the message that set it off", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, researcher.bot.id] });

    const first = store.postMessage(group.id, { body: "price the competition" });
    const turnOne = store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: first.id,
    });
    const openedOne = await runCollabTool(
      { store, botId: writer.bot.id, sessionId: group.id, turnId: turnOne.id, parentId: null },
      "create_direct",
      { name: "Researcher" },
    );

    const second = store.postMessage(group.id, { body: "and their launch dates" });
    const turnTwo = store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: second.id,
    });
    const openedTwo = await runCollabTool(
      { store, botId: writer.bot.id, sessionId: group.id, turnId: turnTwo.id, parentId: null },
      "create_direct",
      { name: "Researcher" },
    );

    expect(openedOne.ok).toBe(true);
    expect(openedTwo.ok).toBe(true);
    expect(openedTwo.data?.session_id).not.toBe(openedOne.data?.session_id);

    const one = store.getSession(String(openedOne.data?.session_id));
    const two = store.getSession(String(openedTwo.data?.session_id));
    expect(one.origin_session_id).toBe(group.id);
    expect(one.origin_message_id).toBe(first.id);
    expect(two.origin_message_id).toBe(second.id);
    store.close();
  });

  /** A model that emits the call twice in one loop, or retries it, gets one session. */
  test("asking again in the same turn returns the direct already open", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = store.createGroup({
      name: "Desk",
      members: [writer.bot.id, store.requireBotByName("Researcher").id],
    });
    const trigger = store.postMessage(group.id, { body: "go ask" });
    const turn = store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    const ctx: ToolCtx = {
      store,
      botId: writer.bot.id,
      sessionId: group.id,
      turnId: turn.id,
      parentId: null,
    };
    const before = store.listSessions().length;
    const first = await runCollabTool(ctx, "create_direct", { name: "Researcher" });
    const again = await runCollabTool(ctx, "create_direct", { name: "Researcher" });
    expect(again.data?.session_id).toBe(first.data?.session_id);
    expect(store.listSessions().length).toBe(before + 1);
    store.close();
  });

  /** No turn on record — the direct still opens, it just has no entry point to hang under. */
  test("a call with no turn on record opens a direct with no source", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const opened = await runCollabTool(
      ctxFor(store, writer.bot.id, writer.direct_session.id),
      "create_direct",
      { name: "Researcher" },
    );
    expect(opened.ok).toBe(true);
    const session = store.getSession(String(opened.data?.session_id));
    expect(session.origin_session_id).toBeNull();
    expect(session.origin_message_id).toBeNull();
    store.close();
  });

  test("the user is never a member of a Bot↔Bot direct", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const opened = await runCollabTool(
      ctxFor(store, writer.bot.id, writer.direct_session.id),
      "create_direct",
      { name: "Researcher" },
    );
    expect(store.isPresent(String(opened.data?.session_id), USER_MEMBER)).toBe(false);
    store.close();
  });
});

describe("ask_user", () => {
  /**
   * The question would be inserted into a session the user cannot answer in, parking the turn
   * on a reply that can never arrive. Better to send the Bot back to where the user is.
   */
  test("a question inside a Bot↔Bot direct is refused instead of hanging the turn", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const direct = store.createBotDirect(writer.bot.id, researcher.bot.id, null);
    const result = await runCollabTool(
      ctxFor(store, writer.bot.id, direct.id),
      "ask_user",
      { question: "which one?" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("not_a_member");
    expect(result.waitAsk).toBeUndefined();
    store.close();
  });

  test("a question where the user is present still parks the turn", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const result = await runCollabTool(
      ctxFor(store, writer.bot.id, writer.direct_session.id),
      "ask_user",
      { question: "which one?" },
    );
    expect(result.ok).toBe(true);
    expect(result.waitAsk?.question).toBe("which one?");
    store.close();
  });
});

describe("send_message membership", () => {
  test("posting into a direct you are not in is not_a_member", async () => {
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const outsider = store.createBot({ name: "Analyst", duties: "count", boundaries: "stay" });
    const direct = store.createBotDirect(writer.bot.id, researcher.bot.id, null);
    const result = await runCollabTool(
      ctxFor(store, outsider.bot.id, outsider.direct_session.id),
      "send_message",
      { session_id: direct.id, body: "let me in" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("not_a_member");
    expect(store.listMainMessages(direct.id, 10)).toEqual([]);
    store.close();
  });
});
