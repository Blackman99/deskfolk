import { afterEach, expect, test } from "bun:test";
import { runCollabTool, type ToolCtx } from "./collab-tools";
import { HttpError } from "./errors";
import { savePromptText } from "./prompts/book";
import { applyPromptEdits, PROMPT_EDIT_KIND } from "./prompt-tools";
import { Store } from "./store";
import { codePointCount } from "./text";

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function setup(locale: "zh" | "en" = "en") {
  const store = new Store();
  stores.push(store);
  store.patchSettingsSync({ locale });
  const { bot, direct_session } = store.createBot({ name: "Tuner", duties: "tune prompts", boundaries: "ask first" });
  const line = store.postMessage(direct_session.id, { body: "make every Bot attach its command output" });
  const turn = store.createTurn({ sessionId: direct_session.id, botId: bot.id, triggerMessageId: line.id });
  const ctx: ToolCtx = { store, botId: bot.id, sessionId: direct_session.id, turnId: turn.id, parentId: null };
  return { store, bot, session: direct_session.id, turn, ctx };
}

test("edits are exact: a passage must be there once, and edits that change nothing are refused", () => {
  expect(applyPromptEdits("a b c", [{ old: "b", new: "B" }])).toEqual({ ok: true, text: "a B c" });
  expect(applyPromptEdits("a b c", [{ after: "a", add: " x" }])).toEqual({ ok: true, text: "a x b c" });
  expect(applyPromptEdits("a b c  \n", [{ add: "Tail." }])).toEqual({ ok: true, text: "a b c\n\nTail." });
  expect(applyPromptEdits("a b c", [{ old: "z", new: "Z" }])).toMatchObject({ ok: false, code: "edit_missing" });
  expect(applyPromptEdits("a a", [{ old: "a", new: "b" }])).toMatchObject({ ok: false, code: "edit_repeated" });
  expect(applyPromptEdits("a", [{ old: "", new: "b" }])).toMatchObject({ ok: false, code: "edit_empty" });
  expect(applyPromptEdits("a", [{ old: "a", new: "a" }])).toMatchObject({ ok: false, code: "no_change" });
});

test("list and read are free; read shows the editable part, the fixed format and the placeholders", async () => {
  const { ctx } = setup();
  const listed = await runCollabTool(ctx, "list_prompts", {});
  expect(listed.ok).toBe(true);
  const ids = (listed.data!.prompts as Array<{ id: string }>).map((row) => row.id);
  expect(ids).toContain("turn.system");
  expect(ids).toContain("call.organizer");
  expect(ids.some((id) => id.startsWith("tool."))).toBe(false);
  expect(listed.data!.tool_descriptions).toMatchObject({ edited: [] });
  const tools = await runCollabTool(ctx, "list_prompts", { group: "tool" });
  expect((tools.data!.prompts as Array<{ id: string }>).every((row) => row.id.startsWith("tool."))).toBe(true);
  const read = await runCollabTool(ctx, "read_prompt", { id: "call.scribe" });
  expect(read.data).toMatchObject({ id: "call.scribe", locale: "zh", state: "default", placeholders: [{ name: "{format}", keep: "exactly once" }] });
  expect(String(read.data!.text)).toEndWith("{format}");
  expect(String(read.data!.fixed_format)).toStartWith("只输出一个 JSON 对象");
  expect((await runCollabTool(ctx, "read_prompt", { id: "nope" })).error?.code).toBe("not_found");
});

test("an edit waits for your approval card, never Always-allowed, and records who, why and through which card", async () => {
  const { store, bot, turn, ctx } = setup();
  const edits = [{ after: "Claim only what you ran:", add: " Paste the command output you relied on." }];
  const proposed = await runCollabTool(ctx, "edit_prompt", { id: "turn.system", edits, reason: "Three hand-overs last week claimed tests passed with no output." });
  expect(proposed.ok).toBe(false);
  const card = proposed.waitApproval!;
  expect(card).toMatchObject({ kind_key: PROMPT_EDIT_KIND, target: "turn.system:en" });
  expect(card.summary).toStartWith("Change a built-in prompt: System instructions · English\nReason: Three hand-overs");
  expect(card.summary).toContain("@@ Change 1 · add after “Claim only what you ran:”\n+  Paste the command output you relied on.");
  expect(store.promptOverride("turn.system", "en")).toBeNull();

  // The card itself: Always allow is refused for this kind.
  const approval = store.insertApproval({ turnId: turn.id, messageId: null, kind_key: card.kind_key, summary: card.summary, target: card.target });
  expect(() => store.resolveApproval(approval.id, "always_allow", "*")).toThrow(HttpError);

  const done = await card.run({ approval_id: approval.id, message_id: "01J00000000000000000000000" });
  expect(done).toMatchObject({ ok: true, data: { id: "turn.system", locale: "en", state: "edited" } });
  expect(store.promptOverride("turn.system", "en")!.text).toContain("Claim only what you ran: Paste the command output you relied on.");
  expect(store.promptHead("turn.system", "en")).toMatchObject({
    op: "edit", actor: "bot", bot_id: bot.id, turn_id: turn.id, approval_id: approval.id,
    message_id: "01J00000000000000000000000", reason: "Three hand-overs last week claimed tests passed with no output.",
  });
  expect(store.promptRevisionByApproval(approval.id)!.id).toBe(store.promptHead("turn.system", "en")!.id);
});

