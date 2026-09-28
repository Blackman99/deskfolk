import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isWorkspaceRelative,
  loadTaskSet,
  mentionsSomeone,
  parseSetups,
  parseTaskSet,
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
    expect(task.setups.manual.bots.map((bot) => bot.name)).toEqual(["Writer", "Reviewer"]);
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

  test("--setup reads manual, coordinator or both", () => {
    expect(parseSetups("both")).toEqual(["manual", "coordinator"]);
    expect(parseSetups("coordinator")).toEqual(["coordinator"]);
    expect(() => parseSetups("solo")).toThrow("--setup");
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

describe("the shipped task set", () => {
  const loaded = loadTaskSet(SHIPPED);

  test("loads, with a seed folder and brief for every task", () => {
    expect(loaded.set.tasks.map((task) => task.id)).toEqual(["research", "launch-kit", "small-tool"]);
    for (const task of loaded.set.tasks) {
      expect(readFileSync(join(seedDir(loaded, task), task.brief), "utf8").length).toBeGreaterThan(100);
      expect(task.setups.manual.bots.length).toBe(3);
    }
  });

  test("the Coordinator is asked to hire exactly the Bots the manual setup creates", () => {
    for (const task of loaded.set.tasks) {
      for (const bot of task.setups.manual.bots) expect(task.setups.coordinator.message).toContain(`- ${bot.name}：`);
    }
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
