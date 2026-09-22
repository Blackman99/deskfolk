import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { StreamHub } from "./streams";
import { runWorkspaceTool } from "./workspace-tools";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function workspace(): Promise<{ store: Store; root: string; close: () => void }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-cs-")));
  dirs.push(root);
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  await store.patchSettings({ workspace_path: root });
  return { store, root, close: () => store.close() };
}

const text = (hub: StreamHub, id: string) => new TextDecoder().decode(hub.read(id).bytes);

test("a command's output is readable while it is still running", async () => {
  const { store, close } = await workspace();
  const streams = new StreamHub();
  const signal = new AbortController().signal;
  const id = "TURN:call_1";
  const running = runWorkspaceTool(
    { store, signal, stream: streams, streamId: id },
    "shell",
    { command: "echo FIRST; sleep 1; echo SECOND", cwd: "." },
  );
  // The whole point: this assertion happens before the command has finished.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !text(streams, id).includes("FIRST")) await Bun.sleep(50);
  expect(text(streams, id)).toContain("FIRST");
  expect(text(streams, id)).not.toContain("SECOND");

  const result = await running;
  expect(result.ok).toBe(true);
  expect(text(streams, id)).toContain("SECOND");
  close();
});

test("stderr shows up in the same stream, the way a terminal shows it", async () => {
  const { store, close } = await workspace();
  const streams = new StreamHub();
  const id = "TURN:call_2";
  const result = await runWorkspaceTool(
    { store, signal: new AbortController().signal, stream: streams, streamId: id },
    "shell",
    { command: "echo OUT; echo ERR 1>&2", cwd: "." },
  );
  expect(result.ok).toBe(true);
  expect(result.data?.stdout).toContain("OUT");
  expect(result.data?.stderr).toContain("ERR");
  const streamed = text(streams, id);
  expect(streamed).toContain("OUT");
  expect(streamed).toContain("ERR");
  close();
});

test("the stream closes when the command does", async () => {
  const { store, close } = await workspace();
  const streams = new StreamHub();
  const id = "TURN:call_3";
  await runWorkspaceTool(
    { store, signal: new AbortController().signal, stream: streams, streamId: id },
    "shell",
    { command: "echo done", cwd: "." },
  );
  expect(streams.read(id).closed).toBe(true);
  close();
});

test("a timed-out command still closes its stream, and still fails", async () => {
  const { store, close } = await workspace();
  const streams = new StreamHub();
  const id = "TURN:call_4";
  const result = await runWorkspaceTool(
    { store, signal: new AbortController().signal, stream: streams, streamId: id, shellTimeoutMs: 300 },
    "shell",
    { command: "echo BEFORE; sleep 30", cwd: "." },
  );
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain("timed out");
  expect(streams.read(id).closed).toBe(true);
  close();
});

test("streaming changes nothing about what a shell is", async () => {
  const { store, root, close } = await workspace();
  const streams = new StreamHub();
  const signal = new AbortController().signal;

  // stdin is still closed: a command that reads it gets EOF rather than hanging.
  const stdin = await runWorkspaceTool(
    { store, signal, stream: streams, streamId: "TURN:call_5" },
    "shell",
    { command: "cat; echo EOF_REACHED", cwd: "." },
  );
  expect(stdin.data?.stdout).toContain("EOF_REACHED");

  // Still classified per spawn: a command that reaches outside still waits for approval.
  const outside = await runWorkspaceTool(
    { store, signal, stream: streams, streamId: "TURN:call_6" },
    "shell",
    { command: `cat ${join(root, "..", "escape.txt")}`, cwd: "." },
  );
  expect(outside.waitApproval?.kind_key).toBe("unconstrained-shell");

  // Files a command produced are still attributed to it.
  const produced = await runWorkspaceTool(
    { store, signal, stream: streams, streamId: "TURN:call_7", workDir: "work/w" },
    "shell",
    { command: "echo hi > made.txt" },
  );
  expect(produced.data?.paths).toContain("work/w/made.txt");
  close();
});

test("without a stream id nothing is streamed and the tool still works", async () => {
  const { store, close } = await workspace();
  const streams = new StreamHub();
  const result = await runWorkspaceTool(
    { store, signal: new AbortController().signal, stream: streams },
    "shell",
    { command: "echo quiet", cwd: "." },
  );
  expect(result.data?.stdout).toContain("quiet");
  expect(streams.ids()).toEqual([]);
  close();
});
