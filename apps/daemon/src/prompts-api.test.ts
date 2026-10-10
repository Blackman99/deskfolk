import { expect, test } from "bun:test";
import type { PromptDetail, PromptSummary } from "@real-bot/protocol";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

test("the prompts API lists every built-in prompt, edits one, guards edits by the change you saw, and takes changes back", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
    method, headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const list = (await (await request("GET", "/prompts")).json()) as { items: PromptSummary[] };
    const system = list.items.find((item) => item.id === "turn.system")!;
    expect(system).toMatchObject({ group: "turn", title: { zh: "系统指令", en: "System instructions" } });
    expect(system.locales.map((l) => [l.locale, l.state])).toEqual([["zh", "default"], ["en", "default"]]);
    expect(list.items.find((item) => item.id === "call.organizer")!.locales).toEqual([
      { locale: "zh", state: "default", last_actor: null, last_bot_id: null, updated_at: null, parse_failures: { since_edit: null, last_7_days: 0 } },
    ]);
    // Each of the app's own calls says which built-in call it runs in; the others say none (ADR 0082).
    expect(list.items.find((item) => item.id === "call.seams_text")!.role).toBe("judge");
    expect("role" in system).toBe(false);
    expect(list.items.some((item) => item.id === "tool.send_message")).toBe(true);

    const before = (await (await request("GET", "/prompts/turn.memory/en")).json()) as PromptDetail;
    expect(before).toMatchObject({ id: "turn.memory", locale: "en", base_text: null, head_revision_id: null, format: null, revisions: [] });
    expect(before.text).toBe(before.default_text);

    const saved = await request("PUT", "/prompts/turn.memory/en", { text: "Notes you wrote.", if_revision: null, edit_session: "s" });
    expect(saved.status).toBe(200);
    const edited = (await saved.json()) as PromptDetail;
    expect(edited).toMatchObject({ text: "Notes you wrote.", base_text: before.default_text });
    expect(edited.locales.find((l) => l.locale === "en")!.state).toBe("edited");
    expect(edited.revisions).toHaveLength(1);
    expect(edited.revisions[0]).toMatchObject({ op: "edit", actor: "user", after_text: "Notes you wrote.", undoable: true });

    // A save from a page that has not seen that change is refused.
    expect((await request("PUT", "/prompts/turn.memory/en", { text: "Stale.", if_revision: null })).status).toBe(409);
    expect((await request("PUT", "/prompts/turn.memory/en", { text: "No guard." })).status).toBe(422);

    const broken = await request("PUT", "/prompts/call.scribe/zh", { text: "只记用户的话。", if_revision: null });
    expect(broken.status).toBe(422);
    expect(((await broken.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "prompt_placeholder_missing", message: "prompt_placeholder_missing:{format}" });
    expect((await request("GET", "/prompts/call.scribe/en")).status).toBe(422);
    expect((await request("GET", "/prompts/call.none/zh")).status).toBe(404);
    const scribe = (await (await request("GET", "/prompts/call.scribe/zh")).json()) as PromptDetail;
    expect(scribe.format).toStartWith("只输出一个 JSON 对象");
    expect(scribe.placeholders).toEqual([{ name: "format", meaning: expect.any(Object), required: "once" }]);

    const second = (await (await request("PUT", "/prompts/turn.memory/en", { text: "Second.", if_revision: edited.head_revision_id })).json()) as PromptDetail;
    const firstId = edited.head_revision_id!;
    expect((await request("POST", `/prompt-revisions/${firstId}/undo`)).status).toBe(409);
    const undone = (await (await request("POST", `/prompt-revisions/${second.head_revision_id}/undo`)).json()) as PromptDetail;
    expect(undone.text).toBe("Notes you wrote.");
    const reset = (await (await request("POST", "/prompts/turn.memory/en/reset", { if_revision: undone.head_revision_id })).json()) as PromptDetail;
    expect(reset.text).toBe(reset.default_text);
    expect(reset.locales.find((l) => l.locale === "en")!.state).toBe("default");
    const restored = (await (await request("POST", `/prompt-revisions/${firstId}/restore`)).json()) as PromptDetail;
    expect(restored.text).toBe("Notes you wrote.");
    expect((await request("POST", "/prompts/turn.memory/en/keep-mine", { if_revision: restored.head_revision_id })).status).toBe(422);
    expect(((await (await request("GET", "/prompt-revisions?approval_id=none")).json()) as { items: unknown[] }).items).toEqual([]);
  } finally {
    await api.engine.close();
    server.stop(true);
    store.close();
  }
});
