import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { runWorkspaceTool } from "./workspace-tools";
import { createWakeWatch } from "./wake";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function storeWithWorkspace(): Promise<{ store: Store; root: string; close: () => void }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-wt-")));
  dirs.push(root);
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  await store.patchSettings({ workspace_path: root });
  return { store, root, close: () => store.close() };
}

describe("workspace tools", () => {
  test("write then read returns the full UTF-8 text at the relative path", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const written = await runWorkspaceTool({ store, signal }, "write_file", {
      path: "notes/a.md",
      content: "你好",
    });
    expect(written).toEqual({ ok: true, data: { path: "notes/a.md" }, emitted: [] });
    expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("你好");
    const read = await runWorkspaceTool({ store, signal }, "read_file", { path: "notes/a.md" });
    expect(read.ok).toBe(true);
    expect(read.data).toEqual({ path: "notes/a.md", content: "你好" });
    close();
  });

  test("a later write of the same path replaces the whole file", async () => {
    const { store, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    await runWorkspaceTool({ store, signal }, "write_file", { path: "x.md", content: "first" });
    await runWorkspaceTool({ store, signal }, "write_file", { path: "x.md", content: "second" });
    const read = await runWorkspaceTool({ store, signal }, "read_file", { path: "x.md" });
    expect(read.data?.content).toBe("second");
    close();
  });

  test("delete of a missing path is not_found", async () => {
    const { store, close } = await storeWithWorkspace();
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "delete_file", {
      path: "gone.md",
    });
    expect(got).toEqual({
      ok: false,
      error: { code: "not_found", message: "path not found" },
      emitted: [],
    });
    close();
  });

  test("binary read is not_text", async () => {
    const { store, root, close } = await storeWithWorkspace();
    writeFileSync(join(root, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00]));
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "read_file", {
      path: "blob.bin",
    });
    expect(got.error?.code).toBe("not_text");
    close();
  });

  test("an aborted write does not leave the target file", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const abort = new AbortController();
    abort.abort();
    const got = await runWorkspaceTool({ store, signal: abort.signal }, "write_file", {
      path: "half.md",
      content: "nope",
    });
    expect(got.ok).toBe(false);
    expect(() => readFileSync(join(root, "half.md"))).toThrow();
    close();
  });

  test("list_dir default is the workspace root", async () => {
    const { store, root, close } = await storeWithWorkspace();
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "brief.md"), "x");
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "list_dir", {});
    expect(got.ok).toBe(true);
    expect(got.data?.path).toBe(".");
    const names = (got.data?.entries as Array<{ name: string }>).map((e) => e.name).sort();
    expect(names).toEqual(["brief.md", "notes"]);
    close();
  });

  test("recursive list_dir does not walk a symlink whose target is outside", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-out-")));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "secret.md"), "nope");
    symlinkSync(elsewhere, join(root, "out"));
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "list_dir", {
      recursive: true,
    });
    const paths = (got.data?.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain("out");
    expect(paths.some((p) => p.includes("secret.md"))).toBe(false);
    close();
  });

  test("shell returns the command's output", async () => {
    const { store, close } = await storeWithWorkspace();
    const got = await runWorkspaceTool(
      { store, signal: new AbortController().signal },
      "shell",
      { command: "echo hi" },
    );
    expect(got.ok).toBe(true);
    expect(got.data?.exit_code).toBe(0);
    expect(String(got.data?.stdout).trim()).toBe("hi");
    close();
  });

  /**
   * A command that never returns used to hold the turn open for good — and so did one that exits
   * while a backgrounded grandchild keeps its stdout pipe open.
   */
  test("shell with no cwd runs in the work dir, creating it on first use", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-导出季度报表-7f3k";
    expect(existsSync(join(root, workDir))).toBe(false);

    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "pwd > here.txt && echo done",
    });
    expect(ran.ok).toBe(true);
    // This is the whole point: a command that writes where it stands does not litter the root.
    expect(existsSync(join(root, "here.txt"))).toBe(false);
    expect(readFileSync(join(root, workDir, "here.txt"), "utf8").trim()).toBe(join(root, workDir));
    close();
  });

  test("an explicit cwd still wins, and `.` is still the workspace root", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "pwd > here.txt",
      cwd: ".",
    });
    expect(ran.ok).toBe(true);
    expect(readFileSync(join(root, "here.txt"), "utf8").trim()).toBe(root);
    // Nothing was created for a work dir the command never used.
    expect(existsSync(join(root, workDir))).toBe(false);
    close();
  });

  test("file tool paths stay relative to the workspace root, work dir or not", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    const written = await runWorkspaceTool({ store, signal, workDir }, "write_file", {
      path: "report.md",
      content: "done",
    });
    expect(written.ok).toBe(true);
    expect(readFileSync(join(root, "report.md"), "utf8")).toBe("done");
    expect(existsSync(join(root, workDir, "report.md"))).toBe(false);
    close();
  });

  test("shell reports the files it left in the work dir", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "mkdir -p charts && echo png > charts/q3.png && echo csv > data.csv",
    });
    expect(ran.ok).toBe(true);
    // This is the hole being closed: `write_file` announces its path, a command never did.
    expect(ran.data?.paths).toEqual([`${workDir}/charts/q3.png`, `${workDir}/data.csv`]);
    close();
  });

  test("shell reports nothing when it changed nothing", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    mkdirSync(join(root, workDir), { recursive: true });
    writeFileSync(join(root, workDir, "data.csv"), "old");
    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "cat data.csv",
    });
    expect(ran.ok).toBe(true);
    expect(ran.data?.paths).toBeUndefined();
    close();
  });

  test("the reserved subdirs are never reported as produced", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "mkdir -p scratch tool-results && echo x > scratch/probe.py && echo y > tool-results/a.json && echo z > kept.txt",
    });
    expect(ran.ok).toBe(true);
    expect(ran.data?.paths).toEqual([`${workDir}/kept.txt`]);
    close();
  });

  test("a command that makes hundreds of files reports none of them, flagged", async () => {
    const { store, root, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const workDir = "work/2026-09-21-x-7f3k";
    const ran = await runWorkspaceTool({ store, signal, workDir }, "shell", {
      command: "for i in $(seq 1 300); do echo $i > f$i.txt; done",
    });
    expect(ran.ok).toBe(true);
    // `npm install` is not a list of artifacts; the turn says so rather than dumping it.
    expect(ran.data?.paths).toBeUndefined();
    expect(ran.data?.paths_truncated).toBe(true);
    close();
  });

  test("a turn with no work dir reports nothing, as before", async () => {
    const { store, close } = await storeWithWorkspace();
    const signal = new AbortController().signal;
    const ran = await runWorkspaceTool({ store, signal }, "shell", { command: "echo hi > loose.txt" });
    expect(ran.ok).toBe(true);
    expect(ran.data?.paths).toBeUndefined();
    expect(ran.data?.paths_truncated).toBeUndefined();
    close();
  });

  test("shell gives up on a command that outlives its timeout", async () => {
    const { store, close } = await storeWithWorkspace();
    const started = Date.now();
    const got = await runWorkspaceTool(
      { store, signal: new AbortController().signal, shellTimeoutMs: 150 },
      "shell",
      { command: "sleep 30" },
    );
    expect(got.ok).toBe(false);
    expect(got.error?.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
    close();
  });

  test("shell does not count time the Mac slept against the command", async () => {
    const { store, close } = await storeWithWorkspace();
    const wake = createWakeWatch({ beatMs: 10 });
    try {
      const running = runWorkspaceTool(
        { store, signal: new AbortController().signal, shellTimeoutMs: 400, wake },
        "shell",
        { command: "sleep 1.2; echo done" },
      );
      await Bun.sleep(100);
      // The daemon is frozen for a second, the way a shut lid freezes it; its timeout is long overdue
      // when it thaws, but the command has only had a moment of awake time.
      const until = Date.now() + 1000;
      while (Date.now() < until) {
        // spin
      }
      const got = await running;
      expect(got.ok).toBe(true);
      expect(got.data?.stdout).toBe("done\n");
    } finally {
      wake.stop();
      close();
    }
  });

  test("shell comes back when a grandchild holds the output pipe open", async () => {
    const { store, close } = await storeWithWorkspace();
    const got = await runWorkspaceTool(
      { store, signal: new AbortController().signal, shellTimeoutMs: 150 },
      "shell",
      { command: "sleep 30 & echo started" },
    );
    expect(got.ok).toBe(false);
    expect(got.error?.message).toContain("timed out");
    close();
  });

  test("Always allow outside-write with a matching prefix writes without a card", async () => {
    const { store, close } = await storeWithWorkspace();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-allow-")));
    dirs.push(elsewhere);
    store.createAllowRule("outside-write", elsewhere);
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "write_file", {
      path: join(elsewhere, "a.md"),
      content: "allowed",
    });
    expect(got.ok).toBe(true);
    expect(got.waitApproval).toBeUndefined();
    expect(readFileSync(join(elsewhere, "a.md"), "utf8")).toBe("allowed");
    close();
  });
});

