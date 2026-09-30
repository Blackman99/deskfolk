import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isWorkspaceRelative,
  loadTaskSet,
  mentionsSomeone,
  parseSetups,
  parseTaskSet,
  requireSetups,
  seedDir,
  selectTasks,
  TaskSetError,
  type GoldenTask,
} from "./tasks";

const SHIPPED = resolve(import.meta.dir, "../../eval/golden-path/tasks.json");

function minimalTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo",
    title: "演示",
    message: "工作区根目录的 `brief.md` 是要做的事，请大家做出来。",
    goal: "交出 out.md",
    acceptance: ["out.md 存在"],
    deliverables: ["out.md"],
    setups: {
      manual: {
        group: "演示组",
        bots: [
          { name: "Writer", duties: "写", boundaries: "只在工作区" },
          { name: "Reviewer", duties: "审", boundaries: "只在工作区" },
        ],
      },
      coordinator: { bot: { name: "Coordinator", duties: "协调", boundaries: "不执笔" }, message: "请建 Writer 和 Reviewer，开群。" },
    },
    ...overrides,
  };
}

function parseOne(overrides: Record<string, unknown> = {}): GoldenTask {
  return parseTaskSet({ version: 1, tasks: [minimalTask(overrides)] }).tasks[0]!;
}

function rejects(overrides: Record<string, unknown>, fragment: string): void {
  expect(() => parseOne(overrides)).toThrow(fragment);
}

