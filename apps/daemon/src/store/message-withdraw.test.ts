/**
 * Taking back a line of yours no Bot has read yet (撤回, ADR 0069): every copy waiting in an inbox
 * ends, no Bot reads the line any more, your words from it are erased, work queued for it alone
 * goes idle — and a line some Bot has read cannot be taken back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { Store } from ".";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const job = store.openTask({ sessionId: direct, title: "宣传片" });
  return { store, bot: director.bot, direct, job };
}

function said(store: Store, sessionId: string, body: string, taskId?: string) {
  const line = store.postMessage(sessionId, { body });
  if (taskId) store.fileMessage(line.id, { explicit: [{ taskId }] });
  return store.getMessage(line.id);
}

/** A turn at work on the job, and a line of yours waiting in its inbox for the next step. */
function waiting(body = "第三镜换成夜景") {
  const at = fixture();
  const opener = said(at.store, at.direct, "先出第一版", at.job.id);
  const turn = at.store.createTurn({ sessionId: at.direct, botId: at.bot.id, triggerMessageId: opener.id, taskId: at.job.id });
  const line = said(at.store, at.direct, body, at.job.id);
  const item = at.store.queueInboxItem({
    botId: at.bot.id, sessionId: at.direct, turnId: turn.id, taskId: at.job.id, ticketId: null, messageId: line.id, author: "user",
    body: line.body, source: "user", kind: "change", priority: 1,
  });
  return { ...at, turn, line, item };
}

function withdraw(store: Store, id: string) {
  return store.withdrawMessage(id, { userActionId: `withdraw-${id}` });
}

function refusal(run: () => unknown): { status: number; code: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, code: error.code };
    throw error;
  }
}

describe("taking back a line no Bot has read", () => {
  test("the copy waiting for the next step ends, the line says it was taken back, and no Bot reads it any more", () => {
    const { store, turn, line, item, direct } = waiting();
    expect(store.getMessage(line.id).delivery?.state).toBe("queued");

    const result = withdraw(store, line.id);
    expect(result.withdrawn).toBe(1);
    expect(result.message.withdrawn_at).toBeTruthy();
    expect(result.message.body).toBe("第三镜换成夜景");
    expect(result.message.delivery?.state).toBe("withdrawn");
    expect(store.getInboxItem(item.seq)).toMatchObject({ state: "withdrawn" });
    expect(store.getInboxItem(item.seq)!.disposed_at).toBeTruthy();
    expect(store.queuedForTurn(turn.id)).toHaveLength(0);
    // Out of every Bot's transcript, still in yours.
    expect(store.listMainMessages(direct, 50).map((message) => message.id)).not.toContain(line.id);
    expect(store.listMessages(direct).items.map((message) => message.id)).toContain(line.id);
    // Delivering it now, as a step boundary would, finds nothing to read.
    expect(store.deliverInboxItems([item.seq], turn.id, 2).delivered).toHaveLength(0);
    const event = store.db
      .query<{ payload: string }, []>(`SELECT payload FROM work_events WHERE kind = 'message.withdrawn'`)
      .get();
    expect(JSON.parse(event!.payload)).toMatchObject({ message: line.id, items: [item.seq] });
  });

  test("your words from it are erased, so neither the scribe nor a Bot's situation reads them", () => {
    const { store, line } = waiting("片长改成 45 秒");
    const before = store.listQuotes({ messageId: line.id });
    expect(before.length).toBeGreaterThan(0);
    const result = withdraw(store, line.id);
    expect(result.erased).toEqual(before.map((quote) => quote.id));
    for (const quote of store.listQuotes({ messageId: line.id })) {
      expect(quote.redacted_at).toBeTruthy();
      expect(quote.body).toBe("");
    }
  });

  test("taking it back twice changes nothing the second time", () => {
    const { store, line } = waiting();
    const first = withdraw(store, line.id);
    const second = withdraw(store, line.id);
    expect(second.withdrawn).toBe(0);
    expect(second.message.withdrawn_at).toBe(first.message.withdrawn_at!);
  });

  test("a line a stop holds can be taken back too", () => {
    const { store, bot, line, item } = waiting();
    store.createHold({ scope: "bot", scopeId: bot.id, source: "user_button" });
    // As the next step finds it: the stop covers it, so it is held instead of read.
    store.holdInboxItems([item.seq]);
    expect(store.getInboxItem(item.seq)!.state).toBe("held");
    expect(withdraw(store, line.id).withdrawn).toBe(1);
    expect(store.getInboxItem(item.seq)!.state).toBe("withdrawn");
  });

  test("work queued for the line alone goes idle and stops counting as in line", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "顺便把海报也做了", job.id);
    const queued = store.queueWork({ botId: bot.id, sessionId: direct, taskId: job.id, ticketId: null, messageId: line.id,
      author: "user", body: line.body, notice: false });
    expect(store.dispatchableWork().map((row) => row.id)).toContain(queued.workItem.id);

    withdraw(store, line.id);
    const work = store.db.query<{ state: string }, [string]>(`SELECT state FROM work_items WHERE id = ?`).get(queued.workItem.id);
    expect(work?.state).toBe("idle");
    expect(store.dispatchableWork().map((row) => row.id)).not.toContain(queued.workItem.id);
  });

  test("work that something else still wakes stays queued", () => {
    const { store, bot, direct, job } = fixture();
    const first = said(store, direct, "顺便把海报也做了", job.id);
    const second = said(store, direct, "海报用竖版", job.id);
    const queued = store.queueWork({ botId: bot.id, sessionId: direct, taskId: job.id, ticketId: null, messageId: first.id,
      author: "user", body: first.body, notice: false });
    store.queueWork({ botId: bot.id, sessionId: direct, taskId: job.id, ticketId: null, messageId: second.id,
      author: "user", body: second.body, notice: false });
    withdraw(store, first.id);
    const work = store.db.query<{ state: string }, [string]>(`SELECT state FROM work_items WHERE id = ?`).get(queued.workItem.id);
    expect(work?.state).toBe("queued");
  });
});

