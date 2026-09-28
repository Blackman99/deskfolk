import { describe, expect, test } from "bun:test";
import { htmlForJudge, isAppFile, judgedFiles } from "./deliveries";

describe("what the judge reads", () => {
  test("the app's own files are never a delivery", () => {
    expect(isAppFile("work/报告-ab12/map.md")).toBe(true);
    expect(isAppFile("work/报告-ab12/01-初稿/ticket.md")).toBe(true);
    expect(isAppFile("work/报告-ab12/tool-results/x.json")).toBe(true);
    expect(isAppFile("work/报告-ab12/scratch/notes.md")).toBe(true);
    expect(isAppFile("tool/node_modules/x/index.js")).toBe(true);
    expect(isAppFile("map.md")).toBe(false);
    expect(isAppFile("work/报告-ab12/01-初稿/draft.md")).toBe(false);
  });

  test("deliverables first, then cited files, once each, only those that exist, up to the limit", () => {
    const files = judgedFiles({
      deliverables: ["report.md", "missing.md"],
      cited: ["notes.md", "report.md", "work/x-1/map.md", "extra.md", "more.md"],
      exists: (path) => path !== "missing.md",
      limit: 3,
    });
    expect(files).toEqual(["report.md", "notes.md", "extra.md"]);
  });

  test("a page is read without its style and script bodies, keeping the tags", () => {
    const html = `<html><head><style>\nbody { margin: 0 }\n.hero { color: red }\n</style>\n<script src="https://cdn.example/a.js"></script><script>\nconsole.log(1)\n</script></head>\n\n\n<body><h1>Tidemark</h1></body></html>`;
    const read = htmlForJudge(html);
    expect(read).toContain("<style>…</style>");
    expect(read).toContain('<script src="https://cdn.example/a.js">…</script>');
    expect(read).toContain("<h1>Tidemark</h1>");
    expect(read).not.toContain("margin");
    expect(read).not.toContain("console.log");
  });
});