test("an edit that no longer fits once you allow it is refused, not forced", async () => {
  const { store, ctx } = setup("zh");
  const proposed = await runCollabTool(ctx, "edit_prompt", { id: "turn.memory", edits: [{ old: "这些是你自己记下的事实", new: "这些是你记下的事实" }], reason: "更短。" });
  // You rewrote the note while the card waited.
  savePromptText(store, { id: "turn.memory", locale: "zh", text: "我的记忆说明。", ifRevision: null, actor: "user" });
  const ran = await proposed.waitApproval!.run({ approval_id: "a" });
  expect(ran).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(store.promptOverride("turn.memory", "zh")!.text).toBe("我的记忆说明。");
});

test("what the code needs stays: an edit that drops the format is refused before any card", async () => {
  const { ctx } = setup();
  const proposed = await runCollabTool(ctx, "edit_prompt", { id: "call.scribe", edits: [{ old: "{format}", new: "" }], reason: "shorter" });
  expect(proposed).toMatchObject({ ok: false, error: { code: "prompt_placeholder_missing" } });
  expect(proposed.waitApproval).toBeUndefined();
  expect((await runCollabTool(ctx, "edit_prompt", { id: "turn.system", edits: [{ old: "x".repeat(5000), new: "y" }], reason: "r" })).error?.code).toBe("edit_missing");
  expect((await runCollabTool(ctx, "edit_prompt", { id: "turn.system", edits: [{ add: "More." }] })).error?.code).toBe("reason_required");
  expect((await runCollabTool(ctx, "edit_prompt", { id: "call.scribe", locale: "en", edits: [{ add: "More." }], reason: "r" })).error?.code).toBe("prompt_locale");
});

test("a reset waits for the card too, and there is nothing to reset on a default", async () => {
  const { store, ctx } = setup();
  expect((await runCollabTool(ctx, "reset_prompt", { id: "turn.mcp", reason: "r" })).error?.code).toBe("no_change");
  savePromptText(store, { id: "turn.mcp", locale: "en", text: "My MCP note.", ifRevision: null, actor: "user" });
  const proposed = await runCollabTool(ctx, "reset_prompt", { id: "turn.mcp", reason: "The default reads better." });
  expect(proposed.waitApproval!.summary).toStartWith("Put a built-in prompt back on its default: MCP section opening · English");
  await proposed.waitApproval!.run({ approval_id: "card" });
  expect(store.promptOverride("turn.mcp", "en")).toBeNull();
  expect(store.promptHead("turn.mcp", "en")).toMatchObject({ op: "reset", actor: "bot", approval_id: "card" });
});

test("a prompt too long for one answer comes as an outline and is read by paragraph, exactly as written", async () => {
  const { store, ctx } = setup();
  const size = (data: unknown) => codePointCount(JSON.stringify({ ok: true, data }));
  const outline = await runCollabTool(ctx, "read_prompt", { id: "turn.system", locale: "en" });
  expect(outline.ok).toBe(true);
  expect(outline.data!.text).toBeUndefined();
  expect((outline.data!.outline as unknown[]).length).toBe(outline.data!.parts as number);
  expect(size(outline.data)).toBeLessThan(8000);
  // The Chinese System section at level 8 is just past what one answer holds.
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
  const zh = await runCollabTool(ctx, "read_prompt", { id: "turn.system", locale: "zh" });
  expect(zh.data!.outline).toBeDefined();
  expect(size(zh.data)).toBeLessThan(8000);
  // find gives the paragraph holding the phrase, part the same paragraph by number.
  const found = await runCollabTool(ctx, "read_prompt", { id: "turn.system", locale: "en", find: "Claim only what you ran" });
  const [paragraph] = found.data!.parts as Array<{ part: number; text: string }>;
  expect(paragraph!.text).toContain("Claim only what you ran:");
  expect(found.data!.matched).toEqual([paragraph!.part]);
  const byNumber = await runCollabTool(ctx, "read_prompt", { id: "turn.system", locale: "en", part: [paragraph!.part] });
  expect((byNumber.data!.parts as Array<{ text: string }>)[0]!.text).toBe(paragraph!.text);
  // What was read is the text itself, so it anchors an edit.
  const anchor = paragraph!.text.slice(paragraph!.text.indexOf("Claim only what you ran:"), paragraph!.text.indexOf("Claim only what you ran:") + 24);
  const proposed = await runCollabTool(ctx, "edit_prompt", { id: "turn.system", locale: "en", edits: [{ after: anchor, add: " Name the command." }], reason: "Hand-overs left out the command." });
  expect(proposed.waitApproval?.kind_key).toBe(PROMPT_EDIT_KIND);
  expect((await runCollabTool(ctx, "read_prompt", { id: "turn.system", part: [0] })).error?.code).toBe("invalid_args");
  expect((await runCollabTool(ctx, "read_prompt", { id: "turn.system", part: [1, 2, 3, 4, 5, 6] })).error?.code).toBe("invalid_args");
  // A default read with its default says so instead of sending the same text twice.
  const retro = await runCollabTool(ctx, "read_prompt", { id: "call.retrospective", locale: "en", with_default: true });
  expect(retro.data!.default_same).toBe(true);
  expect(size(retro.data)).toBeLessThan(8000);
});
