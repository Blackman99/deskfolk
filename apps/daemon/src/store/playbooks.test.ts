import { afterEach, describe, expect, test } from "bun:test";
import { builtinPlaybook, type ClientEvent } from "@real-bot/protocol";
import { Store } from ".";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "Director", duties: "film", boundaries: "none" });
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const group = store.createGroup({ name: "MV", members: [director.bot.id, writer.bot.id] });
  return { store, director: director.bot, writer: writer.bot, direct: director.direct_session, group };
}

describe("engines", () => {
  test("three built-ins, 通用 the default, none changed", () => {
    const { store } = fixture();
    const list = store.listPlaybooks();
    expect(list.default_id).toBe("general");
    expect(list.items.map((item) => [item.id, item.builtin, item.revision, item.revision_id])).toEqual([
      ["general", true, 0, null],
      ["video", true, 0, null],
      ["coding", true, 0, null],
    ]);
    expect(list.items[1]!.resolved).toEqual(builtinPlaybook("video"));
    expect(store.settingsCached().default_playbook).toBe("general");
  });

  test("a change is a revision of its own: only what differs is kept, a stale one is refused, a step resets", () => {
    const { store } = fixture();
    const first = store.savePlaybook("video", { diff: { v: 1, steps: { settle: { params: { quiet_s: 120 } }, scribe: { on: false } } } });
    expect(first).toMatchObject({ revision: 1, diff: { steps: { settle: { params: { quiet_s: 120 } }, scribe: { on: false } } } });
    expect(first.resolved.settle.params.quiet_s).toBe(120);
    expect(first.resolved.scribe.on).toBe(false);
    // Saying the built-in's own value keeps nothing for it.
    const same = store.savePlaybook("video", { diff: { steps: { settle: { params: { quiet_s: 120 } }, scribe: { on: false }, intake: { params: { cap_s: builtinPlaybook("video").intake.params.cap_s! } } } }, ifRevision: first.revision_id });
    expect(same.revision).toBe(1);
    expect(() => store.savePlaybook("video", { diff: { steps: {} }, ifRevision: null })).toThrow("changed since you opened it");
    const reset = store.resetPlaybook("video", { step: "scribe", ifRevision: first.revision_id });
    expect(reset).toMatchObject({ revision: 2, diff: { steps: { settle: { params: { quiet_s: 120 } } } } });
    expect(store.listPlaybookRevisions("video").map((row) => [row.revision, row.op, row.actor])).toEqual([[2, "reset", "user"], [1, "edit", "user"]]);
    expect(store.listPlaybookRevisions("video")[1]!.before).toEqual({ name: null, diff: { v: 1, steps: {} } });
  });

  test("a diff names known steps and numbers only, switches off only what may be, and keeps numbers in range", () => {
    const { store } = fixture();
    expect(() => store.savePlaybook("general", { diff: { steps: { nonsense: {} } } })).toThrow("unknown step: nonsense");
    expect(() => store.savePlaybook("general", { diff: { steps: { reader: { on: false } } } })).toThrow("cannot be switched off");
    expect(() => store.savePlaybook("general", { diff: { steps: { settle: { params: { quiet_s: 5 } } } } })).toThrow("from 10 to 600");
    expect(() => store.savePlaybook("general", { diff: { steps: { settle: { params: { loud: 5 } } } } })).toThrow("unknown number loud");
    expect(() => store.savePlaybook("general", { diff: { steps: { pacing: { params: { check_in_hops: 200, hop_limit: 150 } } } } })).toThrow("below pacing.hop_limit");
    expect(() => store.savePlaybook("nobody", { diff: { steps: {} } })).toThrow("no such engine");
  });

  test("a custom engine starts from another's changes, can be renamed, and once removed its conversations follow the default", () => {
    const { store, group } = fixture();
    store.savePlaybook("video", { diff: { steps: { escalation: { on: false } } } });
    const mine = store.createPlaybook({ from: "video", name: "  我的 视频 " });
    expect(mine).toMatchObject({ builtin: false, base_id: "video", name: "我的 视频", revision: 1, diff: { steps: { escalation: { on: false } } } });
    expect(store.renamePlaybook(mine.id, { name: "MV 专用", ifRevision: mine.revision_id })).toMatchObject({ name: "MV 专用", revision: 2 });
    expect(() => store.renamePlaybook("video", { name: "x" })).toThrow("keeps its name");
    store.setSessionPlaybook(group.id, mine.id);
    store.patchSettingsSync({ default_playbook: mine.id });
    expect(() => store.deletePlaybook(mine.id)).toThrow("is the default");
    store.patchSettingsSync({ default_playbook: "coding" });
    store.deletePlaybook(mine.id);
    expect(store.listPlaybooks().items.map((item) => item.id)).toEqual(["general", "video", "coding"]);
    expect(store.getSession(group.id).playbook_id).toBeNull();
    expect(() => store.getPlaybook(mine.id)).toThrow("no such engine");
    expect(() => store.patchSettingsSync({ default_playbook: "gone" })).toThrow("no such engine");
  });

  test("which engine a call runs under: the job's conversation, else the conversation (or where it came from), else the default", () => {
    const { store, director, direct, group } = fixture();
    expect(store.playbookFor({ sessionId: direct.id })).toMatchObject({ id: "general", revision: 0 });
    store.patchSettingsSync({ default_playbook: "coding" });
    expect(store.playbookFor({ sessionId: direct.id }).id).toBe("coding");
    store.setSessionPlaybook(group.id, "video");
    expect(store.playbookFor({ sessionId: group.id }).id).toBe("video");
    // A job opened in the group runs the group's engine even when its line is said in the direct.
    const plan = store.openTask({ sessionId: group.id, title: "MV" });
    expect(store.playbookFor({ sessionId: direct.id, taskId: plan.id }).id).toBe("video");
    const line = store.postMessage(direct.id, { body: "接着做" });
    const turn = store.createTurn({ sessionId: direct.id, botId: director.id, triggerMessageId: line.id, taskId: plan.id });
    expect(store.playbookFor({ turnId: turn.id }).id).toBe("video");
    // A Bot↔Bot direct opened from the group runs the group's.
    store.db.run("UPDATE sessions SET origin_session_id = ? WHERE id = ?", [group.id, direct.id]);
    expect(store.playbookFor({ sessionId: direct.id }).id).toBe("video");
    // Your change shows in what runs, with its revision.
    store.savePlaybook("video", { diff: { steps: { settle: { params: { quiet_s: 90 } } } } });
    expect(store.playbookFor({ sessionId: group.id })).toMatchObject({ id: "video", revision: 1, resolved: { settle: { params: { quiet_s: 90 } } } });
    expect(store.playbookParam({ sessionId: group.id }, "settle", "quiet_s")).toBe(90);
  });

  test("a call record carries the engine it ran under; a new Bot's direct and a new group can name theirs", () => {
    const { store, director, writer } = fixture();
    const made = store.createBot({ name: "Editor", duties: "cut", boundaries: "none", playbook_id: "video" });
    expect(made.direct_session.playbook_id).toBe("video");
    const room = store.createGroup({ name: "Code", members: [director.id, writer.id], playbook_id: "coding" });
    expect(room.playbook_id).toBe("coding");
    expect(() => store.createGroup({ name: "x", members: [director.id, writer.id], playbook_id: "nope" })).toThrow("no such engine");
    expect(() => store.createBot({ name: "Hire", duties: "x", boundaries: "x", playbook_id: "video" }, director.id)).toThrow("only the user chooses");
    const run = store.recordCallRun({ role: "scribe", sessionId: made.direct_session.id, outcome: "ok", verdict: null });
    expect(run).toMatchObject({ playbook_id: "video", playbook_revision: 0 });
    expect(store.getCallRun(run.id)).toMatchObject({ playbook_id: "video", playbook_revision: 0 });
  });

  test("a change to an engine is published as playbook.changed", () => {
    const { store } = fixture();
    const events: ClientEvent[] = [];
    store.onCommit((event) => events.push(event));
    store.savePlaybook("coding", { diff: { steps: { scribe: { on: false } } } });
    expect(events.filter((event) => event.event === "playbook.changed")).toEqual([
      { event: "playbook.changed", occurred_at: expect.any(String), id: "coding", default_id: "general" },
    ]);
  });
});
