import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { Store } from "../store";
import {
  hostPromptEnv,
  keepMyPrompt,
  promptPage,
  reconcilePrompts,
  resetPromptText,
  restorePromptRevision,
  savePromptText,
  undoPromptRevision,
} from "./book";
import { renderDefault, slotDef } from "./registry";

function fresh(): Store {
  return new Store();
}

function defaultOf(store: Store, id: string, locale: "zh" | "en"): string {
  return renderDefault(slotDef(id)!, locale, hostPromptEnv(store));
}

function refused(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("saving your version", () => {
  test("it is written against the default it was edited from, and the page sends it", () => {
    const store = fresh();
    const base = defaultOf(store, "turn.memory", "en");
    const revision = savePromptText(store, { id: "turn.memory", locale: "en", text: `${base}\n\nKeep memories short.`, ifRevision: null, actor: "user" })!;
    expect(revision).toMatchObject({ op: "edit", actor: "user", before_text: null, after_text: `${base}\n\nKeep memories short.`, after_base: base });
    expect(store.promptOverride("turn.memory", "en")).toMatchObject({ text: `${base}\n\nKeep memories short.`, base_text: base, revision_id: revision.id, conflict_default: null });
    const use = promptPage(store, "en").resolve("turn.memory");
    expect(use).toEqual({ text: `${base}\n\nKeep memories short.`, ref: { id: "turn.memory", locale: "en", revision_id: revision.id } });
    // The other language is untouched.
    expect(promptPage(store, "zh").edited("turn.memory")).toBeUndefined();
  });

  test("the change you last saw guards it: a newer change is a 409", () => {
    const store = fresh();
    const first = savePromptText(store, { id: "turn.mcp", locale: "zh", text: "说明一。", ifRevision: null, actor: "user" })!;
    expect(refused(() => savePromptText(store, { id: "turn.mcp", locale: "zh", text: "说明二。", ifRevision: null, actor: "user" })).status).toBe(409);
    savePromptText(store, { id: "turn.mcp", locale: "zh", text: "说明二。", ifRevision: first.id, actor: "user" });
    expect(store.promptOverride("turn.mcp", "zh")!.text).toBe("说明二。");
  });

  test("saves in one editor sitting fold into one change", () => {
    const store = fresh();
    const one = savePromptText(store, { id: "turn.skills", locale: "en", text: "A.", ifRevision: null, editSession: "s1", actor: "user" })!;
    const two = savePromptText(store, { id: "turn.skills", locale: "en", text: "A. B.", ifRevision: one.id, editSession: "s1", actor: "user" })!;
    expect(two.id).toBe(one.id);
    expect(store.listPromptRevisions("turn.skills", "en")).toHaveLength(1);
    expect(store.listPromptRevisions("turn.skills", "en")[0]).toMatchObject({ before_text: null, after_text: "A. B." });
    // Another sitting is another change.
    savePromptText(store, { id: "turn.skills", locale: "en", text: "A. B. C.", ifRevision: two.id, editSession: "s2", actor: "user" });
    expect(store.listPromptRevisions("turn.skills", "en")).toHaveLength(2);
  });

  test("text that says exactly what the default says is the default again", () => {
    const store = fresh();
    const base = defaultOf(store, "turn.system", "zh");
    const edited = savePromptText(store, { id: "turn.system", locale: "zh", text: `${base}\n\n多一句。`, ifRevision: null, actor: "user" })!;
    savePromptText(store, { id: "turn.system", locale: "zh", text: base, ifRevision: edited.id, actor: "user" });
    expect(store.promptOverride("turn.system", "zh")).toBeNull();
    expect(store.listPromptRevisions("turn.system", "zh")[0]).toMatchObject({ op: "edit", after_text: null });
  });

  test("what the code needs stays: the format once, the placeholders, no brace where the answer is read from one", () => {
    const store = fresh();
    expect(refused(() => savePromptText(store, { id: "call.scribe", locale: "zh", text: "只记用户的话。", ifRevision: null, actor: "user" }))).toMatchObject({ status: 422, code: "prompt_placeholder_missing" });
    expect(refused(() => savePromptText(store, { id: "call.scribe", locale: "zh", text: "{format}\n{format}", ifRevision: null, actor: "user" })).code).toBe("prompt_placeholder_repeated");
    expect(refused(() => savePromptText(store, { id: "call.scribe", locale: "zh", text: "按 {rules} 记。\n\n{format}", ifRevision: null, actor: "user" })).code).toBe("prompt_placeholder_unknown");
    expect(refused(() => savePromptText(store, { id: "call.judgement", locale: "zh", text: "例如 {\"decision\": \"join\"}。\n\n{format}", ifRevision: null, actor: "user" })).code).toBe("prompt_brace");
    expect(refused(() => savePromptText(store, { id: "agent.preface", locale: "en", text: "Files are under {workspace}.", ifRevision: null, actor: "user" })).message).toContain("{cwd}");
    expect(refused(() => savePromptText(store, { id: "turn.memory", locale: "en", text: "   ", ifRevision: null, actor: "user" })).code).toBe("prompt_empty");
    expect(refused(() => savePromptText(store, { id: "turn.memory", locale: "en", text: "x".repeat(60_000), ifRevision: null, actor: "user" })).code).toBe("prompt_too_long");
    expect(refused(() => savePromptText(store, { id: "call.scribe", locale: "en", text: "{format}", ifRevision: null, actor: "user" })).code).toBe("prompt_locale");
    expect(refused(() => savePromptText(store, { id: "call.nothing", locale: "zh", text: "x", ifRevision: null, actor: "user" })).status).toBe(404);
    // JSON in an editable text is words, not a placeholder.
    savePromptText(store, { id: "call.scribe", locale: "zh", text: "没有要求就输出 {\"adds\": []}。\n\n{format}", ifRevision: null, actor: "user" });
    expect(promptPage(store, "zh").resolve("call.scribe").text).toStartWith("没有要求就输出 {\"adds\": []}。\n\n只输出一个 JSON 对象");
  });

  test("a change is announced once it commits", () => {
    const store = fresh();
    const events: ClientEvent[] = [];
    store.onCommit((event) => events.push(event));
    savePromptText(store, { id: "tool.remember", locale: "zh", text: "记一条。", ifRevision: null, actor: "user" });
    expect(events.filter((event) => event.event === "prompt.changed")).toEqual([
      expect.objectContaining({ event: "prompt.changed", id: "tool.remember", locale: "zh" }),
    ]);
  });
});

describe("taking changes back", () => {
  test("reset puts the default back; undo takes back only the latest change, while it still stands", () => {
    const store = fresh();
    const a = savePromptText(store, { id: "turn.memory", locale: "zh", text: "版本一。", ifRevision: null, actor: "user" })!;
    const b = savePromptText(store, { id: "turn.memory", locale: "zh", text: "版本二。", ifRevision: a.id, actor: "user" })!;
    expect(refused(() => undoPromptRevision(store, a.id))).toMatchObject({ status: 409, code: "changed_since" });
    undoPromptRevision(store, b.id);
    expect(store.promptOverride("turn.memory", "zh")!.text).toBe("版本一。");
    const reset = resetPromptText(store, { id: "turn.memory", locale: "zh", ifRevision: store.promptHead("turn.memory", "zh")!.id, actor: "user" })!;
    expect(reset.op).toBe("reset");
    expect(store.promptOverride("turn.memory", "zh")).toBeNull();
    // Undoing the reset brings your version back.
    undoPromptRevision(store, reset.id);
    expect(store.promptOverride("turn.memory", "zh")!.text).toBe("版本一。");
  });

  test("restore puts back what any change wrote", () => {
    const store = fresh();
    const a = savePromptText(store, { id: "turn.mcp", locale: "en", text: "First.", ifRevision: null, actor: "user" })!;
    const b = savePromptText(store, { id: "turn.mcp", locale: "en", text: "Second.", ifRevision: a.id, actor: "user" })!;
    savePromptText(store, { id: "turn.mcp", locale: "en", text: "Third.", ifRevision: b.id, actor: "user" });
    const restored = restorePromptRevision(store, a.id)!;
    expect(restored).toMatchObject({ op: "restore", after_text: "First." });
    expect(store.promptOverride("turn.mcp", "en")!.text).toBe("First.");
  });
});

describe("a newer default", () => {
  /** Pretends your version was written against an older default by rewriting the base it stands on. */
  function olderBase(store: Store, id: string, locale: "zh" | "en", base: string, text: string): void {
    store.db.run("UPDATE prompt_overrides SET base_text = ?, text = ? WHERE prompt_id = ? AND locale = ?", [base, text, id, locale]);
  }

  test("merges into your version line by line, as the app's undoable change", () => {
    const store = fresh();
    const now = defaultOf(store, "turn.skills", "en");
    savePromptText(store, { id: "turn.skills", locale: "en", text: "placeholder", ifRevision: null, actor: "user" });
    // Back then the default had one more paragraph at the end; you put one of your own first.
    const old = `${now}\n\nAn old closing paragraph.`;
    olderBase(store, "turn.skills", "en", old, `Mine first.\n\n${old}`);
    const lines = reconcilePrompts(store);
    expect(lines).toEqual([expect.stringContaining("merged the new default")]);
    const after = store.promptOverride("turn.skills", "en")!;
    expect(after.base_text).toBe(now);
    expect(after.text).toBe(`Mine first.\n\n${now}`);
    expect(store.promptHead("turn.skills", "en")).toMatchObject({ op: "merge", actor: "app" });
    // Run again: nothing to do.
    expect(reconcilePrompts(store)).toEqual([]);
  });

  test("one that does not merge keeps yours in force and is marked; keep-mine settles it", () => {
    const store = fresh();
    const now = defaultOf(store, "turn.memory", "en");
    const saved = savePromptText(store, { id: "turn.memory", locale: "en", text: "placeholder", ifRevision: null, actor: "user" })!;
    // You and the new default both rewrote the same (only) paragraph.
    olderBase(store, "turn.memory", "en", "The old note.", "Your note.");
    expect(reconcilePrompts(store)).toEqual([expect.stringContaining("does not merge")]);
    const row = store.promptOverride("turn.memory", "en")!;
    expect(row).toMatchObject({ text: "Your note.", base_text: "The old note.", conflict_default: now });
    expect(promptPage(store, "en").resolve("turn.memory").text).toBe("Your note.");
    // Marked once: the next open says nothing more.
    expect(reconcilePrompts(store)).toEqual([]);
    expect(refused(() => keepMyPrompt(store, { id: "turn.memory", locale: "en", ifRevision: null }))).toMatchObject({ status: 409 });
    keepMyPrompt(store, { id: "turn.memory", locale: "en", ifRevision: saved.id });
    expect(store.promptOverride("turn.memory", "en")).toMatchObject({ text: "Your note.", base_text: now, conflict_default: null });
    expect(refused(() => keepMyPrompt(store, { id: "turn.memory", locale: "en" })).code).toBe("prompt_no_conflict");
  });

  test("a merge that comes out as the default puts the slot back on it", () => {
    const store = fresh();
    const now = defaultOf(store, "turn.mcp", "zh");
    savePromptText(store, { id: "turn.mcp", locale: "zh", text: "placeholder", ifRevision: null, actor: "user" });
    // You only ever changed what the new default changed, the same way.
    olderBase(store, "turn.mcp", "zh", "旧说明。", now);
    expect(reconcilePrompts(store)).toEqual([expect.stringContaining("now the default")]);
    expect(store.promptOverride("turn.mcp", "zh")).toBeNull();
  });

  test("a prompt this build no longer has is kept as it is", () => {
    const store = fresh();
    savePromptText(store, { id: "turn.mcp", locale: "zh", text: "说明。", ifRevision: null, actor: "user" });
    store.db.run("UPDATE prompt_overrides SET prompt_id = 'turn.gone' WHERE prompt_id = 'turn.mcp'");
    expect(reconcilePrompts(store)).toEqual(["turn.gone (zh): no such prompt in this build, kept"]);
    expect(store.listPromptOverrides()).toHaveLength(1);
  });
});

describe("answers that do not read", () => {
  test("count against the revision they ran on", () => {
    const store = fresh();
    store.notePromptParseFailure({ prompt: "call.scribe", locale: "zh", revision: null, reason: "unreadable" });
    const edit = savePromptText(store, { id: "call.scribe", locale: "zh", text: "只记用户的话。\n\n{format}", ifRevision: null, actor: "user" })!;
    store.notePromptParseFailure({ prompt: "call.scribe", locale: "zh", revision: edit.id, reason: "unreadable" });
    store.notePromptParseFailure({ prompt: "call.scribe", locale: "zh", revision: edit.id, reason: "unreadable" });
    expect(store.promptParseFailures("call.scribe", "zh", edit.id)).toBe(2);
    expect(store.promptParseFailures("call.scribe", "zh", null)).toBe(1);
    expect(store.promptParseFailures("call.scribe", "zh", "any")).toBe(3);
  });
});
