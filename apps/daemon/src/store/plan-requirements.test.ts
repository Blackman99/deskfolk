/**
 * The requirements ledger as a plan sees it (ADR 0040 P3): the board's rules and Done-when lines
 * written in as ledger operations, what a plan inherits from its conversation and can set aside,
 * your confirm / reject / waive / widen, the old rules taken in once, the cards' due lists, and
 * the board's 「上次变化」.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientEvent, PlanRequirement, TaskDetail } from "@real-bot/protocol";
import { LEGACY_IMPORTED_KEY, Store, type PlanSpec } from ".";
import { REQUIREMENT_SUPERSEDE_ABORT } from "./requirements";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return { kind: null, goal: "EP01 动画成片", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active", ...over };
}

/** The video group, with EP01 opened in it; later plans of the group open with `plan`. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plan-requirements-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" }).bot;
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "AI影视创作组", members: [director.id, reviewer.id] }).id;
  const plan = (title: string, over: Partial<PlanSpec> = {}, sessionId = room) => store.openTask({ sessionId, title, spec: spec({ goal: title, ...over }) });
  const ep01 = plan("EP01 动画成片");
  /** A line of yours in the plan's conversation, filed under the plan, and the quote it was kept as. */
  const say = (taskId: string, body: string) => {
    const line = store.postMessage(store.getTask(taskId).session_id!, { body });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, line.id]);
    return store.quoteOfMessage(line.id, "message")!;
  };
  /** A video the director handed over in the plan: what makes it video work. */
  const deliver = (taskId: string, name: string) => {
    writeFileSync(join(root, name), "mp4");
    const line = store.insertMessage({ sessionId: store.getTask(taskId).session_id!, kind: "bot", author: director.id, body: `交了 ${name}`, paths: [name] });
    store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, line.id]);
  };
  /** Another group, with the same two Bots. */
  const group = (name: string) => store.createGroup({ name, members: [director.id, reviewer.id] }).id;
  return { store, room, director, ep01, plan, say, deliver, group };
}

