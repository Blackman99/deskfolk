import { expect, test } from "bun:test";
import {
  detectDutyIcon,
  getStarterOptions,
  handOffStarter,
  parseDutyItems,
} from "./starter-prompts.ts";
import { COPY } from "../copy.ts";

test("detectDutyIcon maps common keywords to matching icons", () => {
  expect(detectDutyIcon("架构设计")).toBe("📐");
  expect(detectDutyIcon("System architecture")).toBe("📐");
  expect(detectDutyIcon("代码审查")).toBe("🔍");
  expect(detectDutyIcon("安全审计")).toBe("🔍");
  expect(detectDutyIcon("性能调优与优化")).toBe("⚡");
  expect(detectDutyIcon("自动化测试")).toBe("🧪");
  expect(detectDutyIcon("编写技术文档")).toBe("📝");
  expect(detectDutyIcon("中英文翻译")).toBe("🌐");
  expect(detectDutyIcon("前端开发与组件实现")).toBe("💻");
  expect(detectDutyIcon("数据分析与统计")).toBe("📊");
  expect(detectDutyIcon("未知工作")).toBe("🎯");
});

test("parseDutyItems splits by newlines and cleans prefixes", () => {
  const duties = `
    1. 负责架构方案设计与选型
    2. 主要负责排查系统性能瓶颈
    3. 编写架构设计文档
  `;
  const items = parseDutyItems(duties);
  expect(items).toEqual([
    "架构方案设计与选型",
    "排查系统性能瓶颈",
    "编写架构设计文档",
  ]);
});

test("parseDutyItems splits by semicolon or comma when single line", () => {
  expect(parseDutyItems("代码审查；单元测试；性能优化")).toEqual([
    "代码审查",
    "单元测试",
    "性能优化",
  ]);
  expect(parseDutyItems("负责前端开发、组件封装、样式优化")).toEqual([
    "前端开发",
    "组件封装",
    "样式优化",
  ]);
});

test("single-focus duty (like 架构师 with 架构设计) generates 4 contextual options", () => {
  const options = getStarterOptions({
    name: "架构师",
    duties: "架构设计",
    boundaries: "保持设计简洁",
    locale: "zh",
  });

  expect(options.length).toBe(4);

  // Option 1: Intro / Capabilities
  expect(options[0].id).toBe("intro");
  expect(options[0].icon).toBe("💬");
  expect(options[0].label).toContain("架构设计");
  expect(options[0].prompt).toContain("作为架构师");
  expect(options[0].prompt).toContain("架构设计");
  expect(options[0].prompt).toContain("保持设计简洁");

  // Option 2: Workspace Action
  expect(options[1].id).toBe("workspace");
  expect(options[1].icon).toBe("📐");
  expect(options[1].label).toContain("工作区");
  expect(options[1].label).toContain("架构设计");
  expect(options[1].prompt).toContain("当前工作区");

  // Option 3: Analysis & Evaluation
  expect(options[2].id).toBe("analysis");
  expect(options[2].icon).toBe("🔍");
  expect(options[2].label).toContain("架构设计");
  expect(options[2].prompt).toContain("评估现有项目的架构设计");

  // Option 4: New Task
  expect(options[3].id).toBe("task");
  expect(options[3].icon).toBe("✨");
  expect(options[3].label).toContain("架构设计");
  expect(options[3].prompt).toContain("架构设计的新任务");
});

test("multi-item duties generates options for each item plus intro", () => {
  const options = getStarterOptions({
    name: "研发助手",
    duties: "1. 编写代码\n2. 代码审查\n3. 编写测试用例",
    locale: "zh",
  });

  expect(options.length).toBe(4);
  expect(options[0].label).toContain("编写代码");
  expect(options[0].icon).toBe("💻");
  expect(options[1].label).toContain("代码审查");
  expect(options[1].icon).toBe("🔍");
  expect(options[2].label).toContain("测试用例");
  expect(options[2].icon).toBe("🧪");
  expect(options[3].id).toBe("intro");
  expect(options[3].icon).toBe("💬");
  expect(options[3].prompt).toContain("作为研发助手");
});