describe("read_file and annotations", () => {
  test("names the pending annotations on a file, and nothing when there are none", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-bot-read-annotations-"));
    dirs.push(root);
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    store.patchSettingsSync({ workspace_path: root });
    writeFileSync(join(root, "report.md"), "# Title\n");
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const delivery = store.insertMessage({ sessionId: writer.direct_session.id, kind: "bot", author: writer.bot.id, body: "report.md", paths: ["report.md"] });
    const signal = new AbortController().signal;
    const quiet = await runWorkspaceTool({ store, signal }, "read_file", { path: "report.md" });
    expect(quiet.data).toEqual({ path: "report.md", content: "# Title\n" });
    const a = store.createAnnotation({
      target_message_id: delivery.id, relpath: "report.md", anchor_kind: "text_range",
      anchor: { start_line: 1, start_col: 1, end_line: 1, end_col: 3, quote: "# ", prefix: "", suffix: "" },
      content_sha256: "0".repeat(64), body: "标题",
    });
    // A draft is not pending yet.
    expect((await runWorkspaceTool({ store, signal }, "read_file", { path: "report.md" })).data?.hint).toBeUndefined();
    store.sendAnnotations({ session_id: writer.direct_session.id, body: "", annotation_ids: [a.id] });
    const flagged = await runWorkspaceTool({ store, signal }, "read_file", { path: "./report.md" });
    expect(flagged.data?.pending_annotations).toBe(1);
    expect(String(flagged.data?.hint)).toContain("这个文件有 1 条待处理批注，用 list_annotations 查看");
    store.close();
  });
});