describe("the board's rules and Done-when lines are ledger operations", () => {
  test("a line you add is an entry on its board quote; one you take out is waived; each names the version you made", () => {
    const { store, ep01 } = fixture();
    const { revision: added } = store.setPlanSpecByUser(ep01.id, spec({ acceptance: ["母带放在 deliverables/"], rules: ["标题别太长"] }));
    const [where, title] = store.listRequirements();
    expect(store.listWorkEvents({ kind: "requirement.add" }).map((row) => row.payload)).toMatchObject([
      { requirement: where!.id, source_kind: "board", action: added.id },
      { requirement: title!.id, source_kind: "board", action: added.id },
    ]);
    expect([where, title].map((entry) => [entry!.quote, entry!.source_kind, entry!.scope, entry!.scope_id, entry!.added_by, entry!.origin_task_id, entry!.status])).toEqual([
      ["母带放在 deliverables/", "board", "plan", ep01.id, "user", ep01.id, "open"],
      ["标题别太长", "board", "plan", ep01.id, "user", ep01.id, "open"],
    ]);
    expect(store.getQuote(title!.source_quote_id!)).toMatchObject({ via: "board", body: "标题别太长", task_id: ep01.id });

    const { revision } = store.setPlanSpecByUser(ep01.id, spec({ acceptance: ["母带放在 deliverables/"] }));
    expect(store.getRequirement(title!.id).status).toBe("waived");
    expect(store.getRequirement(where!.id).status).toBe("open");
    expect(store.listWorkEvents({ kind: "requirement.waive" })).toMatchObject([
      { actor: "user", task_id: ep01.id, payload: { requirement: title!.id, task: ep01.id, action: revision.id } },
    ]);
    store.close();
  });

  test("a line with words already in force is said again, and one that was only an old rule is taken up; taken out again, each goes", () => {
    const { store, ep01, say } = fixture();
    const quote = say(ep01.id, "片长约 2 分钟");
    const said = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "片长约 2 分钟", sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe" });
    const old = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "仓门朝左开", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    const { revision } = store.setPlanSpecByUser(ep01.id, spec({ acceptance: ["片长约 2 分钟"], rules: ["仓门朝左开"] }));
    expect(store.listRequirements()).toHaveLength(2);
    expect(store.getRequirement(said.id).times_raised).toBe(2);
    expect(store.getRequirement(old.id)).toMatchObject({ status: "open", times_raised: 2 });
    expect(store.listWorkEvents({ kind: "requirement.confirm" })).toMatchObject([{ payload: { requirement: old.id, action: revision.id } }]);
    expect(store.listWorkEvents({ kind: "requirement.raise" }).map((row) => row.payload)).toMatchObject([
      { requirement: said.id, action: revision.id },
      { requirement: old.id, action: revision.id },
    ]);

    // The line said again on the board goes out of force when you take it out, whoever first wrote the entry down.
    store.setPlanSpecByUser(ep01.id, spec());
    expect([said, old].map((entry) => store.getRequirement(entry.id).status)).toEqual(["waived", "waived"]);
    store.close();
  });

  test("taking a line of the whole conversation's off the only board that had it lets it go: a later film inherits nothing", () => {
    const { store, ep01, plan, deliver } = fixture();
    // Before the ledger, EP01 (a video job) had the line typed on its board.
    deliver(ep01.id, "EP01_MASTER.mp4");
    store.setPlanSpecByUser(ep01.id, spec({ rules: ["背景要连贯"] }));
    store.purgeRequirements(store.listRequirements().map((entry) => entry.id));
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
    store.importLegacyRules();
    const [continuity] = store.listRequirements();
    expect(continuity).toMatchObject({ scope: "project", origin_task_id: ep01.id, status: "open" });
    const ep05 = plan("EP05 动画成片");
    expect(store.planRequirements(ep05.id)).toMatchObject([{ id: continuity!.id, inherited_from: { task_id: ep01.id } }]);

    const { revision } = store.setPlanSpecByUser(ep01.id, spec({ rules: [] }));
    expect(store.getRequirement(continuity!.id).status).toBe("waived");
    expect(store.planRequirements(ep05.id)).toEqual([]);
    expect(store.listWorkEvents({ kind: "requirement.waive" })).toMatchObject([{ payload: { requirement: continuity!.id, task: ep01.id, action: revision.id } }]);
    expect(store.listWorkEvents({ kind: "requirement.not_here" })).toEqual([]);
    store.close();
  });

  test("an old rule the organizer wrote, taken off the only board that had it, is no requirement: no later film is asked about it", () => {
    const { store, ep01, plan, deliver } = fixture();
    deliver(ep01.id, "EP01_MASTER.mp4");
    store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(spec({ rules: ["每次过门都要有过渡镜头"] })), ep01.id]);
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
    store.importLegacyRules();
    const [transition] = store.listRequirements();
    expect(transition).toMatchObject({ scope: "project", status: "unverified", origin_task_id: ep01.id });
    const ep02 = plan("EP02 动画成片");
    expect(store.legacyCardDue(ep02.id)).toEqual([transition!.id]);

    const { revision } = store.setPlanSpecByUser(ep01.id, spec({ rules: [] }));
    expect(store.getRequirement(transition!.id).status).toBe("not_requirement");
    expect(store.legacyCardDue(ep02.id)).toEqual([]);
    expect(store.planRequirements(ep02.id)).toEqual([]);
    expect(store.listWorkEvents({ kind: "requirement.reject" })).toMatchObject([{ payload: { requirement: transition!.id, task: ep01.id, action: revision.id } }]);
    store.close();
  });

  test("an old rule two films' boards had: taken off the first, the other board still holds it; taken off the last, it is no requirement", () => {
    const { store, ep01, plan, deliver } = fixture();
    const ep02 = plan("EP02 动画成片");
    for (const film of [ep01, ep02]) {
      deliver(film.id, `${film.title.slice(0, 4)}_MASTER.mp4`);
      store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(spec({ goal: film.title, rules: ["每次过门都要有过渡镜头"] })), film.id]);
    }
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
    store.importLegacyRules();
    const [transition] = store.listRequirements();
    expect(store.listRequirements()).toHaveLength(1);
    expect(transition).toMatchObject({ scope: "project", status: "unverified", origin_task_id: ep01.id });

    // Off EP01's board, the film it was first taken in from: EP02's board still has it.
    store.setPlanSpecByUser(ep01.id, spec({ rules: [] }));
    expect(store.getRequirement(transition!.id).status).toBe("unverified");
    expect(store.planRequirements(ep01.id)).toMatchObject([{ id: transition!.id, excluded: true }]);
    const ep03 = plan("EP03 动画成片");
    expect(store.legacyCardDue(ep03.id)).toEqual([transition!.id]);

    // Off EP02's too: no board has it any more, and nobody said it.
    store.setPlanSpecByUser(ep02.id, spec({ goal: ep02.title, rules: [] }));
    expect(store.getRequirement(transition!.id).status).toBe("not_requirement");
    expect(store.legacyCardDue(ep03.id)).toEqual([]);
    store.close();
  });

  test("while another film still holds the words — you said them there, or you widened the entry yourself — taking the line out sets it aside here only", () => {
    const { store, ep01, plan, say } = fixture();
    const first = say(ep01.id, "每次过门都要有过渡镜头");
    const transition = store.addRequirement({ scope: "project", scopeId: ep01.session_id, quote: "每次过门都要有过渡镜头", sourceKind: "message", sourceQuoteId: first.id, addedBy: "scribe" });
    // EP02 typed it on its board (said again there), then took it out: EP01 said it, and keeps it.
    const ep02 = plan("EP02 动画成片");
    store.setPlanSpecByUser(ep02.id, spec({ goal: ep02.title, rules: ["每次过门都要有过渡镜头"] }));
    store.setPlanSpecByUser(ep02.id, spec({ goal: ep02.title, rules: [] }));
    expect(store.getRequirement(transition.id).status).toBe("open");
    expect(store.planRequirements(ep02.id)).toMatchObject([{ id: transition.id, excluded: true }]);
    expect(store.planRequirements(ep01.id)).toMatchObject([{ id: transition.id, excluded: false }]);

    // Once EP01 has set it aside too, the next film that types it and takes it out held it last: it goes.
    store.setRequirementHere(transition.id, { taskId: ep01.id, holds: false });
    const ep03 = plan("EP03 动画成片");
    store.setPlanSpecByUser(ep03.id, spec({ goal: ep03.title, rules: ["每次过门都要有过渡镜头"] }));
    store.setPlanSpecByUser(ep03.id, spec({ goal: ep03.title, rules: [] }));
    expect(store.getRequirement(transition.id).status).toBe("waived");

    // A board line you widened to the whole conversation yourself holds for the others by your own click.
    store.setPlanSpecByUser(ep01.id, spec({ rules: ["标题别太长"] }));
    const title = store.listRequirements().find((entry) => entry.quote === "标题别太长")!;
    store.widenRequirement(title.id, { to: "project", taskId: ep01.id });
    store.setPlanSpecByUser(ep01.id, spec({ rules: [] }));
    expect(store.getRequirement(title.id).status).toBe("open");
    expect(store.planRequirements(ep01.id).find((entry) => entry.id === title.id)).toMatchObject({ excluded: true });
    expect(store.planRequirements(ep02.id).find((entry) => entry.id === title.id)).toMatchObject({ excluded: false });
    store.close();
  });

  test("taking out a line another plan's entry stands for sets it aside here, whether the old rules were taken in as it or your line said it again", () => {
    const { store, ep01, plan, deliver } = fixture();
    // Before the ledger, both films of the group had the line typed on their boards.
    const ep02 = plan("EP02 动画成片");
    deliver(ep01.id, "EP01_MASTER.mp4");
    deliver(ep02.id, "EP02_MASTER.mp4");
    for (const film of [ep01, ep02]) store.setPlanSpecByUser(film.id, spec({ goal: film.title, rules: ["背景要连贯"] }));
    store.purgeRequirements(store.listRequirements().map((entry) => entry.id));
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
    store.importLegacyRules();
    const [continuity] = store.listRequirements();
    expect(store.listRequirements()).toHaveLength(1);
    expect(continuity).toMatchObject({ scope: "project", origin_task_id: ep01.id, status: "open" });

    const { revision } = store.setPlanSpecByUser(ep02.id, spec({ goal: ep02.title, rules: [] }));
    expect(store.planRequirements(ep02.id)).toMatchObject([{ id: continuity!.id, excluded: true }]);
    expect(store.planRequirements(ep01.id)).toMatchObject([{ id: continuity!.id, excluded: false, status: "open" }]);
    expect(store.listWorkEvents({ kind: "requirement.not_here" })).toMatchObject([{ payload: { requirement: continuity!.id, task: ep02.id, action: revision.id } }]);

    // A third film types the line: the conversation's entry, said again; taken out, it is set aside there too.
    const ep03 = plan("EP03 动画成片");
    store.setPlanSpecByUser(ep03.id, spec({ goal: ep03.title, rules: ["背景要连贯"] }));
    expect(store.listRequirements()).toHaveLength(1);
    expect(store.getRequirement(continuity!.id).times_raised).toBeGreaterThanOrEqual(2);
    store.setPlanSpecByUser(ep03.id, spec({ goal: ep03.title, rules: [] }));
    expect(store.planRequirements(ep03.id)).toMatchObject([{ id: continuity!.id, excluded: true }]);
    expect(store.getRequirement(continuity!.id).status).toBe("open");

    // Typed on EP02's board again: it holds there again, not as a second entry.
    store.setPlanSpecByUser(ep02.id, spec({ goal: ep02.title, rules: ["背景要连贯"] }));
    expect(store.listRequirements()).toHaveLength(1);
    expect(store.planRequirements(ep02.id)).toMatchObject([{ id: continuity!.id, excluded: false }]);
    store.close();
  });
});

