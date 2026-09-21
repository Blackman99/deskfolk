import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { writtenPathFromToolData } from "./artifact-paths";
import { dropToolResults, serializeToolResult, trimToolContent } from "./tool-results";

const roots: string[] = [];
function workspace() { const root = mkdtempSync(join(tmpdir(), "bot-tool-result-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("tool result recovery", () => {
  test("small payloads remain unchanged and do not create files", () => {
    const root = workspace();
    const payload = { ok: false, error: { code: "denied", message: "denied" } };
    expect(serializeToolResult(payload, root)).toBe(JSON.stringify(payload));
    expect(readdirSync(root)).toEqual([]);
  });

  test("saves full MCP image bytes and trailing link while bounding context", () => {
    const root = workspace();
    const payload = { ok: true, data: { content: [
      { type: "image", mimeType: "image/jpeg", data: "A".repeat(350000) },
      { type: "text", text: "https://example.test/avatar.jpg" },
    ] } };
    const raw = serializeToolResult(payload, root);
    const result = JSON.parse(raw);
    expect([...raw].length).toBeLessThanOrEqual(8000);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.full_result_path).toMatch(/^tool-results\/.+\.json$/);
    expect(JSON.parse(readFileSync(join(root, result.full_result_path), "utf8"))).toEqual(payload);
    expect(statSync(join(root, result.full_result_path)).mode & 0o777).toBe(0o600);
    expect(raw).toContain("https://example.test/avatar.jpg");
    expect(raw).toContain("shell");
  });

  test("large shell failures, MCP errors and read results preserve status and complete content", () => {
    const root = workspace();
    const payloads = [
      { ok: true, data: { exit_code: 2, stdout: "x".repeat(1200000), stderr: "actual failure" } },
      { ok: true, data: { isError: true, content: [{ type: "text", text: "bad".repeat(10000) }] } },
      { ok: false, error: { code: "bad_request", message: "坏".repeat(10000) } },
      { ok: true, data: { path: "report.txt", content: "😀".repeat(10000) } },
    ];
    for (const payload of payloads) {
      const raw = serializeToolResult(payload, root);
      const result = JSON.parse(raw);
      expect([...raw].length).toBeLessThanOrEqual(8000);
      expect(result.ok).toBe(payload.ok);
      expect(JSON.parse(readFileSync(join(root, result.full_result_path), "utf8"))).toEqual(payload);
      if ("error" in payload) expect(result.error.code).toBe("bad_request");
      if (payload.data && "exit_code" in payload.data) {
        expect(result.data.exit_code).toBe(2);
        expect(result.data.stderr).toBe("actual failure");
      }
      if (payload.data && "isError" in payload.data) expect(result.data.isError).toBe(true);
    }
    expect(readdirSync(join(root, "tool-results")).length).toBe(4);
  });

  test("does not write through an outside symlink or overwrite a blocking file", () => {
    const root = workspace(); const outside = workspace();
    symlinkSync(outside, join(root, "tool-results"));
    const payload = { ok: false, error: { code: "failed", message: "a".repeat(20000) } };
    const result = JSON.parse(serializeToolResult(payload, root));
    expect(result.ok).toBe(false);
    expect(result.full_result_path).toBeUndefined();
    expect(result.full_result_saved).toBe(false);
    expect(result.save_error).toBeTruthy();
    expect(readdirSync(outside)).toEqual([]);
    const blocked = workspace();
    writeFileSync(join(blocked, "tool-results"), "keep");
    expect(JSON.parse(serializeToolResult(payload, blocked)).full_result_saved).toBe(false);
    expect(readFileSync(join(blocked, "tool-results"), "utf8")).toBe("keep");
  });

  test("missing workspace and huge invalid JSON never invent success", () => {
    const raw = JSON.stringify({ ok: false, error: { code: "failed", message: "x".repeat(10000) } });
    expect(JSON.parse(trimToolContent(raw)).ok).toBe(false);
    expect(JSON.parse(serializeToolResult(JSON.parse(raw), null)).full_result_saved).toBe(false);
    const malformed = trimToolContent("not-json".repeat(2000));
    expect(JSON.parse(malformed).ok).toBeUndefined();
    expect([...malformed].length).toBeLessThanOrEqual(8000);
  });

  test("wide arrays and escaped Unicode stay within the limit", () => {
    const payload = { ok: true, data: { entries: Array.from({ length: 5000 }, (_, i) => ({ path: `${i}-😀`, content: '\\"\n'.repeat(200) })) } };
    const raw = serializeToolResult(payload, workspace());
    expect([...raw].length).toBeLessThanOrEqual(8000);
    expect(JSON.parse(raw).full_result_path).toBeTruthy();
  });
});

describe("the spill lives in the work dir", () => {
  const big = { ok: true, data: { content: "x".repeat(20_000) } };

  test("a turn with a work dir spills inside it", () => {
    const root = workspace();
    const workDir = "work/2026-09-21-导出季度报表-7f3k";
    const result = JSON.parse(serializeToolResult(big, root, workDir));
    expect(result.full_result_path).toStartWith(`${workDir}/tool-results/`);
    expect(existsSync(join(root, result.full_result_path))).toBe(true);
  });

  test("a turn from before work dirs still spills at the root", () => {
    const root = workspace();
    const result = JSON.parse(serializeToolResult(big, root, null));
    expect(result.full_result_path).toStartWith("tool-results/");
  });

  /**
   * The recovery metadata sits beside `data`, not inside it, which is why the artifact entry has
   * never listed a ULID JSON. That was luck rather than design until this test.
   */
  test("full_result_path is never something the message cites", () => {
    const root = workspace();
    const result = JSON.parse(serializeToolResult(big, root, "work/2026-09-21-x-7f3k"));
    expect(result.full_result_path).toBeString();
    expect(writtenPathFromToolData(result.data)).toEqual([]);
    expect(writtenPathFromToolData(result)).toEqual([]);
  });

  test("the sweep drops tool-results and leaves the rest of the work dir alone", () => {
    const root = workspace();
    const dir = "work/2026-09-21-x-7f3k";
    mkdirSync(join(root, dir, "tool-results"), { recursive: true });
    writeFileSync(join(root, dir, "tool-results", "01J.json"), "{}");
    writeFileSync(join(root, dir, "report.md"), "keep me");
    mkdirSync(join(root, dir, "charts"), { recursive: true });
    writeFileSync(join(root, dir, "charts", "q3.png"), "keep me too");

    expect(dropToolResults(root, [dir])).toBe(1);
    expect(existsSync(join(root, dir, "tool-results"))).toBe(false);
    expect(readFileSync(join(root, dir, "report.md"), "utf8")).toBe("keep me");
    expect(existsSync(join(root, dir, "charts", "q3.png"))).toBe(true);
    // Idempotent: a second boot sweeps the same rows and finds nothing to do.
    expect(dropToolResults(root, [dir])).toBe(0);
  });

  test("the sweep never reaches outside the workspace", () => {
    const root = workspace();
    const outside = workspace();
    mkdirSync(join(outside, "tool-results"), { recursive: true });
    expect(dropToolResults(root, ["../../etc", outside])).toBe(0);
    expect(existsSync(join(outside, "tool-results"))).toBe(true);
  });
});
