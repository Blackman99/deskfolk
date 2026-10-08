/**
 * A turn whose loop no longer fits the model's context (ADR 0068): the older hops are condensed into
 * a summary on the built-in prompt `call.compact` and the turn goes on, instead of failing with its
 * work lost. Refused as over the context, the hop goes again once compacted; near a window the
 * model's entry names, the loop is compacted before the hop is sent.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactNote } from "./compaction";
import type { CompletionOk, CompletionRequest, JudgeRequest } from "./completions";
import { isoNow } from "./ids";
import { promptBytes } from "./local-model";
import { completionFailBody } from "./prompts";
import { savePromptText } from "./prompts/book";
import { COMPACT_TEMPLATE } from "./prompts/compaction";
import { Store } from "./store";
import { call, createScenario, failed, requestText, say, tool, type HopContext, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function oneBot() {
  const h = await createScenario();
  open.push(h);
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  return { h, alpha: alpha!, dm };
}

function lines(h: Scenario, session: string, kind: "bot" | "system"): string[] {
  return h.messages(session).filter((m) => m.kind === kind).map((m) => m.body);
}

const READS = 12;

/** Twelve notes, each read back whole: under the 8,000 characters a tool result keeps. */
function writeNotes(h: Scenario): void {
  for (let i = 1; i <= READS; i++) writeFileSync(join(h.root, `note-${i}.md`), `NOTE-${i}-${"x".repeat(6_800)}`);
}

const reads = (from = 1) => Array.from({ length: READS }, (_, i) => call(tool("read_file", { path: `note-${from + i}.md` })));

function judgeText(request: JudgeRequest | CompletionRequest): string {
  return request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

const SUMMARY = "- 读完了 note-1.md 到 note-12.md，每份都是 NOTE 编号加一串 x。";

test("over the model's context mid-turn, the older hops are condensed and the hop goes again", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  let asked: JudgeRequest | null = null;
  h.script(alpha, dm).reply(...reads(), failed("context_full"), say("十二份笔记都看完了。"));
  h.judge("compact").reply(({ request }) => {
    asked = request;
    return SUMMARY;
  });
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();

  expect(h.judgeCalls("compact")).toHaveLength(1);
  // The summary call read the line that started the turn and the hops it condenses.
  expect(asked!.prompt).toEqual({ id: "call.compact", locale: "zh", revision_id: null });
  expect(asked!.messages[0]).toEqual({ role: "system", content: COMPACT_TEMPLATE.zh });
  expect(judgeText(asked!)).toContain("把十二份笔记都看一遍");
  expect(judgeText(asked!)).toContain("NOTE-1-");
  expect(asked!.tools).toBeUndefined();

  const hops = h.hops(alpha);
  expect(hops).toHaveLength(READS + 2);
  const again = requestText(hops.at(-1)!.request);
  expect(again).toContain(compactNote("zh", SUMMARY));
  expect(again).not.toContain("NOTE-1-");
  expect(lines(h, dm, "bot")).toEqual(["十二份笔记都看完了。"]);
  expect(lines(h, dm, "system")).toEqual([]);
  // Billed to the turn, as its compaction.
  const turn = h.turns(alpha)[0]!;
  expect(h.store.db.query("SELECT kind, purpose, turn_id FROM spend WHERE purpose = 'compact'").all()).toEqual([
    { kind: "turn", purpose: "compact", turn_id: turn.id },
  ]);
});

test("over the context again before a hop went through, the turn fails as it did before", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  h.script(alpha, dm).reply(...reads(), failed("context_full"), failed("context_full"));
  h.judge("compact").reply(SUMMARY);
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();

  expect(h.judgeCalls("compact")).toHaveLength(1);
  expect(h.hops(alpha)).toHaveLength(READS + 2);
  expect(lines(h, dm, "system")).toEqual([completionFailBody("zh", "context_full")]);
});

test("no summary to go on with (the call failed or said nothing): the turn fails as it did before", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  h.script(alpha, dm).reply(...reads(), failed("context_full"));
  // Unscripted, the summary call answers nothing.
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();

  expect(h.judgeCalls("compact")).toHaveLength(1);
  expect(h.hops(alpha)).toHaveLength(READS + 1);
  expect(lines(h, dm, "system")).toEqual([completionFailBody("zh", "context_full")]);
});

test("the compaction runs on your text when you edited it (ADR 0064)", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  const saved = savePromptText(h.store, { id: "call.compact", locale: "zh", text: "只列出读过的文件，每个一行。", ifRevision: null, actor: "user" })!;
  let asked: JudgeRequest | null = null;
  h.script(alpha, dm).reply(...reads(), failed("context_full"), say("好了。"));
  h.judge("compact").reply(({ request }) => {
    asked = request;
    return "- note-1.md … note-12.md";
  });
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();

  expect(asked!.messages[0]).toEqual({ role: "system", content: "只列出读过的文件，每个一行。" });
  expect(asked!.prompt).toEqual({ id: "call.compact", locale: "zh", revision_id: saved.id });
  expect(lines(h, dm, "bot")).toEqual(["好了。"]);
});