describe("what a plan sees", () => {
  test("its own entries, and its conversation's inherited from the plan that set them, with where and how often you said each", () => {
    const { store, ep01, plan, say } = fixture();
    const first = say(ep01.id, "每次过门都要有过渡镜头");
    const transition = store.addRequirement({ scope: "project", scopeId: ep01.session_id, quote: "每次过门都要有过渡镜头", sourceKind: "message", sourceQuoteId: first.id, addedBy: "scribe" });
    const own = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "C09 脚不能穿地", sourceKind: "board", addedBy: "user" });
    const next = plan("9AG7 未来世界短片");
    const again = say(next.id, "还是那句，每次过门都要有过渡镜头");
    store.raiseRequirement(transition.id, { quoteId: again.id, actor: "scribe" });

    expect(store.planRequirements(ep01.id).map((entry) => entry.id)).toEqual([transition.id, own.id]);
    const [seen] = store.planRequirements(next.id);
    expect(seen).toMatchObject({
      id: transition.id,
      seq: transition.seq,
      quote: "每次过门都要有过渡镜头",
      status: "open",
      scope: "project",
      times_raised: 2,
      plans_raised: 2,
      source: { via: "message", session_id: ep01.session_id, message_id: first.message_id },
      inherited_from: { task_id: ep01.id, title: "EP01 动画成片" },
      excluded: false,
    });
    expect(store.planRequirements(next.id)).toHaveLength(1);

    // Not for this job: set aside here, still in force for EP01, and the scribe no longer weighs it here.
    store.setRequirementHere(transition.id, { taskId: next.id, holds: false });
    expect(store.planRequirements(next.id)).toMatchObject([{ id: transition.id, excluded: true }]);
    expect(store.openRequirementsFor(next.id, 60)).toEqual([]);
    expect(store.planRequirements(ep01.id)[0]).toMatchObject({ id: transition.id, excluded: false });
    store.setRequirementHere(transition.id, { taskId: next.id, holds: true });
    expect(store.planRequirements(next.id)).toMatchObject([{ excluded: false }]);
    expect(store.listWorkEvents().filter((row) => row.kind.startsWith("requirement.") && row.kind.includes("here")).map((row) => row.kind)).toEqual([
      "requirement.not_here",
      "requirement.here_again",
    ]);
    // A plan's own entry is let go, not set aside.
    expect(() => store.setRequirementHere(own.id, { taskId: ep01.id, holds: false })).toThrow();
    store.close();
  });

  test("a standing entry holds for the plans of its kind of work, known by what was done in them", () => {
    const { store, ep01, plan, deliver } = fixture();
    const standing = store.addRequirement({ scope: "standing", scopeId: null, domain: "video", quote: "不用冻帧补时长", sourceKind: "board", addedBy: "user", originTaskId: ep01.id });
    const report = plan("写一份周报");
    expect(store.planRequirements(report.id)).toEqual([]);
    deliver(report.id, "EP02_MASTER.mp4");
    expect(store.planDomains(report.id)).toEqual(["video"]);
    expect(store.planRequirements(report.id)).toMatchObject([{ id: standing.id, scope: "standing", inherited_from: { task_id: ep01.id } }]);
    store.close();
  });
});

