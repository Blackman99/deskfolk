import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import { RECIPES, TABLE_NOTES } from "./catalog";
import { runQuery } from "./child";
import { DENIED_TABLES, deniedTable } from "./guard";

test("every table the catalog describes, and every one it denies, is a table the store has", () => {
  const store = new Store();
  try {
    const tables = new Set(store.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    for (const name of Object.keys(TABLE_NOTES)) expect(tables.has(name)).toBe(true);
    for (const name of DENIED_TABLES) expect(tables.has(name)).toBe(true);
    // Remote access keeps its keys in remote_* tables; all of them are denied, and nothing described is.
    expect([...tables].filter((name) => name.startsWith("remote_")).length).toBeGreaterThan(3);
    for (const name of Object.keys(TABLE_NOTES)) expect(deniedTable(name)).toBe(false);
  } finally {
    store.close();
  }
});

/**
 * Tables Bots read as they are, with no line in the catalog. None holds a credential: endpoint and MCP
 * keys are in the keychain (settings keeps only a reference), MCP commands, args and urls are what
 * list_mcp_servers already shows, and the delivery tokens are the push queue's own leases.
 */
const READ_AS_THEY_ARE = [
  "allow_rules", "attachments", "external_jobs", "file_commits", "file_stages", "held_scopes", "inbox_items",
  "live_procs", "mcp_servers", "message_edits", "notification_counters", "notification_deliveries",
  "notification_delivery_items", "notification_policy", "notification_retention_notice", "notifications",
  "providers", "reactions", "request_meta", "requirement_exclusions", "requirement_mentions", "route_feedback",
  "route_learned", "route_learnings", "route_reviews", "session_notification_preferences", "settings",
  "user_quote_filings", "work_items",
];

test("every table is described, denied, or read as it is: a new one is decided before a Bot can read it", () => {
  const store = new Store();
  try {
    const names = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')").all().map((row) => row.name);
    const undecided = names.filter((name) => !deniedTable(name) && !(name in TABLE_NOTES) && !READ_AS_THEY_ARE.includes(name));
    expect(undecided).toEqual([]);
    for (const name of READ_AS_THEY_ARE) expect(names).toContain(name);
  } finally {
    store.close();
  }
});

test("each ready-made query runs through the guard on seeded records and counts what it says", () => {
  const dir = mkdtempSync(join(tmpdir(), "records-recipes-"));
  const path = join(dir, "state.sqlite");
  const store = new Store({ filename: path });
  try {
    // Quality events are filed only from level 8; these rows stand in for what the app files.
    store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
    const maker = store.createBot({ name: "Maker", duties: "make", boundaries: "none" });
    const plan = store.openTask({ sessionId: maker.direct_session.id, title: "EP01" });
    const ticket = store.createTicket({ taskId: plan.id, title: "母带", worker: maker.bot.id });
    const line = store.postMessage(maker.direct_session.id, { body: "做 EP01" });
    const turn = store.createTurn({ sessionId: maker.direct_session.id, botId: maker.bot.id, triggerMessageId: line.id, taskId: plan.id, ticketId: ticket.id });
    const at = "2026-10-03T08:00:00.000Z";
    const handOver = (id: string, state: string, origin = "submit") => store.db.run(
      `INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims, note, state, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '[]', ?, 'm', ?, ?, '[]', NULL, '[]', '', ?, ?, ?)`, [id, plan.id, ticket.id, maker.bot.id, turn.id, origin, state, at, at]);
    handOver("s1", "rejected");
    handOver("s2", "rejected");
    handOver("s3", "approved");
    handOver("s4", "rejected", "organizer");
    const trouble = (id: string, kind: string, category: string) => store.db.run(
      "INSERT INTO quality_events (id, kind, category, task_id, bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, kind, category, plan.id, maker.bot.id, at]);
    trouble("q1", "user_rejected", "execution");
    trouble("q2", "complaint", "execution");
    trouble("q3", "requirement_after_delivery", "unclear");
    for (const code of ["unfinished_obligations", "unfinished_obligations", "promised_later"]) {
      store.recordWorkEvent({ kind: "end.rejected", actor: "app", taskId: plan.id, botId: maker.bot.id, turnId: turn.id, payload: { code } });
    }
    store.notePromptParseFailure({ prompt: "call.organizer", locale: "zh", revision: null, reason: "unparseable", botId: maker.bot.id });
    store.db.run(`INSERT INTO retrospectives (id, task_id, bot_id, delivered_at, state, summary, findings, changes, created_at, finished_at)
      VALUES ('r1', ?, ?, ?, 'done', '画风先对原作', '{"rework_causes":["画风做成写实"]}', '[]', ?, ?)`, [plan.id, maker.bot.id, at, at, at]);
    for (const [call, outcome] of [["c1", "failed"], ["c2", "failed"], ["c3", "succeeded"]] as const) {
      store.db.run(`INSERT INTO tool_executions (id, task_id, bot_id, turn_id, tool_call_id, tool, side_effect, started_at, finished_at, outcome)
        VALUES (?, ?, ?, ?, ?, 'shell', 1, ?, ?, ?)`, [call, plan.id, maker.bot.id, turn.id, call, at, at, outcome]);
    }
    const answers = Object.fromEntries(RECIPES.map((recipe) => {
      const answer = runQuery({ mode: "query", db: path, sql: recipe.sql, params: [], maxRows: 100 });
      if (!answer.ok) throw new Error(`${recipe.id}: ${answer.error}`);
      return [recipe.id, answer.columns.length ? answer.rows.map((row) => Object.fromEntries(answer.columns.map((name, i) => [name, row[i]]))) : []];
    }));
    // A job with no kind counts as its own; the organizer's own hand-over is not a hand-over; by_you is part of sent_back.
    expect(answers.sent_back_by_kind).toEqual([expect.objectContaining({ kind: "EP01", jobs: 1, hand_overs: 3, sent_back: 2, by_you: 1, complaints: 1, late_asks: 1, worst_jobs: "EP01" })]);
    expect(answers.endings_refused).toEqual([
      expect.objectContaining({ code: "unfinished_obligations", times: 2, bots: "Maker" }),
      expect.objectContaining({ code: "promised_later", times: 1 }),
    ]);
    expect(answers.trouble_by_kind).toContainEqual(expect.objectContaining({ category: "execution", kind: "complaint", times: 1, jobs: 1 }));
    expect(answers.unreadable_answers).toEqual([expect.objectContaining({ prompt: "call.organizer", locale: "zh", revision: "default", reason: "unparseable", times: 1 })]);
    expect(answers.recent_retrospectives).toEqual([expect.objectContaining({ job: "EP01", bot: "Maker", summary: "画风先对原作", rework_causes: '["画风做成写实"]' })]);
    expect(answers.tool_errors).toEqual([expect.objectContaining({ tool: "shell", outcome: "failed", times: 2 })]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