test("a second compaction folds the first summary in", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  for (let i = READS + 1; i <= 2 * READS; i++) writeFileSync(join(h.root, `note-${i}.md`), `NOTE-${i}-${"x".repeat(6_800)}`);
  const asked: JudgeRequest[] = [];
  h.script(alpha, dm).reply(...reads(), failed("context_full"), ...reads(READS + 1), failed("context_full"), say("二十四份都看完了。"));
  h.judge("compact").handle(({ request }) => {
    asked.push(request);
    return asked.length === 1 ? SUMMARY : "- 二十四份都读了。";
  });
  h.postUser(dm, "把二十四份笔记都看一遍");
  await h.waitIdle();

  expect(asked).toHaveLength(2);
  expect(judgeText(asked[1]!)).toContain("【之前压缩的摘要】");
  expect(judgeText(asked[1]!)).toContain(SUMMARY);
  const last = requestText(h.hops(alpha).at(-1)!.request);
  expect(last).toContain(compactNote("zh", "- 二十四份都读了。"));
  expect(last).not.toContain(SUMMARY);
  expect(lines(h, dm, "bot")).toEqual(["二十四份都看完了。"]);
});

test("near the window the model's entry names, the loop is compacted before the hop is sent", async () => {
  const { h, alpha, dm } = await oneBot();
  writeNotes(h);
  // Each hop says it read one token per four bytes it was sent.
  const read = (reply: CompletionOk, { request }: HopContext): CompletionOk => ({
    ...reply,
    usage: { input_tokens: Math.ceil(promptBytes(request.messages, request.tools) / 4), output_tokens: 10, total_tokens: null, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null },
  });
  const steps = reads().map((reply, i) => async (ctx: HopContext) => {
    if (i === READS - 1) {
      // The window as the model's entry names it: this hop at three quarters of it, so the next one is past.
      const window = Math.floor(promptBytes(ctx.request.messages, ctx.request.tools) / 4 / 0.75);
      await h.store.patchSettings({ endpoint_models: [{ name: "scenario", context_window: window }] });
    }
    return read(reply, ctx);
  });
  h.script(alpha, dm).reply(...steps, (ctx) => read(say("十二份笔记都看完了。"), ctx));
  h.judge("compact").reply(SUMMARY);
  h.postUser(dm, "把十二份笔记都看一遍");
  await h.waitIdle();

  expect(h.judgeCalls("compact")).toHaveLength(1);
  // No hop was refused first: the one after the twelfth read went out compacted.
  const hops = h.hops(alpha);
  expect(hops).toHaveLength(READS + 1);
  expect(requestText(hops.at(-1)!.request)).toContain(compactNote("zh", SUMMARY));
  expect(requestText(hops.at(-1)!.request)).not.toContain("NOTE-1-");
  expect(lines(h, dm, "bot")).toEqual(["十二份笔记都看完了。"]);
});

test("a ledger from before compaction is widened to bill it, its rows kept", () => {
  const filename = join(mkdtempSync(join(tmpdir(), "compact-spend-")), "state.sqlite");
  const first = new Store({ filename });
  first.db.run(`INSERT INTO spend (id, session_id, bot_id, kind, purpose, model, cost_usd_ticks, created_at) VALUES ('old', 's', NULL, 'organize', 'retrospect', 'm', 1, ?)`, [isoNow()]);
  // The ledger as the last release left it: no 'compact' in its CHECK.
  const table = first.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend'").get()!.sql;
  const older = table.replace("'retrospect', 'compact'", "'retrospect'").replace(/^CREATE TABLE\s+(?:"spend"|spend\b)/i, "CREATE TABLE spend_old");
  expect(older).not.toContain("'compact'");
  first.db.run("PRAGMA legacy_alter_table = ON");
  first.db.transaction(() => {
    first.db.run(older);
    first.db.run("INSERT INTO spend_old SELECT * FROM spend");
    first.db.run("DROP TABLE spend");
    first.db.run("ALTER TABLE spend_old RENAME TO spend");
  })();
  const compacted = `INSERT INTO spend (id, session_id, kind, purpose, turn_id, model, created_at) VALUES ('new', 's', 'turn', 'compact', 't', 'm', ?)`;
  expect(() => first.db.run(compacted, [isoNow()])).toThrow();
  first.close();
  const reopened = new Store({ filename });
  try {
    reopened.db.run(compacted, [isoNow()]);
    expect(reopened.db.query("SELECT id, purpose FROM spend ORDER BY id").all()).toEqual([{ id: "new", purpose: "compact" }, { id: "old", purpose: "retrospect" }]);
  } finally {
    reopened.close();
  }
});