describe("what cannot be taken back", () => {
  test("a line a Bot read at a step", () => {
    const { store, turn, line, item } = waiting();
    store.deliverInboxItems([item.seq], turn.id, 1);
    expect(refusal(() => withdraw(store, line.id))).toEqual({ status: 409, code: "already_read" });
    expect(store.getMessage(line.id).withdrawn_at).toBeUndefined();
  });

  test("a line that opened a turn: the Bot read it as what it was asked", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "做一支 30 秒的片", job.id);
    store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id });
    expect(refusal(() => withdraw(store, line.id))).toEqual({ status: 409, code: "already_read" });
  });

  test("a line waiting for no Bot", () => {
    const { store, direct } = fixture();
    const line = said(store, direct, "随便说一句");
    expect(refusal(() => withdraw(store, line.id))).toEqual({ status: 409, code: "not_queued" });
  });

  test("a Bot's line, and a line the app carried out", () => {
    const { store, bot, direct, line } = waiting();
    const botLine = store.insertMessage({ sessionId: direct, kind: "bot", author: bot.id, body: "好的" });
    expect(refusal(() => withdraw(store, botLine.id))?.code).toBe("not_withdrawable");
    store.markLineTaken(line.id, "app");
    expect(refusal(() => withdraw(store, line.id))).toEqual({ status: 422, code: "not_withdrawable" });
  });

  test("a line taken back is not changed, refiled or opened as a job: you send it again instead", () => {
    const { store, line, job } = waiting();
    withdraw(store, line.id);
    expect(refusal(() => store.editMessage(line.id, { body: "第三镜换成雨夜", userActionId: "edit" }))?.code).toBe("not_editable");
    expect(refusal(() => store.refileMessage(line.id, { filings: [{ taskId: job.id }], userActionId: "refile" }))?.code).toBe("withdrawn");
    expect(refusal(() => store.newJobFromLine(line.id, { userActionId: "new" }))?.code).toBe("withdrawn");
  });
});

describe("an inbox from before lines could be taken back", () => {
  test("is widened to the new state with every item and its numbering kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-withdraw-"));
    const file = join(dir, "state.sqlite");
    try {
      const old = new Database(file, { create: true, strict: true });
      old.exec(readFileSync(join(dirname(import.meta.path), "fixtures", "schema-pre-api-format.sql"), "utf8"));
      const shape = old.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'inbox_items'`).get()!.sql;
      expect(shape).not.toContain("'withdrawn'");
      old.run(
        `INSERT INTO inbox_items (seq, id, bot_id, author, body_snapshot, source, kind, priority, state, created_at)
         VALUES (41, ?, 'bot-1', 'user', '早先的一句', 'user', 'change', 1, 'adopted', ?)`,
        [ulid(), isoNow()],
      );
      // The highest number ever handed out, though its row is gone: it is never handed out again.
      old.run(`UPDATE sqlite_sequence SET seq = 57 WHERE name = 'inbox_items'`);
      old.close();

      const store = new Store({ filename: file });
      stores.push(store);
      const widened = store.db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'inbox_items'`).get()!.sql;
      expect(widened).toContain("'withdrawn'");
      expect(store.getInboxItem(41)).toMatchObject({ body_snapshot: "早先的一句", state: "adopted" });
      const indexes = store.db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbox_items' AND sql IS NOT NULL ORDER BY name`)
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(["inbox_items_delivered", "inbox_items_message", "inbox_items_turn", "inbox_items_waiting"]);
      const next = store.queueInboxItem({ botId: "bot-1", sessionId: "s-1", turnId: null, taskId: null, ticketId: null, messageId: null,
        author: "user", body: "新的一句", source: "user", kind: "change", priority: 1 });
      expect(next.seq).toBe(58);
      store.db.run(`UPDATE inbox_items SET state = 'withdrawn' WHERE seq = ?`, [next.seq]);
      expect(store.getInboxItem(next.seq)!.state).toBe("withdrawn");
      const columns = store.db.query<{ name: string }, []>(`PRAGMA table_info(messages)`).all().map((row) => row.name);
      expect(columns).toContain("withdrawn_at");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