describe("your choices on an entry", () => {
  test("confirm and reject take up or turn down what is proposed or unverified; waive and widen act on what is in force", () => {
    const { store, ep01 } = fixture();
    const old = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "标题别太长", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    const made = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "按用户要求接着做", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    expect(store.confirmRequirement(old.id, { taskId: ep01.id }).status).toBe("open");
    expect(store.rejectRequirement(made.id, { taskId: ep01.id }).status).toBe("not_requirement");
    expect(() => store.confirmRequirement(old.id, { taskId: ep01.id })).toThrow("this requirement is open now");
    expect(() => store.waiveRequirement(made.id, { taskId: ep01.id })).toThrow("this requirement is not_requirement now");

    const widened = store.widenRequirement(old.id, { to: "project", taskId: ep01.id });
    expect(widened).toMatchObject({ scope: "project", scope_id: ep01.session_id });
    expect(() => store.widenRequirement(old.id, { to: "project", taskId: ep01.id })).toThrow("only a plan's own entry");
    expect(store.widenRequirement(old.id, { to: "standing", taskId: ep01.id, domain: "video" })).toMatchObject({ scope: "standing", scope_id: null, domain: "video" });
    expect(store.waiveRequirement(old.id, { taskId: ep01.id }).status).toBe("waived");
    expect(store.listWorkEvents().filter((row) => row.kind.startsWith("requirement.") && row.kind !== "requirement.add").map((row) => [row.kind, row.actor])).toEqual([
      ["requirement.confirm", "user"],
      ["requirement.reject", "user"],
      ["requirement.rescope", "user"],
      ["requirement.rescope", "user"],
      ["requirement.waive", "user"],
    ]);
    store.close();
  });

  test("your confirm of a replacement supersedes the entry, even said again after the replacement's line; nothing else may", () => {
    const { store, ep01, say } = fixture();
    const first = say(ep01.id, "片长约 2 分钟");
    const running = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "片长约 2 分钟", sourceKind: "message", sourceQuoteId: first.id, addedBy: "scribe" });
    const change = say(ep01.id, "改成 3 分钟");
    const proposal = store.addRequirement({
      scope: "plan",
      scopeId: ep01.id,
      quote: "改成 3 分钟",
      sourceKind: "message",
      sourceQuoteId: change.id,
      addedBy: "scribe",
      status: "proposed",
      supersedes: running.id,
    });
    store.raiseRequirement(running.id, { quoteId: say(ep01.id, "还是约 2 分钟吧").id, actor: "scribe" });
    expect(() =>
      store.db.run(`UPDATE requirements SET status = 'superseded', superseded_by = ? WHERE id = ?`, [proposal.id, running.id]),
    ).toThrow(REQUIREMENT_SUPERSEDE_ABORT);

    store.confirmRequirement(proposal.id, { taskId: ep01.id });
    expect(store.getRequirement(proposal.id).status).toBe("open");
    expect(store.getRequirement(running.id)).toMatchObject({ status: "superseded", superseded_by: proposal.id });
    expect(store.listWorkEvents({ kind: "requirement.confirm" })).toMatchObject([{ payload: { requirement: proposal.id, replaced: running.id } }]);
    store.close();
  });
});