describe("task set", () => {
  test("a minimal task gets its defaults: seed named after the id, brief.md, no rules, checks or commands", () => {
    const task = parseOne();
    expect(task.seed).toBe("demo");
    expect(task.brief).toBe("brief.md");
    expect(task.rules).toEqual([]);
    expect(task.checks).toEqual([]);
    expect(task.verify).toEqual([]);
    expect(task.extra).toBe(false);
    expect(task.setups.manual.bots.map((bot) => bot.name)).toEqual(["Writer", "Reviewer"]);
  });

  test("extra defaults to false, must be a boolean, and marks a task the default (no --only) selection skips", () => {
    expect(parseOne({ extra: true }).extra).toBe(true);
    rejects({ extra: "yes" }, "must be a boolean");
    const set = parseTaskSet({ version: 1, tasks: [minimalTask(), minimalTask({ id: "wide", extra: true })] });
    expect(selectTasks(set, null).map((task) => task.id)).toEqual(["demo"]);
    expect(selectTasks(set, ["wide"]).map((task) => task.id)).toEqual(["wide"]);
    expect(selectTasks(set, ["demo", "wide"]).map((task) => task.id)).toEqual(["demo", "wide"]);
  });

  test("a verify step defaults to the workspace root, exit 0, no stdout comparison and two minutes", () => {
    const task = parseOne({ verify: [{ command: ["bun", "test"] }] });
    expect(task.verify[0]).toEqual({ cwd: ".", command: ["bun", "test"], expect_exit: 0, expect_stdout: null, timeout_sec: 120 });
  });

  test("the task line and the Coordinator's instruction must not @ anyone", () => {
    rejects({ message: "@Writer 请照 brief.md 做" }, "must not @ anyone");
    rejects({ message: "大家好，@everyone 请开工" }, "must not @ anyone");
    expect(() =>
      parseOne({
        setups: {
          ...(minimalTask().setups as Record<string, unknown>),
          coordinator: { bot: { name: "Coordinator", duties: "协调", boundaries: "不执笔" }, message: "开群后 @everyone" },
        },
      }),
    ).toThrow("must not @ anyone");
    // An address in the brief text is not a mention.
    expect(mentionsSomeone("写信到 team@example.com")).toBe(false);
  });

  test("paths must stay inside the workspace", () => {
    rejects({ deliverables: ["../out.md"] }, "workspace-relative");
    rejects({ deliverables: ["/tmp/out.md"] }, "workspace-relative");
    rejects({ checks: [{ path: "a//b.md", contains: ["x"] }] }, "workspace-relative");
    rejects({ verify: [{ cwd: "../..", command: ["bun", "test"] }] }, "workspace-relative");
    expect(isWorkspaceRelative("launch/index.html")).toBe(true);
    expect(isWorkspaceRelative("launch\\index.html")).toBe(false);
  });

  test("a check must check something and its regexes must compile", () => {
    rejects({ checks: [{ path: "out.md" }] }, "checks nothing");
    rejects({ checks: [{ path: "out.md", matches: ["(unclosed"] }] }, "not a valid regular expression");
  });

  test("a verify step needs a command and sane limits", () => {
    rejects({ verify: [{ command: [] }] }, "must not be empty");
    rejects({ verify: [{ command: ["bun"], expect_exit: 300 }] }, "0–255");
    rejects({ verify: [{ command: ["bun"], timeout_sec: 0 }] }, "seconds");
  });

  test("the team: at least two Bots, no name twice, and the Coordinator is not one of them", () => {
    const setups = minimalTask().setups as { manual: { group: string; bots: unknown[] }; coordinator: unknown };
    rejects({ setups: { ...setups, manual: { group: "g", bots: [setups.manual.bots[0]] } } }, "at least two Bots");
    rejects({ setups: { ...setups, manual: { group: "g", bots: [setups.manual.bots[0], setups.manual.bots[0]] } } }, "listed twice");
    rejects(
      { setups: { ...setups, coordinator: { bot: { name: "Writer", duties: "d", boundaries: "b" }, message: "m" } } },
      "must differ from the teammates",
    );
  });

  test("missing fields are named by where they are", () => {
    rejects({ acceptance: [] }, "tasks[0].acceptance: must not be empty");
    rejects({ goal: "  " }, "tasks[0].goal: must be a non-empty string");
    rejects({ id: "Has Spaces" }, "tasks[0].id");
    expect(() => parseTaskSet({ version: 2, tasks: [minimalTask()] })).toThrow("version");
    expect(() => parseTaskSet({ version: 1, tasks: [minimalTask(), minimalTask()] })).toThrow("demo is used twice");
  });

  test("--only keeps the set's order and refuses an unknown id", () => {
    const set = parseTaskSet({ version: 1, tasks: [minimalTask({ id: "a" }), minimalTask({ id: "b" })] });
    expect(selectTasks(set, ["b", "a"]).map((task) => task.id)).toEqual(["a", "b"]);
    expect(selectTasks(set, null)).toHaveLength(2);
    expect(() => selectTasks(set, ["c"])).toThrow(TaskSetError);
  });

  test("--setup reads manual, coordinator, solo, both or all, comma-separated, unique and in SETUPS order", () => {
    expect(parseSetups("both")).toEqual(["manual", "coordinator"]);
    expect(parseSetups("coordinator")).toEqual(["coordinator"]);
    expect(parseSetups("solo")).toEqual(["solo"]);
    expect(parseSetups("all")).toEqual(["manual", "coordinator", "solo"]);
    expect(parseSetups("solo,manual")).toEqual(["manual", "solo"]);
    expect(parseSetups("solo,solo,manual")).toEqual(["manual", "solo"]);
    expect(() => parseSetups("team")).toThrow("--setup");
  });

  test("a solo block: bot validated like other profiles, message must not @ anyone", () => {
    const task = parseOne({
      setups: {
        ...(minimalTask().setups as Record<string, unknown>),
        solo: { bot: { name: "Generalist", duties: "d", boundaries: "b" }, message: "工作区根目录的 `brief.md` 是要做的事，请你把它做出来。" },
      },
    });
    expect(task.setups.solo).toEqual({
      bot: { name: "Generalist", duties: "d", boundaries: "b" },
      message: "工作区根目录的 `brief.md` 是要做的事，请你把它做出来。",
    });
    rejects(
      { setups: { ...(minimalTask().setups as Record<string, unknown>), solo: { bot: { name: "Generalist", duties: "d", boundaries: "b" }, message: "@Generalist 请做" } } },
      "must not @ anyone",
    );
    rejects({ setups: { ...(minimalTask().setups as Record<string, unknown>), solo: { message: "做" } } }, "tasks[0].setups.solo.bot");
  });

  test("a task set with no setups.solo still loads: it is optional", () => {
    const task = parseOne();
    expect(task.setups.solo).toBeUndefined();
  });

  test("requireSetups: solo requested but a task lacks setups.solo", () => {
    const withSolo = parseOne({
      id: "a",
      setups: {
        ...(minimalTask().setups as Record<string, unknown>),
        solo: { bot: { name: "Generalist", duties: "d", boundaries: "b" }, message: "做" },
      },
    });
    const withoutSolo = parseOne({ id: "b" });
    expect(() => requireSetups([withSolo], ["solo"])).not.toThrow();
    expect(() => requireSetups([withSolo, withoutSolo], ["solo"])).toThrow("b has no setups.solo");
    expect(() => requireSetups([withoutSolo], ["manual"])).not.toThrow();
  });

  describe("script steps and the mcp fixture (L/S/R/G)", () => {
    test("a minimal task has no script and no mcp", () => {
      const task = parseOne();
      expect(task.script).toEqual([]);
      expect(task.mcp).toBeNull();
    });

    test("a seconds-triggered line into the group, and one into a named Bot's direct", () => {
      const task = parseOne({
        script: [
          { id: "stop", after: { kind: "seconds", after_s: 90 }, target: { kind: "bot_direct", bot: "Writer" }, body: "先停一下。" },
          { id: "again", after: { kind: "first_delivery" }, target: { kind: "group" }, body: "还是不对。", expect_bot: "Reviewer" },
        ],
      });
      expect(task.script).toEqual([
        { id: "stop", after: { kind: "seconds", after_s: 90 }, target: { kind: "bot_direct", bot: "Writer" }, body: "先停一下。", expect_bot: null, expect_plan: null },
        { id: "again", after: { kind: "first_delivery" }, target: { kind: "group" }, body: "还是不对。", expect_bot: "Reviewer", expect_plan: null },
      ]);
    });

    test("expect_plan must be kickoff or new, and defaults to null", () => {
      const task = parseOne({
        script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "group" }, body: "另一件事。", expect_plan: "new" }],
      });
      expect(task.script[0]!.expect_plan).toBe("new");
      rejects(
        { script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "group" }, body: "x", expect_plan: "resume" }] },
        "must be kickoff or new",
      );
    });

    test("a coordinator-targeted line needs no bot name", () => {
      const task = parseOne({
        script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "coordinator" }, body: "先别开工。" }],
      });
      expect(task.script[0]!.target).toEqual({ kind: "coordinator" });
    });

    test("a script step must not @ anyone, same rule as the task line", () => {
      rejects(
        { script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "group" }, body: "@Writer 再看看" }] },
        "must not @ anyone",
      );
    });

    test("a bot_direct target and an expect_bot must both name a Bot from setups.manual.bots", () => {
      rejects(
        { script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "bot_direct", bot: "Nobody" }, body: "停" }] },
        "Nobody is not one of setups.manual.bots",
      );
      rejects(
        { script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "group" }, body: "还是不对", expect_bot: "Nobody" }] },
        "Nobody is not one of setups.manual.bots",
      );
    });

    test("a step id used twice is rejected, like a task id", () => {
      rejects(
        {
          script: [
            { id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "group" }, body: "一" },
            { id: "s1", after: { kind: "seconds", after_s: 30 }, target: { kind: "group" }, body: "二" },
          ],
        },
        "s1 is used twice",
      );
    });

    test("after.kind and target.kind are checked, and after_s must be non-negative", () => {
      rejects({ script: [{ id: "s1", after: { kind: "eventually" }, target: { kind: "group" }, body: "x" }] }, "seconds or first_delivery");
      rejects({ script: [{ id: "s1", after: { kind: "seconds", after_s: -1 }, target: { kind: "group" }, body: "x" }] }, "non-negative");
      rejects({ script: [{ id: "s1", after: { kind: "seconds", after_s: 0 }, target: { kind: "elsewhere" }, body: "x" }] }, "group, coordinator or bot_direct");
    });

    test("L's mcp config: a non-negative integer video_polls, absent by default", () => {
      const task = parseOne({ mcp: { video_polls: 3 } });
      expect(task.mcp).toEqual({ video_polls: 3 });
      rejects({ mcp: { video_polls: -1 } }, "non-negative integer");
      rejects({ mcp: { video_polls: 1.5 } }, "non-negative integer");
    });
  });
});

