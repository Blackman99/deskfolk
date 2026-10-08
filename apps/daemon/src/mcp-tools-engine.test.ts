import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWriter, fixtures, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor, type Harness } from "./test-kit/local-api-harness";
import { startApi, startFixture, textChunks, toolCallChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("MCP stdio tools on the local API", () => {
  const fixturePath = join(import.meta.dir, "mcp-fixture.ts");

  async function enableProbe(
    h: Harness,
    flag?: string,
  ): Promise<void> {
    const created = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "probe",
        command: process.execPath,
        args: flag ? [fixturePath, flag] : [fixturePath],
        enabled: true,
      }),
    });
    expect(created.status).toBe(201);
    if (!flag) {
      const body = (await created.json()) as { id: string };
      for (let attempt = 0; attempt < 100; attempt++) {
        const server = h.store.listMcpServers().find((row) => row.id === body.id)!;
        if (server.instructions) break;
        await Bun.sleep(10);
      }
      const server = h.store.listMcpServers().find((row) => row.id === body.id)!;
      expect(server.instructions).toContain("Echo text");
      expect(server.tool_catalog.map((t) => t.name)).toEqual(["echo", "boom", "pid"]);
    }
  }

  test("an enabled fixture server is listed and echo comes back as { ok: true, data }", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        const tools = body.tools as Array<{ function?: { name?: string } }>;
        expect(tools.some((t) => t.function?.name === "mcp_probe_echo")).toBe(true);
        expect(tools.some((t) => t.function?.name === "send_message")).toBe(true);
        return sse(toolCallChunks("call_mcp", "mcp_probe_echo", '{"text":"ping"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":true');
      expect(tool?.content).toContain("ping");
      expect(tool?.content).not.toContain('"ok":false');
      return sse(textChunks("echoed"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "use echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "echoed" && e.author === botId,
      4000,
    );
    sub.close();
  });

  test("MCP isError stays ok true with the original payload", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_boom", "mcp_probe_boom", "{}"));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":true');
      expect(tool?.content).toContain('"isError":true');
      expect(tool?.content).toContain("boom");
      return sse(textChunks("saw error"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "boom" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "saw error",
      4000,
    );
    sub.close();
  });

  test("a dead MCP child is failed, not ok", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(toolCallChunks("call_dead", "mcp_probe_echo", '{"text":"x"}'));
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      expect(tool?.content).toContain('"ok":false');
      expect(tool?.content).toContain('"code":"failed"');
      return sse(textChunks("host died"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h, "--crash-on-call");
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "echo" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "host died",
      4000,
    );
    sub.close();
  });

  test("a disabled MCP server is not listed on the turn", async () => {
    const fixture = await startFixture(({ body }) => {
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name?.startsWith("mcp_"))).toBe(false);
      return sse(textChunks("no mcp"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "probe",
        command: process.execPath,
        args: [fixturePath],
        enabled: false,
      }),
    });
    expect(created.status).toBe(201);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "hi" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "no mcp",
    );
    sub.close();
  });

  test("add_mcp_server parks, then the next hop lists the new tools", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_add",
            "add_mcp_server",
            JSON.stringify({
              name: "probe",
              command: process.execPath,
              args: [fixturePath],
            }),
          ),
        );
      }
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name === "mcp_probe_echo")).toBe(true);
      return sse(textChunks("mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add probe" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "mcp ready",
      4000,
    );
    expect(h.store.listMcpServers().map((s) => s.name)).toEqual(["probe"]);
    expect(h.store.listMcpServers()[0]?.instructions).toContain("Echo text");
    sub.close();
  });

  test("HTTP add_mcp_server parks a card that collects Authorization; empty allow_once stays pending", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_http_mcp",
            "add_mcp_server",
            JSON.stringify({
              name: "cpa",
              url: "https://cpa.example/mcp",
            }),
          ),
        );
      }
      return sse(textChunks("http mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add cpa mcp" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    expect(approvalEvent.target).toBe("https://cpa.example/mcp");
    expect(approvalEvent.requires_api_key).toBe(true);
    const missing = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(missing.status).toBe(422);
    expect(h.store.listMcpServers()).toHaveLength(0);
    const stillPending = await fetch(`${h.origin}/v1/approvals?status=pending`, { headers: auth(h) });
    const pendingBody = (await stillPending.json()) as { items: Array<{ id: string; requires_api_key: boolean }> };
    expect(pendingBody.items).toHaveLength(1);
    expect(pendingBody.items[0]?.requires_api_key).toBe(true);
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once", api_key: "Bearer secret-token" }),
    });
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(await resolved.json())).not.toContain("secret-token");
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "http mcp ready",
    );
    const servers = h.store.listMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("cpa");
    expect(servers[0]?.transport).toBe("http");
    expect(servers[0]?.auth_set).toBe(true);
    expect(await h.store.mcpAuth(servers[0]!.id)).toBe("Bearer secret-token");
    sub.close();
  });

  test("a just-added MCP stays on this turn even when the trigger does not match it", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_add",
            "add_mcp_server",
            JSON.stringify({
              name: "github",
              command: process.execPath,
              args: [fixturePath, "--github"],
            }),
          ),
        );
      }
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      expect(tools.some((t) => t.function?.name === "mcp_github_get_issue")).toBe(true);
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("GitHub issues");
      expect(system).toContain("mcp_github_get_issue");
      return sse(textChunks("mcp ready"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add this MCP so I can search the weather" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("mcp-add");
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(resolved.status).toBe(200);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "mcp ready",
      4000,
    );
    sub.close();
  });

  test.each(["stdio", "http"] as const)("Bot-added image and video tools are globally available on later turns (%s)", async (transport) => {
    let url: string | undefined;
    if (transport === "http") {
      const proc = Bun.spawn([process.execPath, fixturePath, "--http", "--http-legacy-sse", "--media"], {
        stdout: "pipe", stderr: "ignore", env: { ...process.env, MCP_HTTP_AUTH: "local-fixture" },
      });
      fixtures.push({ close: async () => { proc.kill(); await proc.exited; } });
      const reader = proc.stdout.getReader();
      try {
        let line = "";
        while (!line.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("HTTP MCP fixture exited before listening");
          line += new TextDecoder().decode(chunk.value);
        }
        url = `http://127.0.0.1:${JSON.parse(line.split("\n")[0]!).port}/mcp`;
      } finally {
        reader.releaseLock();
      }
    }
    const requests: Record<string, unknown>[] = [];
    const fixture = await startFixture(({ body }) => {
      requests.push(body);
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const results = messages.filter((message) => message.role === "tool");
      if (results.length > 0) {
        const last = results.at(-1)!.content!;
        if (last.includes("fixture-video") && last.includes("pending")) {
          const tools = body.tools as Array<{ function: { name: string } }>;
          if (!tools.some((tool) => tool.function.name === "mcp_studio_check_video")) return sse(textChunks("MCP tool missing"));
          return sse(toolCallChunks("check", "mcp_studio_check_video", JSON.stringify({ job_id: "fixture-video" })));
        }
        return sse(textChunks(last));
      }
      const trigger = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      if (trigger.includes("安装")) {
        return sse(toolCallChunks("install", "add_mcp_server", JSON.stringify({
          name: "studio",
          ...(url ? { url } : { command: process.execPath, args: [fixturePath, "--media"] }),
        })));
      }
      const name = trigger.includes("视频") ? "mcp_studio_submit_video" : "mcp_studio_generate_image";
      const tools = body.tools as Array<{ function: { name: string } }>;
      if (!tools.some((tool) => tool.function.name === name)) return sse(textChunks("MCP tool missing"));
      return sse(toolCallChunks("generate", name, JSON.stringify({ prompt: "a sunset" })));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const other = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Designer", duties: "create media", boundaries: "stay" }),
    });
    expect(other.status).toBe(201);
    const { bot: otherBot, direct_session: otherSession } = await other.json() as {
      bot: { id: string };
      direct_session: { id: string };
    };
    const group = h.store.createGroup({ name: "Media", members: [botId, otherBot.id] });
    const sub = await subscribe(h);
    try {
      await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth(h), body: JSON.stringify({ body: "安装创作服务" }),
      });
      const approval = await waitFor(sub.events, (event) => event.event === "approval.upsert" && event.status === "pending");
      const resolved = await fetch(`${h.origin}/v1/approvals/${approval.id}/resolve`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ action: "allow_once", ...(url ? { api_key: "local-fixture" } : {}) }),
      });
      expect(resolved.status).toBe(200);
      await waitFor(sub.events, (event) => event.event === "message.created" && event.kind === "bot", 4000);
      expect(h.store.listMcpServers()[0]?.tool_catalog.map((tool) => tool.name)).toEqual(["generate_image", "submit_video", "check_video"]);

      for (const [session, prompt, result] of [
        [sessionId, "帮我生成一张日落图片", "generate_image: a sunset"],
        [otherSession.id, "帮我生成日落视频", "completed"],
        [sessionId, "再来一张", "generate_image: a sunset"],
        [group.id, "@Designer 帮我生成日落视频", "completed"],
      ] as const) {
        const start = sub.events.length;
        const requestStart = requests.length;
        await fetch(`${h.origin}/v1/sessions/${session}/messages`, {
          method: "POST", headers: auth(h), body: JSON.stringify({ body: prompt }),
        });
        const message = await waitFor(sub.events, (event) =>
          sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
          4000,
        );
        expect(message.body).toContain('"ok":true');
        expect(message.body).toContain(result);
        const tools = requests[requestStart]!.tools as Array<{ function: { name: string } }>;
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_generate_image");
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_submit_video");
        expect(tools.map((tool) => tool.function.name)).toContain("mcp_studio_check_video");
        const system = (requests[requestStart]!.messages as Array<{ role: string; content: string }>).find((message) => message.role === "system")!.content;
        expect(system).toContain("Create images and videos");
      }
      const routineResponse = await fetch(`${h.origin}/v1/routines`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({
          bot_id: otherBot.id,
          title: "每日图片",
          instruction: "帮我生成一张日落图片",
          schedule: { kind: "daily", time: "09:00" },
          enabled: false,
        }),
      });
      expect(routineResponse.status).toBe(201);
      const routine = await routineResponse.json() as { id: string };
      h.store.db.run("UPDATE routines SET created_at = ?, enabled = 1 WHERE id = ?", [
        new Date(2026, 8, 10, 8).toISOString(), routine.id,
      ]);
      const opened = h.engine.fireRoutine(routine.id, new Date(2026, 8, 14, 9));
      expect(opened).not.toBeNull();
      const routineMessage = await waitFor(sub.events, (event) =>
        event.event === "message.created" && event.kind === "bot" && event.turn_id === opened!.id,
        4000,
      );
      expect(routineMessage.body).toContain("generate_image: a sunset");

      const server = h.store.listMcpServers()[0]!;
      for (const enabled of [false, true]) {
        const changed = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
          method: "PATCH", headers: auth(h), body: JSON.stringify({ enabled }),
        });
        expect(changed.status).toBe(200);
        const start = sub.events.length;
        await fetch(`${h.origin}/v1/sessions/${otherSession.id}/messages`, {
          method: "POST", headers: auth(h), body: JSON.stringify({ body: "再来一张" }),
        });
        const message = await waitFor(sub.events, (event) =>
          sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
          4000,
        );
        expect(message.body).toContain(enabled ? "generate_image: a sunset" : "MCP tool missing");
      }
      const deleted = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
        method: "DELETE", headers: auth(h),
      });
      expect(deleted.status).toBe(204);
      const start = sub.events.length;
      await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth(h), body: JSON.stringify({ body: "帮我生成日落视频" }),
      });
      const afterDelete = await waitFor(sub.events, (event) =>
        sub.events.indexOf(event) >= start && event.event === "message.created" && event.kind === "bot",
        4000,
      );
      expect(afterDelete.body).toBe("MCP tool missing");
      expect(sub.events.filter((event) => event.event === "approval.upsert" && event.status === "pending")).toHaveLength(1);
    } finally {
      sub.close();
    }
  });

  test("every turn lists all enabled MCP tools regardless of task keywords", async () => {
    const fixture = await startFixture(({ body }) => {
      const tools = body.tools as Array<{ function?: { name?: string } }>;
      const names = tools.map((t) => t.function?.name);
      expect(names).toContain("mcp_github_get_issue");
      expect(names).toContain("mcp_probe_echo");
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("GitHub issues");
      expect(system).toContain("Echo text");
      return sse(textChunks("issue read"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    await enableProbe(h);
    const github = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "github",
        command: process.execPath,
        args: [fixturePath, "--github"],
        enabled: true,
      }),
    });
    expect(github.status).toBe(201);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "read GitHub issue 12" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "issue read",
      4000,
    );
    sub.close();
  });
});

