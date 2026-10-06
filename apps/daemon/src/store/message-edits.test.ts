/**
 * Changing a line of yours after it went out (ADR 0063): the transcript says the new words and keeps
 * what it said, your words gain only the clauses you changed, a Bot that had not read the line reads
 * the new words alone, and every Bot that had is told what changed, where it works.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HttpError } from "../errors";
import { Store } from ".";
import { correctionBody, swapWords } from "./message-edits";

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

function edit(store: Store, id: string, body: string) {
  return store.editMessage(id, { body, userActionId: `edit-${body.length}` });
}

function corrections(store: Store, messageId: string) {
  return store.db
    .query<{ seq: number; bot_id: string; turn_id: string | null; work_item_id: string | null; state: string; source: string; kind: string;
      priority: number; author: string; body_snapshot: string; edit_id: string | null }, [string]>(
      `SELECT seq, bot_id, turn_id, work_item_id, state, source, kind, priority, author, body_snapshot, edit_id
       FROM inbox_items WHERE message_id = ? AND edit_id IS NOT NULL ORDER BY seq`,
    )
    .all(messageId);
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

describe("changing a line of yours", () => {
  test("the line shows the new words, keeps what it said, and your words gain only the clause you changed", () => {
    const { store, direct, job } = fixture();
    const line = said(store, direct, "做一支约 30 秒的竖屏片，加字幕", job.id);
    const result = edit(store, line.id, "做一支约 45 秒的竖屏片，加字幕");

    expect(result.message.body).toBe("做一支约 45 秒的竖屏片，加字幕");
    expect(result.message.edited_at).toBeTruthy();
    expect(store.getMessage(line.id).edited_at).toBe(result.message.edited_at!);
    expect(store.messageVersions(line.id)).toEqual([{ body: "做一支约 30 秒的竖屏片，加字幕", created_at: line.created_at }]);

    const quotes = store.listQuotes({ messageId: line.id });
    expect(quotes.map((quote) => quote.body)).toEqual(["做一支约 30 秒的竖屏片，加字幕", "做一支约 45 秒的竖屏片"]);
    expect(quotes[1]).toMatchObject({ via: "message", edit_of: quotes[0]!.id, task_id: job.id, session_id: direct });
    expect(result.quote?.id).toBe(quotes[1]!.id);
    const filed = store.db
      .query<{ task_id: string }, [string]>(`SELECT task_id FROM user_quote_filings WHERE quote_id = ?`)
      .all(quotes[1]!.id);
    expect(filed).toEqual([{ task_id: job.id }]);
    const logged = store.db
      .query<{ payload: string }, []>(`SELECT payload FROM work_events WHERE kind = 'message.edited'`)
      .all()
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(logged).toEqual([expect.objectContaining({ message: line.id, edit: result.edit!.id, quote: quotes[1]!.id })]);
  });

  test("a second change points back at the line's first words, and the versions list grows oldest first", () => {
    const { store, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    const first = edit(store, line.id, "片长 45 秒");
    edit(store, line.id, "片长 60 秒");
    const quotes = store.listQuotes({ messageId: line.id });
    expect(quotes.map((quote) => quote.edit_of ?? null)).toEqual([null, quotes[0]!.id, quotes[0]!.id]);
    expect(store.messageVersions(line.id)).toEqual([
      { body: "片长 30 秒", created_at: line.created_at },
      { body: "片长 45 秒", created_at: first.edit!.created_at },
    ]);
  });

  test("the same words are no change, and taking words out keeps no new quote", () => {
    const { store, direct, job } = fixture();
    const line = said(store, direct, "做一支约 30 秒的竖屏片，加字幕", job.id);
    const same = edit(store, line.id, "做一支约 30 秒的竖屏片，加字幕");
    expect(same.edit).toBeNull();
    expect(store.getMessage(line.id).edited_at).toBeUndefined();
    const cut = edit(store, line.id, "做一支约 30 秒的竖屏片");
    expect(cut.edit).not.toBeNull();
    expect(cut.quote).toBeNull();
    expect(store.listQuotes({ messageId: line.id })).toHaveLength(1);
  });

  test("a reply to a Bot keeps naming it, as a post would", () => {
    const { store, bot, direct } = fixture();
    const reply = store.insertMessage({ sessionId: direct, kind: "bot", author: bot.id, body: "第一版好了" });
    const line = store.postMessage(direct, { body: "开头再短一点", parent_id: reply.id });
    expect(line.body).toContain("@视频导演");
    const result = edit(store, line.id, "开头再短两秒");
    expect(result.message.body).toContain("@视频导演");
    expect(result.message.body).toContain("开头再短两秒");
  });

  test("only a plain line of yours, where you can still write, can be changed", () => {
    const { store, bot, direct } = fixture();
    const botLine = store.insertMessage({ sessionId: direct, kind: "bot", author: bot.id, body: "好" });
    expect(refusal(() => edit(store, botLine.id, "不好"))).toEqual({ status: 422, code: "not_editable" });

    const stop = said(store, direct, "停下");
    store.markLineTaken(stop.id, "app");
    expect(store.getMessage(stop.id).taken_as).toBe("app");
    expect(refusal(() => edit(store, stop.id, "继续"))).toEqual({ status: 422, code: "not_editable" });

    const answer = said(store, direct, "用第二种");
    store.markLineTaken(answer.id, "answer");
    expect(refusal(() => edit(store, answer.id, "用第一种"))).toEqual({ status: 422, code: "not_editable" });
    // Sent on again as an ordinary line once you undid it: yours to change again.
    store.clearLineTaken(stop.id);
    expect(store.getMessage(stop.id).taken_as).toBeUndefined();

    const batch = said(store, direct, "按批注改");
    store.db.run(`UPDATE messages SET annotation_source_message_id = ? WHERE id = ?`, [botLine.id, batch.id]);
    expect(refusal(() => edit(store, batch.id, "别改了"))).toEqual({ status: 422, code: "not_editable" });

    const plain = said(store, direct, "加一段旁白");
    expect(refusal(() => edit(store, plain.id, "   "))).toEqual({ status: 422, code: "invalid_args" });
    expect(refusal(() => store.editMessage(plain.id, { body: 3, userActionId: "x" }))).toEqual({ status: 422, code: "invalid_args" });

    const writer = store.createBot({ name: "文案", duties: "写", boundaries: "none" });
    const room = store.createGroup({ name: "片场", members: [bot.id, writer.bot.id] });
    const inRoom = said(store, room.id, "都看一下第三镜");
    store.archiveSession(room.id);
    expect(refusal(() => edit(store, inRoom.id, "都看一下第四镜"))).toEqual({ status: 422, code: "not_editable" });
  });
});

describe("who hears of the change", () => {
  test("a Bot that has not read the line reads only the new words, whatever the copy carries around them", () => {
    const { store, bot, direct, job } = fixture();
    const opener = said(store, direct, "先出第一版", job.id);
    const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: opener.id, taskId: job.id });
    const line = said(store, direct, "第三镜换成夜景", job.id);
    // Written as the paths that make them do: the line heard as it is, heard elsewhere with its
    // files after it, a refile's note before it, and a note that does not carry it at all.
    const copies = ["第三镜换成夜景", "第三镜换成夜景\n附件：inbox/ref.png", "这句改归到 宣传片：第三镜换成夜景", "（应用）别的说法"].map((body, at) =>
      store.db
        .query<{ seq: number }, Array<string | number>>(
          `INSERT INTO inbox_items (id, bot_id, session_id, turn_id, task_id, message_id, author, body_snapshot, source, kind, priority, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, 'change', 1, 'queued', ?) RETURNING seq`,
        )
        .get(`copy-${at}`, bot.id, direct, turn.id, job.id, line.id, body, at >= 2 ? "system" : "user", new Date().toISOString())!);
    edit(store, line.id, "第三镜换成雨夜");
    const words = new Map(copies.map((row) => [row.seq, store.getInboxItem(row.seq)!.body_snapshot] as const));
    expect(words.get(copies[0]!.seq)).toBe("第三镜换成雨夜");
    expect(words.get(copies[1]!.seq)).toBe("第三镜换成雨夜\n附件：inbox/ref.png");
    expect(words.get(copies[2]!.seq)).toBe("这句改归到 宣传片：第三镜换成雨夜");
    // A copy the old words neither open nor close is left alone, and its Bot is told instead.
    expect(words.get(copies[3]!.seq)).toBe("（应用）别的说法");
    const told = corrections(store, line.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ bot_id: bot.id, turn_id: turn.id, state: "queued" });
  });

  test("a Bot that read the line in a turn still working is told at that turn's next step, as a line of yours", () => {
    const { store, bot, direct, job } = fixture();
    const opener = said(store, direct, "先出第一版", job.id);
    const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: opener.id, taskId: job.id });
    const line = said(store, direct, "片长 30 秒", job.id);
    const heard = store.queueInboxItem({
      botId: bot.id, sessionId: direct, turnId: turn.id, taskId: job.id, ticketId: null, messageId: line.id, author: "user",
      body: line.body, source: "user", kind: "change", priority: 1,
    });
    store.deliverInboxItems([heard.seq], turn.id, 1);
    const result = edit(store, line.id, "片长 45 秒");
    expect(result.told).toBe(1);
    const [told] = corrections(store, line.id);
    expect(told).toMatchObject({ bot_id: bot.id, turn_id: turn.id, state: "queued", source: "user", kind: "change", priority: 1,
      author: "user", edit_id: result.edit!.id });
    expect(told!.body_snapshot).toBe(correctionBody("zh", "片长 45 秒", "片长 30 秒"));
    expect(told!.body_snapshot.indexOf("片长 45 秒")).toBeLessThan(told!.body_snapshot.indexOf("片长 30 秒"));
    // Read at the next step with the rest of what came in; the bubble's own delivery state is the line's.
    expect(store.queuedForTurn(turn.id).map((row) => row.seq)).toContain(told!.seq);
    expect(store.getMessage(line.id).delivery).toMatchObject({ state: "delivered", hop: 1 });
  });

  test("a Bot whose turn on it ended is told by work queued on the job, which the next turn opens on", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id });
    store.setTurnStatus(turn.id, "completed");
    edit(store, line.id, "片长 45 秒");
    const [told] = corrections(store, line.id);
    expect(told).toMatchObject({ bot_id: bot.id, turn_id: null, state: "queued" });
    expect(told!.work_item_id).toBeTruthy();
    const work = store.db.query<{ state: string; task_id: string }, [string]>(`SELECT state, task_id FROM work_items WHERE id = ?`).get(told!.work_item_id!);
    expect(work).toEqual({ state: "queued", task_id: job.id });
    expect(store.dispatchableWork().map((row) => [row.id, row.message_id])).toContainEqual([told!.work_item_id, line.id]);
  });

  test("a stop holds the change until it lifts, and a read-only answer under a stop is no reader", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    const answering = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id, mode: "readonly" });
    expect(answering.mode).toBe("readonly");
    edit(store, line.id, "片长 40 秒");
    expect(corrections(store, line.id)).toHaveLength(0);

    const work = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id });
    store.setTurnStatus(work.id, "completed");
    store.createHold({ scope: "bot", scopeId: bot.id, source: "user_button" });
    edit(store, line.id, "片长 45 秒");
    expect(corrections(store, line.id).map((row) => row.state)).toEqual(["held"]);
  });

  test("a second change the Bot has not read yet rewrites the first note, against what it last read", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id });
    edit(store, line.id, "片长 45 秒");
    edit(store, line.id, "片长 60 秒");
    const told = corrections(store, line.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ turn_id: turn.id });
    expect(told[0]!.body_snapshot).toBe(correctionBody("zh", "片长 60 秒", "片长 30 秒"));
  });

  test("a turn opened after the change read the new words, and nobody is told twice", () => {
    const { store, bot, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    edit(store, line.id, "片长 45 秒");
    expect(corrections(store, line.id)).toHaveLength(0);
    store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: line.id, taskId: job.id });
    // A second change reaches it, once.
    const result = edit(store, line.id, "片长 60 秒");
    expect(result.told).toBe(1);
    expect(corrections(store, line.id)).toHaveLength(1);
  });

  test("clearing the conversation takes the line's history with the transcript and keeps your words", () => {
    const { store, direct, job } = fixture();
    const line = said(store, direct, "片长 30 秒", job.id);
    edit(store, line.id, "片长 45 秒");
    store.clearSessionMessages(direct);
    expect(store.db.query(`SELECT 1 FROM message_edits WHERE message_id = ?`).get(line.id)).toBeNull();
    const kept = store.listQuotes({ taskId: job.id }).map((quote) => quote.body);
    expect(kept).toEqual(["片长 30 秒", "片长 45 秒"]);
  });
});

describe("the words in a copy", () => {
  test("are swapped where the old ones open or close it, and nowhere else", () => {
    expect(swapWords("片长 30 秒", "片长 30 秒", "片长 45 秒")).toBe("片长 45 秒");
    expect(swapWords("片长 30 秒\n附件：inbox/a.png", "片长 30 秒", "片长 45 秒")).toBe("片长 45 秒\n附件：inbox/a.png");
    expect(swapWords("这句改归到 X：片长 30 秒", "片长 30 秒", "片长 45 秒")).toBe("这句改归到 X：片长 45 秒");
    expect(swapWords("别的", "片长 30 秒", "片长 45 秒")).toBeNull();
  });

  test("a correction puts the new words first and cuts a long old version", () => {
    const long = "旧".repeat(700);
    const body = correctionBody("en", "new words", long);
    expect(body.startsWith("You changed this line. It now reads: “new words”")).toBe(true);
    expect(body).toContain("…");
    expect(body.length).toBeLessThan(700);
  });
});