describe("the old rules, taken in once", () => {
  test("typed on the board: in force; found in your words: in force on them; the rest: unverified; craft for the whole conversation", () => {
    const { store, room, ep01, plan, say, deliver } = fixture();
    deliver(ep01.id, "EP01_MASTER.mp4");
    // Before the ledger: a rule you typed on the board, and lines the organizer wrote.
    store.setPlanSpecByUser(ep01.id, spec({ rules: ["标题别太长"] }));
    const typed = store.listQuotes({ taskId: ep01.id }).find((quote) => quote.via === "board")!;
    store.purgeRequirements(store.listRequirements().map((entry) => entry.id));
    const yours = say(ep01.id, "机械臂必须是左手，片长约2分钟");
    const organizers = ["标题别太长", "机械臂必须是左手", "C09 的脚不能穿地", "用户要求这条短片接着做完"];
    store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(spec({ rules: organizers, acceptance: ["片长约 2 分钟"] })), ep01.id]);
    // A later film of the group had the arm written in too, by the organizer alone.
    const kfen = plan("KFEN 从头重制");
    store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(spec({ goal: "KFEN 从头重制", rules: ["机械臂必须是左手"] })), kfen.id]);
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);

    const taken = store.importLegacyRules();
    const rows = store.listRequirements().map((entry) => [entry.quote, entry.status, entry.source_kind, entry.scope, entry.source_quote_id, entry.origin_task_id]);
    expect(rows).toEqual([
      ["标题别太长", "open", "board", "plan", typed.id, ep01.id],
      ["机械臂必须是左手", "open", "legacy", "project", yours.id, ep01.id],
      ["片长约 2 分钟", "open", "legacy", "plan", yours.id, ep01.id],
      ["C09 的脚不能穿地", "unverified", "legacy", "plan", null, ep01.id],
      ["用户要求这条短片接着做完", "unverified", "legacy", "plan", null, ep01.id],
    ]);
    expect(taken).toHaveLength(5);
    expect(store.listRequirements().every((entry) => entry.added_by === "import")).toBe(true);
    expect(store.listRequirements()[1]!.scope_id).toBe(room);
    expect(store.listWorkEvents({ kind: "requirement.import" })).toMatchObject([{ payload: { requirements: taken } }]);
    // KFEN (no video yet) inherits the arm rather than holding an unverified copy of it.
    expect(store.planRequirements(kfen.id).map((entry) => [entry.quote, entry.status])).toEqual([["机械臂必须是左手", "open"]]);

    // Once: a second call, or the next open, takes in nothing.
    expect(store.importLegacyRules()).toEqual([]);
    expect(store.listRequirements()).toHaveLength(5);
    store.close();
  });

  test("in a job that made no video, a line that sounds like craft stays with its plan", () => {
    const { store, room, plan } = fixture();
    const report = plan("写一份季度报告");
    store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(spec({ goal: "写一份季度报告", rules: ["段落之间要有过渡"] })), report.id]);
    store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
    store.importLegacyRules();
    expect(store.listRequirements().map((entry) => [entry.quote, entry.scope, entry.scope_id])).toEqual([["段落之间要有过渡", "plan", report.id]]);
    expect(store.planRequirements(plan("下一份报告").id)).toEqual([]);
    expect(room).toBeTruthy();
    store.close();
  });

  test("the old rules no card has asked about are due once; a card for them clears the list", () => {
    const { store, ep01, plan } = fixture();
    const old = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "按用户要求接着做", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "一条待确认的抱怨", sourceKind: "board", addedBy: "capture", status: "proposed" });
    expect(store.legacyCardDue(ep01.id)).toEqual([old.id]);
    expect(store.legacyCardDue(plan("另一件事").id)).toEqual([]);
    store.recordRequirementCard({ card: "legacy", requirements: [old.id], messageId: "m1", taskId: ep01.id });
    expect(store.legacyCardDue(ep01.id)).toEqual([]);
    store.close();
  });
});