test("English duties generates English starter prompts", () => {
  const options = getStarterOptions({
    name: "Architect",
    duties: "System architecture and technical design",
    boundaries: "Keep design simple",
    locale: "en",
  });

  expect(options.length).toBe(4);
  expect(options[0].prompt).toContain("As Architect");
  expect(options[0].prompt).toContain("System architecture and technical design");
  expect(options[0].prompt).toContain("Keep design simple");
  expect(options[1].label).toContain("workspace");
  expect(options[1].icon).toBe("📐");
});

test("Empty duties falls back to name-based dynamic options", () => {
  const options = getStarterOptions({
    name: "架构师",
    duties: "",
    locale: "zh",
  });

  expect(options.length).toBe(3);
  expect(options[0].label).toContain("架构师");
  expect(options[0].prompt).toContain("作为架构师，请介绍一下你可以帮我做什么");
  expect(options[2].label).toContain("架构师");
});

test("Completely empty input falls back to standard generic prompts", () => {
  const options = getStarterOptions({
    name: "",
    duties: "",
    locale: "zh",
  });

  expect(options.length).toBe(3);
  expect(options[0].label).toBe("你可以帮我做什么？");
  expect(options[1].label).toBe("查看当前工作区有哪些文件");
  expect(options[2].label).toBe("开始一个新任务");
});

test("a Bot made from a template gets the starters from its name, not its duties cut into pieces", () => {
  for (const locale of ["zh", "en"] as const) {
    for (const [id, template] of Object.entries(COPY[locale].templates.templates)) {
      const options = getStarterOptions({ ...template, locale });
      expect({ id, ids: options.map((option) => option.id) }).toEqual({ id, ids: ["intro", "workspace", "task"] });
      for (const option of options) {
        expect(option.label).not.toContain("开展");
        expect(option.prompt).not.toContain("开展");
        expect(option.prompt).not.toContain("Please assist me with");
        // A chip cut from the duties would be a piece of them.
        expect(template.duties).not.toContain(option.label.replace(/…$/, ""));
      }
    }
  }
});

test("duties read as sentences by a colon, a full stop inside, or a piece too long for a chip", () => {
  for (const duties of [
    "做界面：页面、组件和交互",
    "查证公开信息。先查再答",
    "读工作区里的资料，把发现和出处记下来\n写脚本和代码，写测试并真的跑一遍",
    "Checks public facts. Looks before answering",
    "Reads the material in the workspace and writes it up\nWrites the tests and runs them",
  ]) {
    expect(getStarterOptions({ name: "助手", duties, locale: "zh" }).map((option) => option.id)).toEqual(["intro", "workspace", "task"]);
  }
  // A one-line list stays a list however long the line, as long as each item is short.
  const list = getStarterOptions({ name: "前端", duties: "前端开发、组件封装、样式优化、性能调优、单元测试", locale: "zh" });
  expect(list.map((option) => option.label)).toEqual(["开展前端开发", "开展组件封装", "开展样式优化", "介绍前端的核心职责与工作方式"]);
});

test("a boundary's own closing stop stays out of the brackets it is quoted in", () => {
  const [intro] = getStarterOptions({ name: "助理", duties: "", boundaries: "花钱之前先问你。", locale: "zh" });
  expect(intro!.prompt).toBe("作为助理，请介绍一下你可以帮我做什么，以及你的职责边界（如：花钱之前先问你）？");
  const [en] = getStarterOptions({ name: "Assistant", duties: "", boundaries: "Asks before spending money.", locale: "en" });
  expect(en!.prompt).toBe("As Assistant, what can you help me with, and what are your boundaries (Asks before spending money)?");
});

test("the hand-off starter asks for a brief now and a morning routine, in the app's language", () => {
  const zh = handOffStarter("zh");
  expect(zh).toMatchObject({ id: "hand-off", label: "交出去，明早看结果" });
  expect(zh.prompt).toContain("briefs/");
  expect(zh.prompt).toContain("每天早上 9 点的日程");
  const en = handOffStarter("en");
  expect(en.label).toBe("Hand it off, see it tomorrow morning");
  expect(en.prompt).toContain("routine at 9 every morning");
});