describe("bot catalog tools on the local API", () => {
  test("add_endpoint parks until allow_once with an api_key", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks(
            "call_ep",
            "add_endpoint",
            JSON.stringify({
              name: "DeepSeek",
              base_url: "https://api.deepseek.com/v1",
              models: ["deepseek-chat"],
            }),
          ),
        );
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("DeepSeek"))).toBe(
        true,
      );
      return sse(textChunks("endpoint added"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const before = (await h.store.listProviders()).length;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "add deepseek" }),
    });
    const approvalEvent = await waitFor(
      sub.events,
      (e) => e.event === "approval.upsert" && e.status === "pending",
    );
    expect(approvalEvent.kind_key).toBe("endpoint-add");
    const missing = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once" }),
    });
    expect(missing.status).toBe(422);
    expect((await h.store.listProviders()).length).toBe(before);
    const resolved = await fetch(`${h.origin}/v1/approvals/${approvalEvent.id}/resolve`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ action: "allow_once", api_key: "sk-deepseek" }),
    });
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(await resolved.json())).not.toContain("sk-deepseek");
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "endpoint added",
    );
    const listed = await h.store.listProviders();
    expect(listed.length).toBe(before + 1);
    expect(listed.some((p) => p.name === "DeepSeek" && p.key_set)).toBe(true);
    sub.close();
  });
});