describe("the standing suggestion", () => {
  /** An entry the scribe wrote down from a line of yours in the plan. */
  function noted(
    { store, say }: ReturnType<typeof fixture>,
    taskId: string,
    words: string,
    category: string,
    scope: "project" | "plan" | "ticket" = "project",
    ticketId?: string,
  ) {
    const task = store.getTask(taskId);
    const scopeId = scope === "project" ? task.session_id : scope === "plan" ? taskId : ticketId!;
    return store.addRequirement({ scope, scopeId, quote: words, category, sourceKind: "message", sourceQuoteId: say(taskId, words).id, addedBy: "scribe" });
  }

  test("a craft category raised in two video jobs of the conversation is suggested once; one job, or one that is no video, is not", () => {
    const h = fixture();
    const { store, ep01, plan, say, deliver } = h;
    const continuity = noted(h, ep01.id, "背景要连贯", "背景连贯");
    const next = plan("9AG7 未来世界短片");
    expect(store.standingSuggestion(ep01.id, [continuity.id])).toBeNull();
    store.raiseRequirement(continuity.id, { quoteId: say(next.id, "前后背景要连贯").id, actor: "scribe" });
    expect(store.standingSuggestion(next.id, [continuity.id])).toBeNull();
    deliver(next.id, "9AG7_MASTER.mp4");
    // EP01 made no video yet: one video job so far.
    expect(store.standingSuggestion(next.id, [continuity.id])).toBeNull();
    deliver(ep01.id, "EP01_MASTER.mp4");
    expect(store.standingSuggestion(next.id, [continuity.id])).toEqual({ category: "背景连贯", domain: "video", requirements: [continuity.id], plans: 2, quotes: ["背景要连贯"], each: false });
    expect(store.mayMakeStanding(continuity.id, { taskId: next.id, category: "背景连贯" })).toBe(true);
    store.recordRequirementCard({ card: "standing", requirements: [continuity.id], category: "背景连贯", messageId: "m1", taskId: next.id });
    expect(store.standingSuggestion(next.id, [continuity.id])).toBeNull();
    store.close();
  });

  test("never a running time or a series' constant, nor another conversation's entries, nor a ticket's", () => {
    const h = fixture();
    const { store, ep01, plan, deliver, group } = h;
    const next = plan("9AG7 未来世界短片");
    deliver(ep01.id, "EP01_MASTER.mp4");
    deliver(next.id, "9AG7_MASTER.mp4");
    // 「片长约 2 分钟」 and 「片长 30 秒」 are one category, said about two video jobs: no craft, no card.
    const long = noted(h, ep01.id, "片长约 2 分钟", "时长", "plan");
    const short = noted(h, next.id, "片长 30 秒", "时长", "plan");
    expect(store.standingSuggestion(next.id, [short.id])).toBeNull();
    expect(store.mayMakeStanding(long.id, { taskId: next.id, category: "时长" })).toBe(false);
    // The arm is BEACON ZERO's: it holds for the group, never for every video job.
    const arm = noted(h, ep01.id, "机械臂必须是左手", "角色设定");
    store.raiseRequirement(arm.id, { quoteId: h.say(next.id, "机械臂必须是左手").id, actor: "scribe" });
    expect(store.standingSuggestion(next.id, [arm.id])).toBeNull();

    // The same craft category said in a video job of another group counts for that group only.
    const other = group("另一个组");
    const film = plan("别组的片子", {}, other);
    deliver(film.id, "OTHER_MASTER.mp4");
    const theirs = noted(h, film.id, "转场要有过渡镜头", "转场");
    const ours = noted(h, next.id, "每次过门都要有过渡镜头", "转场");
    expect(store.standingSuggestion(next.id, [ours.id])).toBeNull();
    expect(store.standingSuggestion(film.id, [theirs.id])).toBeNull();
    expect(store.mayMakeStanding(theirs.id, { taskId: next.id, category: "转场" })).toBe(false);

    // A ticket's entry is about one piece of the work: not counted, not widened.
    const ticket = store.createTicket({ taskId: ep01.id, title: "C09" });
    const shot = noted(h, ep01.id, "背景颜色要连贯", "背景连贯", "ticket", ticket.id);
    const continuity = noted(h, next.id, "背景要连贯", "背景连贯");
    expect(store.standingSuggestion(next.id, [continuity.id])).toBeNull();
    expect(store.mayMakeStanding(shot.id, { taskId: next.id, category: "背景连贯" })).toBe(false);
    store.close();
  });
});