/** The reference `tally`: what the small-tool brief asks for, to check the fixture's own answers. */
function tally(csv: string, month: string | null): string {
  const totals = new Map<string, number>();
  for (const line of csv.trim().split("\n").slice(1)) {
    const [date, category, amount] = line.split(",");
    if (month && !date!.startsWith(`${month}-`)) continue;
    totals.set(category!, (totals.get(category!) ?? 0) + Number(amount));
  }
  const rows = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  return [...rows.map(([name, value]) => `${name}\t${value.toFixed(2)}`), `TOTAL\t${total.toFixed(2)}`].join("\n") + "\n";
}

/** The original three: small, no-network office jobs with a working solo setup too. The L/S/R/G
 * benchmark families are `manual`/`coordinator`-only: their script steps and G's labels name Bots
 * from `setups.manual.bots`, a roster a lone generalist does not have. */
const OFFICE_TASKS = ["research", "launch-kit", "small-tool"];
/** Each new family's Bot count: L and S/R pair up, G needs a room. */
const MANUAL_BOT_COUNTS: Record<string, number> = { "long-mission": 2, "cross-stop": 2, "repeat-note": 2, "big-room": 8 };

describe("the shipped task set", () => {
  const loaded = loadTaskSet(SHIPPED);

  test("loads, with a seed folder and brief for every task", () => {
    expect(loaded.set.tasks.map((task) => task.id)).toEqual(["research", "launch-kit", "small-tool", "long-mission", "cross-stop", "repeat-note", "big-room"]);
    for (const task of loaded.set.tasks) {
      expect(readFileSync(join(seedDir(loaded, task), task.brief), "utf8").length).toBeGreaterThan(100);
      expect(task.setups.manual.bots.length).toBe(OFFICE_TASKS.includes(task.id) ? 3 : MANUAL_BOT_COUNTS[task.id]);
    }
  });

  test("the Coordinator is asked to hire exactly the Bots the manual setup creates", () => {
    for (const task of loaded.set.tasks) {
      for (const bot of task.setups.manual.bots) expect(task.setups.coordinator.message).toContain(`- ${bot.name}：`);
    }
  });

  test("every office task has a solo setup that works alone: no 大家, boundaries forbid hiring", () => {
    for (const task of loaded.set.tasks.filter((task) => OFFICE_TASKS.includes(task.id))) {
      const solo = task.setups.solo;
      expect(solo).toBeDefined();
      expect(solo!.message).not.toContain("大家");
      expect(solo!.bot.boundaries).toContain("不建其他 Bot");
    }
  });

  test("L/S/R/G carry no solo setup: script steps and G's attribution assume a known manual roster", () => {
    for (const task of loaded.set.tasks.filter((task) => !OFFICE_TASKS.includes(task.id))) expect(task.setups.solo).toBeUndefined();
  });

  test("L/S/R/G are `extra`: the default (no --only) selection is just the three office tasks, so --setup all no longer trips on their missing solo setup", () => {
    for (const task of loaded.set.tasks) expect(task.extra).toBe(!OFFICE_TASKS.includes(task.id));
    const defaultSelection = selectTasks(loaded.set, null);
    expect(defaultSelection.map((task) => task.id)).toEqual(OFFICE_TASKS);
    expect(() => requireSetups(defaultSelection, ["manual", "coordinator", "solo"])).not.toThrow();
    // Naming one by id still runs it, with whatever setups it actually has.
    expect(() => requireSetups(selectTasks(loaded.set, ["long-mission"]), ["solo"])).toThrow("long-mission has no setups.solo");
  });

  test("L's mcp config and the media MCP fixture line up: video_polls is set, no other task carries mcp", () => {
    for (const task of loaded.set.tasks) expect(task.mcp).toEqual(task.id === "long-mission" ? { video_polls: 2 } : null);
  });

  test("S stops a Bot and later resumes it, both in its own roster; R repeats the same rule 3 times", () => {
    const stop = loaded.set.tasks.find((task) => task.id === "cross-stop")!;
    expect(stop.script).toHaveLength(2);
    expect(stop.script.every((step) => step.target.kind === "bot_direct" && step.target.bot === "Writer")).toBe(true);
    expect(stop.script.every((step) => step.expect_bot === null && step.expect_plan === null)).toBe(true);
    // The resume comes after the stop, so a compliant Writer that actually paused still gets a
    // chance to finish the checklist, not just a Writer that never paused in the first place.
    expect(stop.script[1]!.after).toEqual({ kind: "seconds", after_s: expect.any(Number) });
    if (stop.script[0]!.after.kind === "seconds" && stop.script[1]!.after.kind === "seconds") {
      expect(stop.script[1]!.after.after_s).toBeGreaterThan(stop.script[0]!.after.after_s);
    }

    const repeat = loaded.set.tasks.find((task) => task.id === "repeat-note")!;
    expect(repeat.script).toHaveLength(3);
    expect(repeat.script.every((step) => step.target.kind === "group" && step.expect_bot === null && step.expect_plan === null)).toBe(true);
  });

  test("G (big-room) labels both a line that continues the kickoff job and lines that are unrelated new asks — a filer that always opens a new plan must not score 100%", () => {
    const room = loaded.set.tasks.find((task) => task.id === "big-room")!;
    expect(room.script.length).toBeGreaterThanOrEqual(4);
    const roomBots = new Set(room.setups.manual.bots.map((bot) => bot.name));
    const byPlan = { kickoff: room.script.filter((step) => step.expect_plan === "kickoff"), new: room.script.filter((step) => step.expect_plan === "new") };
    // Both labels are actually present: this is what tells the new-request heuristic's accuracy
    // apart from a filer that always (or never) opens a new plan.
    expect(byPlan.kickoff.length).toBeGreaterThanOrEqual(1);
    expect(byPlan.new.length).toBeGreaterThanOrEqual(1);
    expect(byPlan.kickoff.length + byPlan.new.length).toBe(room.script.length);
    for (const step of byPlan.new) {
      expect(step.expect_bot).not.toBeNull();
      expect(roomBots.has(step.expect_bot!)).toBe(true);
    }
    // Each label is unambiguous from the line alone: a kickoff line names the kickoff's own file,
    // and a new ask neither names it nor asks for release notes or an update's write-up.
    for (const step of byPlan.kickoff) expect(step.body).toContain("notes.md");
    for (const step of byPlan.new) expect(step.body).not.toMatch(/notes\.md|发布说明|更新.*说明|CHANGES/);
  });

  test("G's release notes are checked against the seed's own change list, version included", () => {
    const room = loaded.set.tasks.find((task) => task.id === "big-room")!;
    const changes = readFileSync(join(seedDir(loaded, room), "CHANGES.md"), "utf8");
    const [notes] = room.checks;
    expect(notes!.path).toBe("notes.md");
    expect(notes!.contains).toContain("2.4.0");
    for (const needle of notes!.contains) expect(changes).toContain(needle);
    // Nothing the scripted new asks bring up is in the change list, so the notes have no reason to carry it.
    for (const topic of ["登录", "流水线", "导出", "上手指南"]) expect(changes).not.toContain(topic);
  });

  test("the small tool's expected outputs are what the sample CSV really sums to, and the brief says the same", () => {
    const task = loaded.set.tasks.find((item) => item.id === "small-tool")!;
    const csv = readFileSync(join(seedDir(loaded, task), "samples", "expenses.csv"), "utf8");
    const brief = readFileSync(join(seedDir(loaded, task), task.brief), "utf8");
    const [, all, august] = task.verify;
    expect(all!.expect_stdout).toBe(tally(csv, null));
    expect(august!.expect_stdout).toBe(tally(csv, "2026-08"));
    for (const expected of [all!.expect_stdout!, august!.expect_stdout!]) {
      const indented = expected.trimEnd().split("\n").map((line) => `    ${line}`).join("\n");
      expect(brief).toContain(indented);
    }
  });
});
