import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor, type Harness } from "./test-kit/local-api-harness";
import { startApi, startFixture, textChunks, toolCallChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("file tools and workspace shell on the local API", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    while (workspaces.length) {
      const dir = workspaces.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createWriterIn(h: Harness, fixtureOrigin: string): Promise<{
    botId: string;
    sessionId: string;
    workspace: string;
  }> {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-file-")));
    workspaces.push(workspace);
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: workspace,
        endpoint_base_url: fixtureOrigin,
        endpoint_api_key: "sk-test",
        endpoint_models: ["test-model"],
        endpoint_default_model: "test-model",
      }),
    });
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
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
    return { botId: body.bot.id, sessionId: body.direct_session.id, workspace };
  }

  test("write_file inside the workspace lands the full text and the turn finishes with a bot message", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        const tools = body.tools as Array<{ function?: { name?: string } }>;
        expect(tools.some((t) => t.function?.name === "write_file")).toBe(true);
        expect(tools.some((t) => t.function?.name === "shell")).toBe(true);
        return sse(toolCallChunks("call_w", "write_file", '{"path":"report.md","content":"full report"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes('"ok":true'))).toBe(true);
      return sse(textChunks("wrote it"));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write the report" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("wrote it");
    expect(botMsg.attachments).toEqual([expect.objectContaining({ workspace_relpath: "report.md" })]);
    expect(readFileSync(join(workspace, "report.md"), "utf8")).toBe("full report");
    const route = h.store.getTurnRoute(String(botMsg.turn_id));
    expect(route).toMatchObject({
      outcome: "completed",
      hops: 2,
      tool_calls: 1,
      tool_errors: 0,
      repeated_failures: 0,
      files_written: 1,
    });
    sub.close();
  });

  test("read_file paths are inputs and do not become message attachments", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_r", "read_file", '{"path":"brief.md"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("brief text"))).toBe(true);
      return sse(textChunks("I reviewed the brief."));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    writeFileSync(join(workspace, "brief.md"), "brief text");
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "review the brief" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("I reviewed the brief.");
    expect(botMsg.attachments).toEqual([]);
    sub.close();
  });

  test("a silent write still posts attachments when the turn has no closer", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_w", "write_file", '{"path":"notes/a.md","content":"hi"}'));
      }
      return sse(textChunks(""));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write notes" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    expect(botMsg.body).toBe("");
    expect(botMsg.attachments).toEqual([expect.objectContaining({ workspace_relpath: "notes/a.md" })]);
    expect(readFileSync(join(workspace, "notes/a.md"), "utf8")).toBe("hi");
    sub.close();
  });

  test("a final reply that names a file from its shell's cwd links the path that resolves", async () => {
    let hop = 0;
    const fixture = await startFixture(() => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_sh", "shell", '{"command":"printf png > poster.png"}'));
      }
      return sse(textChunks("海报：[poster.png](poster.png)"));
    });
    const h = await startApi();
    const { botId, sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "make the poster" }),
    });
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === botId,
    );
    const workDir = h.store.turnWorkDir(String(botMsg.turn_id));
    expect(workDir).toBeTruthy();
    expect(readFileSync(join(workspace, `${workDir}/poster.png`), "utf8")).toBe("png");
    expect(botMsg.body).toBe(`海报：[${workDir}/poster.png](${workDir}/poster.png)`);
    expect(botMsg.attachments).toEqual([expect.objectContaining({ workspace_relpath: `${workDir}/poster.png` })]);
    sub.close();
  });

  test("write_file outside the workspace parks waiting_approval and does not write the file", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-out-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    const fixture = await startFixture(() =>
      sse(toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" }))),
    );
    const h = await startApi();
    const { sessionId, workspace } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const waiting = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "waiting_approval",
    );
    const card = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "approval",
    );
    expect(card.turn_id).toBe(waiting.id);
    const approvalEvent = await waitFor(sub.events, (e) => e.event === "approval.upsert");
    expect(approvalEvent.status).toBe("pending");
    expect(approvalEvent.kind_key).toBe("outside-write");
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(join(workspace, "secret.md"))).toBe(false);
    const pending = await fetch(`${h.origin}/v1/approvals?status=pending`, { headers: auth(h) });
    const listed = (await pending.json()) as { items: Array<{ kind_key: string; target: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.kind_key).toBe("outside-write");
    sub.close();
  });

  test("allow_once on an outside write then writes the file and finishes the turn", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-out-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" })),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes('"ok":true'))).toBe(true);
      return sse(textChunks("done outside"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "done outside",
    );
    expect(readFileSync(outsidePath, "utf8")).toBe("leak");
    sub.close();
  });

  test("a Bot's prompt edit waits on its card; once allowed, the next hop reads the new System text (ADR 0064)", async () => {
    let hop = 0;
    const systems: string[] = [];
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      const messages = body.messages as Array<{ role: string; content?: string }>;
      systems.push(String(messages.find((m) => m.role === "system")?.content ?? ""));
      if (hop === 1) {
        return sse(toolCallChunks("call_prompt", "edit_prompt", JSON.stringify({
          id: "turn.system",
          edits: [{ after: "说做过的必须真做过：", add: "附上你依据的命令输出。" }],
          reason: "用户要求每个 Bot 交付时附命令输出。",
        })));
      }
      return sse(textChunks("改好了"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, { method: "POST", headers: auth(h), body: JSON.stringify({ body: "让每个 Bot 交付时都附上命令输出" }) });
    const approvalEvent = await waitFor(sub.events, (e) => e.event === "approval.upsert" && e.status === "pending");
    expect(approvalEvent.kind_key).toBe("prompt-edit");
    // Never Always-allowed: every Bot reads this text.
    const always = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, { method: "POST", headers: auth(h), body: JSON.stringify({ action: "always_allow" }) });
    expect(always.status).toBe(422);
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, { method: "POST", headers: auth(h), body: JSON.stringify({ action: "allow_once" }) });
    expect(resolved.status).toBe(200);
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.body === "改好了");
    expect(systems[0]).not.toContain("说做过的必须真做过：附上你依据的命令输出。");
    expect(systems[1]).toContain("说做过的必须真做过：附上你依据的命令输出。");
    const head = h.store.promptHead("turn.system", "zh")!;
    expect(head).toMatchObject({ actor: "bot", approval_id: approvalEvent.id, message_id: approvalEvent.message_id, reason: "用户要求每个 Bot 交付时附命令输出。" });
    sub.close();
  });

  test("a jailed shell runs immediately and returns stdout", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_sh", "shell", '{"command":"echo hello"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"exit_code":0');
      expect(tool?.content).toContain("hello");
      return sse(textChunks("shelled"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "run echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "shelled",
    );
    expect(sub.events.some((e) => e.event === "approval.upsert")).toBe(false);
    sub.close();
  });

  test("a visible outside path in shell parks unconstrained-shell and does not run", async () => {
    const fixture = await startFixture(() =>
      sse(toolCallChunks("call_sh", "shell", '{"command":"cat /etc/passwd"}')),
    );
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "cat passwd" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "waiting_approval");
    const approvalEvent = await waitFor(sub.events, (e) => e.event === "approval.upsert");
    expect(approvalEvent.kind_key).toBe("unconstrained-shell");
    sub.close();
  });

  test("deny on an outside write returns denied and does not write the file", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-deny-")));
    workspaces.push(outsideDir);
    const outsidePath = join(outsideDir, "secret.md");
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_out", "write_file", JSON.stringify({ path: outsidePath, content: "leak" })),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"code":"denied"');
      return sse(textChunks("denied it"));
    });
    const h = await startApi();
    const { sessionId } = await createWriterIn(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "write outside" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "deny" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "denied it",
    );
    expect(existsSync(outsidePath)).toBe(false);
    sub.close();
  });
});