describe("the standing suggestion, when what you asked differs", () => {
  function noted({ store, say }: ReturnType<typeof fixture>, taskId: string, words: string, category: string) {
    const task = store.getTask(taskId);
    return store.addRequirement({ scope: "project", scopeId: task.session_id, quote: words, category, sourceKind: "message", sourceQuoteId: say(taskId, words).id, addedBy: "scribe" });
  }

  test("a choice of look (EP01 cold, EP02 warm) is never offered: one click would make both hold for every film", () => {
    const h = fixture();
    const { store, ep01, plan, deliver } = h;
    const ep02 = plan("EP02 动画成片");
    deliver(ep01.id, "EP01_MASTER.mp4");
    deliver(ep02.id, "EP02_MASTER.mp4");
    const cold = noted(h, ep01.id, "色调偏冷", "色调");
    const warm = noted(h, ep02.id, "色调要暖", "色调");
    expect(store.standingSuggestion(ep02.id, [warm.id])).toBeNull();
    expect(store.standingSuggestion(ep01.id, [cold.id])).toBeNull();
    expect([cold, warm].map((entry) => store.mayMakeStanding(entry.id, { taskId: ep02.id, category: "色调" }))).toEqual([false, false]);
    store.close();
  });

  test("a craft category whose entries say different things is offered one entry at a time, each with its own words, once each", () => {
    const h = fixture();
    const { store, ep01, plan, deliver, say } = h;
    const ep02 = plan("EP02 动画成片");
    deliver(ep01.id, "EP01_MASTER.mp4");
    deliver(ep02.id, "EP02_MASTER.mp4");
    // Two films, one category by the scribe's label, two different asks: no card for the category.
    const steady = noted(h, ep01.id, "背景要连贯", "背景连贯");
    const noJump = noted(h, ep02.id, "背景不能跳变", "背景连贯");
    expect(store.standingSuggestion(ep02.id, [noJump.id])).toBeNull();

    // One of them said in both films: a card about that one alone.
    store.raiseRequirement(steady.id, { quoteId: say(ep02.id, "背景要连贯，别忘了").id, actor: "scribe" });
    const card = store.standingSuggestion(ep02.id, [steady.id]);
    expect(card).toEqual({ category: "背景连贯", domain: "video", requirements: [steady.id], plans: 2, quotes: ["背景要连贯"], each: true });
    store.recordRequirementCard({ card: "standing", requirements: [steady.id], category: "背景连贯", each: true, messageId: "m1", taskId: ep02.id });
    expect(store.standingSuggestion(ep02.id, [steady.id])).toBeNull();

    // The other one, said in both films later, still gets its own: the category was never asked as a whole.
    store.raiseRequirement(noJump.id, { quoteId: say(ep01.id, "背景不能跳变").id, actor: "scribe" });
    expect(store.standingSuggestion(ep01.id, [noJump.id])).toMatchObject({ requirements: [noJump.id], quotes: ["背景不能跳变"], each: true });
    store.close();
  });
});

