import { afterEach, describe, expect, test } from "bun:test";
import {
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
