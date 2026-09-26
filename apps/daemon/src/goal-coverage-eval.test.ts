import { describe, expect, test } from "bun:test";
import {
  COVERAGE_EXCERPT_LIMIT,
  COVERAGE_MESSAGE_LIMIT,
  COVERAGE_MESSAGES,
  coverageScore,
  formatCoverageReport,
  goalCoveragePayload,
  parseGoalCoverage,
} from "./goal-coverage-eval";

describe("goal coverage", () => {
  test("the payload clips excerpts and messages and keeps only the last few messages", () => {
    const payload = goalCoveragePayload({
      brief: "写周报，交到 report.md",
      deliveries: [
        { path: "report.md", excerpt: "x".repeat(COVERAGE_EXCERPT_LIMIT + 10) },
        { path: "chart.png", excerpt: null },
      ],
      finalMessages: Array.from({ length: COVERAGE_MESSAGES + 3 }, (_, i) => ({
        author: "Writer",
        body: i === COVERAGE_MESSAGES + 2 ? "y".repeat(COVERAGE_MESSAGE_LIMIT + 1) : `第 ${i} 句`,
      })),
    });
    expect(payload.deliveries[0]).toMatchObject({ path: "report.md", truncated: true });
    expect([...payload.deliveries[0]!.excerpt!].length).toBe(COVERAGE_EXCERPT_LIMIT);
    expect(payload.deliveries[1]).toEqual({ path: "chart.png", excerpt: null });
    expect(payload.final_messages).toHaveLength(COVERAGE_MESSAGES);
    expect(payload.final_messages[0]!.body).toBe("第 3 句");
    expect(payload.final_messages.at(-1)).toMatchObject({ truncated: true });
  });

  test("a verdict is parsed through a fence, and an unknown status or a bare requirement rejects it", () => {
    const parsed = parseGoalCoverage(
      '```json\n{"requirements":[{"text":"交到 report.md","status":"Covered","evidence":"report.md 存在"},{"text":"附趋势图","status":"missing"}],"summary":"差一张图"}\n```',
    );
    expect(parsed).toEqual({
      requirements: [
        { text: "交到 report.md", status: "covered", evidence: "report.md 存在" },
        { text: "附趋势图", status: "missing", evidence: "" },
      ],
      summary: "差一张图",
    });
    expect(parseGoalCoverage('{"requirements":[{"text":"a","status":"done"}]}')).toBeNull();
    expect(parseGoalCoverage('{"requirements":[{"status":"covered"}]}')).toBeNull();
    expect(parseGoalCoverage('{"summary":"nothing"}')).toBeNull();
    expect(parseGoalCoverage("not json")).toBeNull();
    expect(parseGoalCoverage('{"requirements":[]}')).toEqual({ requirements: [], summary: "" });
  });

  test("the score counts covered whole and partial half, and a brief with nothing to cover is met", () => {
    expect(
      coverageScore({
        requirements: [
          { text: "a", status: "covered", evidence: "" },
          { text: "b", status: "partial", evidence: "" },
          { text: "c", status: "missing", evidence: "" },
          { text: "d", status: "covered", evidence: "" },
        ],
        summary: "",
      }),
    ).toBeCloseTo(0.625);
    expect(coverageScore({ requirements: [], summary: "" })).toBe(1);
  });

  test("the report is one table per job with the rate on top", () => {
    const report = formatCoverageReport({
      title: "写周报",
      dir: "work/2026-09-25-写周报-ab12",
      model: "judge-1",
      coverage: {
        requirements: [
          { text: "交到 report.md", status: "covered", evidence: "report.md | 有" },
          { text: "附趋势图", status: "missing", evidence: "" },
        ],
        summary: "差一张图",
      },
    });
    expect(report).toContain("## 写周报");
    expect(report).toContain("覆盖率：50%（2 条要求）");
    expect(report).toContain("| 1 | 交到 report.md | ✅ covered | report.md \\| 有 |");
    expect(report).toContain("| 2 | 附趋势图 | ❌ missing | 没有 |");
    expect(report.trimEnd().endsWith("差一张图")).toBe(true);
  });
});