describe("when the plan last changed", () => {
  test("the newest of its version, its tickets, its checks' runs, its turns and its requirements, said in words", () => {
    const { store, ep01 } = fixture();
    store.setPlanSpecByUser(ep01.id, spec());
    expect(store.taskDetail(ep01.id, () => true).last_change).toMatchObject({ what: "你改了要点" });
    // Minutes apart: the store's clock runs ahead of the wall's in bursts, and tickets keep the wall's.
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const ticket = store.createTicket({ taskId: ep01.id, title: "粗剪" });
    store.patchTicket(ticket.id, { status: "review" }, { now: later(1) });
    expect(store.taskDetail(ep01.id, () => true).last_change).toMatchObject({ what: "任务 01《粗剪》：待验收" });
    const entry = store.addRequirement({ scope: "plan", scopeId: ep01.id, quote: "标题别太长", sourceKind: "board", addedBy: "user" });
    store.db.run(`UPDATE work_events SET at = ? WHERE kind = 'requirement.add'`, [later(2).toISOString()]);
    expect(store.taskDetail(ep01.id, () => true).last_change).toMatchObject({ what: `记下要求 R-${entry.seq}` });
    store.patchSettingsSync({ locale: "en" });
    expect(store.taskDetail(ep01.id, () => true).last_change).toMatchObject({ what: `R-${entry.seq} written down` });
    store.close();
  });
});

describe("the board while a job never goes quiet", () => {
  // The future-world short (9AG7) ran 45 turns on September 29, 05:22 to 10:46, and its board never
  // got a new version: it only changed when the plan went quiet, which a long job never does. What
  // you ask of a job is now on its board the moment it is written down.
  test("each requirement written down or said again reaches the board in its own commit, with no settle and no new version", () => {
    const { store, room, plan, say } = fixture();
    const film = plan("9AG7 未来世界短片");
    const version = store.taskDetail(film.id, () => true).revision;
    const seen: ClientEvent[] = [];
    store.onCommit((event) => seen.push(event));
    /** The one board push the last write made for the film. */
    const board = (): { revision: number; requirements: PlanRequirement[] } => {
      const upserts = seen.filter((event) => event.event === "task.upsert" && event.id === film.id);
      expect(upserts).toHaveLength(1);
      seen.length = 0;
      const detail = upserts[0] as unknown as TaskDetail;
      return { revision: detail.revision, requirements: detail.requirements ?? [] };
    };

    const backdrop = say(film.id, "背景要连贯");
    seen.length = 0;
    const entry = store.addRequirement({ scope: "plan", scopeId: film.id, quote: "背景要连贯", sourceKind: "message", sourceQuoteId: backdrop.id, addedBy: "scribe" });
    expect(board().requirements.map((row) => [row.quote, row.times_raised])).toEqual([["背景要连贯", 1]]);

    // One for the whole conversation shows on its open plan too.
    const arm = say(film.id, "机械臂必须是左手");
    seen.length = 0;
    store.addRequirement({ scope: "project", scopeId: room, quote: "机械臂必须是左手", sourceKind: "message", sourceQuoteId: arm.id, addedBy: "scribe", originTaskId: film.id });
    expect(board().requirements.map((row) => row.quote).sort()).toEqual(["机械臂必须是左手", "背景要连贯"]);

    const again = say(film.id, "背景还是要连贯");
    seen.length = 0;
    store.raiseRequirement(entry.id, { quoteId: again.id, actor: "scribe" });
    const after = board();
    expect(after.requirements.find((row) => row.id === entry.id)?.times_raised).toBe(2);
    expect(after.revision).toBe(version);
    store.close();
  });
});
