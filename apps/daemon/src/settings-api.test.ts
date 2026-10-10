import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("empty roster and settings", () => {
  test("patching theme to dark or light succeeds, invalid theme is 422", async () => {
    const h = await start();
    const patchDark = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(patchDark.status).toBe(200);
    const bodyDark = (await patchDark.json()) as { theme: string };
    expect(bodyDark.theme).toBe("dark");

    const patchBad = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ theme: "neon" }),
    });
    expect(patchBad.status).toBe(422);
    const err = (await patchBad.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("invalid_args");
    expect(err.error.message).toContain("theme must be system, light, or dark");
  });

  test("settings never echo the key; endpoint_key_set flips after PATCH", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    const patched = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        workspace_path: workspace,
        endpoint_base_url: "https://api.example/v1",
        endpoint_api_key: "sk-secret",
      }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      endpoint_key_set: boolean;
      wizard_complete: boolean;
      workspace_path: string;
    };
    expect(body.endpoint_key_set).toBe(true);
    expect(body.wizard_complete).toBe(true);
    expect(body.workspace_path).toBe(realpathSync(workspace));
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("keychain:");
    rmSync(workspace, { recursive: true, force: true });
  });

  /** ADR 0078: set up on Claude Code alone, with no endpoint at all. */
  test("with no endpoint, setup is complete once every built-in call but compaction is on a Claude model", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    const patch = async (body: unknown) => {
      const res = await fetch(`${h.origin}/v1/settings`, {
        method: "PATCH",
        headers: auth(h, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { wizard_complete: boolean }).wizard_complete;
    };
    expect(await patch({ workspace_path: workspace })).toBe(false);
    const sonnet = { runner: "claude_code", model: "sonnet", config_dir: null };
    const roles = ["reader", "organizer", "scribe", "judge", "composer", "judgement", "reflection", "retrospective"];
    expect(await patch({ builtin_models: Object.fromEntries(roles.slice(1).map((role) => [role, sonnet])) })).toBe(false);
    expect(await patch({ builtin_models: { reader: { ...sonnet, model: "haiku" } } })).toBe(true);
    // A call put back on the default model has no endpoint to fall back on, so setup opens again.
    expect(await patch({ builtin_models: { judgement: null } })).toBe(false);
    rmSync(workspace, { recursive: true, force: true });
  });

  /** ADR 0078: with no endpoint, a Bot made without saying what runs it is a Claude Agent. */
  test("set up on Claude Code alone, a new Bot is a Claude Agent unless asked otherwise; with an endpoint, on the app", async () => {
    const h = await start();
    const workspace = mkdtempSync(join(tmpdir(), "real-bot-ws-"));
    const send = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { bot: { runner: string | null; agent_config_dir: string | null } } };
    };
    const bot = (name: string, extra: object = {}) => send("POST", "/v1/bots", { name, duties: "d", boundaries: "b", ...extra });
    // Not set up on Claude Code: a Bot asking for nothing is the app's, as before.
    expect((await bot("Before")).body.bot.runner).toBeNull();
    const haiku = { runner: "claude_code", model: "haiku", config_dir: null };
    const roles = ["reader", "organizer", "scribe", "judge", "composer", "judgement", "reflection", "retrospective"];
    await send("PATCH", "/v1/settings", { workspace_path: workspace, builtin_models: Object.fromEntries(roles.map((role) => [role, haiku])) });
    expect((await bot("Hired")).body.bot).toMatchObject({ runner: "claude_code", agent_config_dir: null });
    // Asked for the app's runner, it gets it.
    expect((await bot("Asked", { runner: null })).body.bot.runner).toBeNull();
    // With an endpoint to run on, nothing is put on Claude Code by itself.
    await send("PATCH", "/v1/settings", { endpoint_base_url: "https://api.example/v1", endpoint_api_key: "sk-x" });
    expect((await bot("After")).body.bot.runner).toBeNull();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("workspace tree and file are read-only inside the jail", async () => {
    const h = await start();
    const unset = await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) });
    expect(unset.status).toBe(422);

    const ws = mkdtempSync(join(tmpdir(), "real-bot-ws-tree-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "brief.md"), "# brief\n");
    writeFileSync(join(ws, "src", "app.ts"), "export {}\n");
    writeFileSync(join(ws, ".hidden"), "nope");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const treeRes = await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) });
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as {
      path: string;
      truncated: boolean;
      items: Array<{ name: string; path: string; kind: string }>;
    };
    expect(tree.path).toBe(".");
    expect(tree.items.map((row) => row.path)).toEqual(["src", "brief.md"]);

    const nested = await fetch(`${h.origin}/v1/workspace/tree?path=${encodeURIComponent("src")}`, {
      headers: auth(h),
    });
    expect((await nested.json() as { items: Array<{ path: string }> }).items.map((row) => row.path)).toEqual([
      "src/app.ts",
    ]);

    const fileRes = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("brief.md")}`, {
      headers: auth(h),
    });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("Content-Length")).toBe(String(Buffer.byteLength("# brief\n")));
    expect(await fileRes.text()).toBe("# brief\n");

    writeFileSync(join(ws, "clip.mp4"), Buffer.alloc(1_000_001, 7));
    const bigRes = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("clip.mp4")}`, {
      headers: auth(h),
    });
    expect(bigRes.status).toBe(200);
    expect((await bigRes.arrayBuffer()).byteLength).toBe(1_000_001);

    const escapeRes = await fetch(`${h.origin}/v1/workspace/tree?path=${encodeURIComponent("../")}`, {
      headers: auth(h),
    });
    expect(escapeRes.status).toBe(422);

    const dirFile = await fetch(`${h.origin}/v1/workspace/file?path=${encodeURIComponent("src")}`, {
      headers: auth(h),
    });
    expect(dirFile.status).toBe(422);

    const put = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "brief.md", content: "# saved\n" }),
    });
    expect(put.status).toBe(204);
    expect(readFileSync(join(ws, "brief.md"), "utf8")).toBe("# saved\n");

    const putMissing = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "nope.md", content: "x" }),
    });
    expect(putMissing.status).toBe(404);

    const putOutside = await fetch(`${h.origin}/v1/workspace/file`, {
      method: "PUT",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "../secret", content: "x" }),
    });
    expect(putOutside.status).toBe(422);

    rmSync(ws, { recursive: true, force: true });
  });

  test("workspace files and folders move to the Trash, and nothing outside the workspace does", async () => {
    const asked: string[][] = [];
    const h = await start({ trash: async (abs) => {
      asked.push(abs);
      for (const path of abs) rmSync(path, { recursive: true });
      return abs.map(() => "");
    } });
    const trash = (paths: unknown) => fetch(`${h.origin}/v1/workspace/trash`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ paths }),
    });
    expect((await trash(["brief.md"])).status).toBe(422);

    const ws = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-ws-trash-")));
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "app.ts"), "export {}\n");
    writeFileSync(join(ws, "brief.md"), "# brief\n");
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: ws }),
    });

    const receipts = () => h.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM request_receipts").get()!.n;
    const before = receipts();
    const moved = await trash(["src/app.ts", "src", "brief.md"]);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ trashed: ["src", "brief.md"], failed: [] });
    expect(asked).toEqual([[join(ws, "src"), join(ws, "brief.md")]]);
    expect(((await (await fetch(`${h.origin}/v1/workspace/tree`, { headers: auth(h) })).json()) as { items: unknown[] }).items).toEqual([]);
    // Asked again after a lost answer: already gone, so the same answer and nothing handed over.
    expect(await (await trash(["src", "brief.md"])).json()).toEqual({ trashed: ["src", "brief.md"], failed: [] });
    expect(asked).toHaveLength(1);
    // No receipt, so a second request is never refused as a replay of the first.
    expect(receipts()).toBe(before);

    for (const paths of [[], ["."], ["../secret"], "brief.md"]) expect((await trash(paths)).status).toBe(422);
    expect(asked).toHaveLength(1);
    rmSync(ws, { recursive: true, force: true });
  });

  test("illegal locale is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ locale: "zh-Hans" }),
    });
    expect(res.status).toBe(422);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("invalid_args");
  });

  test("blank workspace path is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: "   " }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path cannot be empty" },
    });
  });

  test("relative workspace path is 422 and does not write", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: "relative/ws" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path must be an absolute directory" },
    });
    const settings = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as {
      workspace_path: string | null;
    };
    expect(settings.workspace_path).toBeNull();
  });

  test("missing workspace directory is created", async () => {
    const h = await start();
    const dir = join(tmpdir(), `real-bot-missing-${process.pid}-${Date.now()}`);
    const nested = join(dir, "workspace");
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: nested }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(realpathSync(nested));
    expect(statSync(nested).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("file used as workspace path is 422", async () => {
    const h = await start();
    const dir = mkdtempSync(join(tmpdir(), "real-bot-file-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: file }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "workspace_path must be a directory" },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing tilde workspace path is created", async () => {
    const h = await start();
    const home = process.env.HOME!;
    const name = `real-bot-tilde-missing-${process.pid}-${Date.now()}`;
    const real = join(home, name);
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: `~/${name}` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(realpathSync(real));
    expect(statSync(real).isDirectory()).toBe(true);
    rmSync(real, { recursive: true, force: true });
  });

  test("tilde workspace path expands, realpath-resolves, and stores the absolute directory", async () => {
    const h = await start();
    const home = process.env.HOME!;
    const name = `real-bot-tilde-${process.pid}`;
    const real = join(home, name);
    const link = join(home, `${name}-link`);
    mkdirSync(real);
    symlinkSync(real, link);
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ workspace_path: `~/${name}-link` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_path: string };
    expect(body.workspace_path).toBe(real);
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  });

  test("non-http endpoint URL is 422 and does not write", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "ftp://api.example/v1" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_base_url must be an http or https URL" },
    });
    const settings = (await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()) as {
      endpoint_base_url: string | null;
    };
    expect(settings.endpoint_base_url).toBeNull();
  });

  test("blank endpoint URL is 422", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "   " }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_base_url cannot be empty" },
    });
  });

  test("http endpoint URL is stored after URL normalization", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_base_url: "HTTP://API.EXAMPLE/v1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint_base_url: string };
    expect(body.endpoint_base_url).toBe("http://api.example/v1");
  });

  test("endpoint models trim, drop duplicates, and pick the first as default when omitted", async () => {
    const h = await start();
    const res = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: [" grok-4.5 ", "deepseek-v4-pro", "grok-4.5"],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
      endpoint_default_model: "grok-4.5",
    });
  });

  test("default model must be in the list; unknown bot model is 422", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const badDefault = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_default_model: "nope" }),
    });
    expect(badDefault.status).toBe(422);
    expect(await badDefault.json()).toEqual({
      error: { code: "invalid_args", message: "endpoint_default_model must be one of endpoint_models" },
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "nope",
      }),
    });
    expect(created.status).toBe(422);
    expect(await created.json()).toEqual({
      error: { code: "invalid_args", message: "model must be one of endpoint_models" },
    });
    const ok = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { bot: { model: string | null } };
    expect(body.bot.model).toBe("deepseek-v4-pro");
  });

  test("a bot thinking_level pin is validated against the pinned model and round-trips through PATCH", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: [
          { name: "grok-4.5", thinking_levels: ["low", "high"] },
          { name: "deepseek-v4-pro", thinking_levels: ["none"] },
        ],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const badLevel = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay", thinking_level: "high!" }),
    });
    expect(badLevel.status).toBe(422);
    expect(await badLevel.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level must be a reasoning_effort name" },
    });
    const unsupported = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
        thinking_level: "high",
      }),
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level must be one the pinned model supports" },
    });
    const orphanLevel = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay", thinking_level: "high" }),
    });
    expect(orphanLevel.status).toBe(422);
    expect(await orphanLevel.json()).toEqual({
      error: { code: "invalid_args", message: "thinking_level needs a pinned model" },
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "grok-4.5",
        thinking_level: "high",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { bot: { id: string; thinking_level: string | null } };
    expect(body.bot.thinking_level).toBe("high");

    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const patched = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ model: "grok-4.5", thinking_level: "low" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ model: "grok-4.5", thinking_level: "low" });
    // A pinned model always carries a level: clearing it falls back to that model's default.
    const cleared = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ thinking_level: null }),
    });
    expect(await cleared.json()).toMatchObject({ model: "grok-4.5", thinking_level: "low" });
    // Unpinning the model unpins the level with it: automatic is both or neither.
    const unpinned = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ model: null }),
    });
    expect(await unpinned.json()).toMatchObject({ model: null, thinking_level: null });
    const orphanPatch = await fetch(`${h.origin}/v1/bots/${body.bot.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ thinking_level: "high" }),
    });
    expect(orphanPatch.status).toBe(422);
    await Bun.sleep(20);
    expect(
      events.some((e) => e.event === "bot.upsert" && e.id === body.bot.id && e.thinking_level === "low"),
    ).toBe(true);
    ws.close();
  });

  test("dropping a model from the list clears bots that used it", async () => {
    const h = await start();
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
        endpoint_default_model: "grok-4.5",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      }),
    });
    const bot = (await created.json()) as { bot: { id: string } };
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ endpoint_models: ["grok-4.5"] }),
    });
    const row = await fetch(`${h.origin}/v1/bots/${bot.bot.id}`, { headers: auth(h) });
    expect(await row.json()).toMatchObject({ id: bot.bot.id, model: null });
    expect(events.some((e) => e.event === "bot.upsert" && e.id === bot.bot.id && e.model === null)).toBe(
      true,
    );
    ws.close();
    const settings = await fetch(`${h.origin}/v1/settings`, { headers: auth(h) });
    expect(await settings.json()).toMatchObject({
      endpoint_models: ["grok-4.5"],
      endpoint_default_model: "grok-4.5",
    });
  });
  test("the organizing model is an endpoint's listed model, kept as chosen, and reads as null once its endpoint is gone or no longer lists it", async () => {
    const h = await start();
    const patch = (body: unknown) =>
      fetch(`${h.origin}/v1/settings`, { method: "PATCH", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    const strong = await h.store.createProvider({ name: "Strong", base_url: "https://strong.example/v1", api_key: "sk-strong", models: ["big", "bigger"] });
    expect(await (await fetch(`${h.origin}/v1/settings`, { headers: auth(h) })).json()).toMatchObject({ organizer_model: null });

    const set = await patch({ organizer_model: { provider_id: strong.id, model: "big" } });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ organizer_model: { provider_id: strong.id, model: "big" } });
    expect((await h.store.settings()).organizer_model).toEqual({ provider_id: strong.id, model: "big" });
    // The reader's setting is its own.
    expect((await h.store.settings()).reader_model).toBeNull();

    // An endpoint nobody has is 404, a model it does not list or a shape that is not one is 422.
    expect((await patch({ organizer_model: { provider_id: "prov_missing", model: "big" } })).status).toBe(404);
    const unlisted = await patch({ organizer_model: { provider_id: strong.id, model: "elsewhere" } });
    expect(unlisted.status).toBe(422);
    expect(((await unlisted.json()) as { error: { message: string } }).error.message).toContain("organizer_model");
    expect((await patch({ organizer_model: { provider_id: strong.id } })).status).toBe(422);
    expect((await patch({ organizer_model: "big" })).status).toBe(422);
    // A Claude model of yours reads lines (ADR 0061); it does not organize.
    const claude = await patch({ organizer_model: { runner: "claude_code", model: "opus", config_dir: null } });
    expect(claude.status).toBe(422);
    expect(((await claude.json()) as { error: { message: string } }).error.message).toContain("organizer_model");
    // Every refusal left the choice as it was.
    expect((await h.store.settings()).organizer_model).toEqual({ provider_id: strong.id, model: "big" });

    // The endpoint stops listing the model: the choice reads as none, and the default model organizes.
    await h.store.patchProvider(strong.id, { models: ["bigger"], default_model: "bigger" });
    expect((await h.store.settings()).organizer_model).toBeNull();
    // Listed again, it is the choice again: it was kept as chosen.
    await h.store.patchProvider(strong.id, { models: ["big", "bigger"], default_model: "bigger" });
    expect((await h.store.settings()).organizer_model).toEqual({ provider_id: strong.id, model: "big" });

    // Gone with its endpoint.
    const spare = await h.store.createProvider({ name: "Spare", base_url: "https://spare.example/v1", api_key: "sk-spare", models: ["spare-1"] });
    await patch({ default_provider_id: spare.id });
    await h.store.deleteProvider(strong.id);
    expect((await h.store.settings()).organizer_model).toBeNull();

    // Null follows the default again, and clears what was kept.
    const again = await patch({ organizer_model: { provider_id: spare.id, model: "spare-1" } });
    expect(await again.json()).toMatchObject({ organizer_model: { provider_id: spare.id, model: "spare-1" } });
    const cleared = await patch({ organizer_model: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ organizer_model: null });
    const stored = (key: string) => h.store.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value;
    expect([stored("organizer_provider_id"), stored("organizer_model")]).toEqual(["", ""]);
  });
});
