import { expect, test } from "bun:test";
import {
  detectDutyIcon,
  getStarterOptions,
  parseDutyItems,
} from "./starter-prompts.ts";

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
