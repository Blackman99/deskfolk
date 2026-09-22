import { expect, test } from "bun:test";
import type { StreamFrame, ToolFrame } from "@real-bot/protocol";
import { ACTIVITY_TAIL_BYTES, CommandActivity, summarize } from "./command-activity.ts";
import { encodeBase64 } from "../overlays/terminals.ts";

const started = (over: Partial<ToolFrame> = {}): ToolFrame => ({
  type: "tool", turn_id: "T", id: "c1", name: "shell", phase: "started",
  command: "pnpm build", ...over,
});
const exited = (over: Partial<ToolFrame> = {}): ToolFrame => ({
  type: "tool", turn_id: "T", id: "c1", name: "shell", phase: "exited",
  exit_code: 0, duration_ms: 8200, ...over,
});
const chunk = (text: string, offset = 0, id = "T:c1"): StreamFrame => ({
  type: "stream", id, offset, data: encodeBase64(new TextEncoder().encode(text)),
});

test("a command appears when it starts and carries its own output", () => {
  const activity = new CommandActivity();
  activity.applyTool(started());
  activity.applyStream(chunk("vite building…\n"));
  const [row] = activity.forTurn("T");
  expect(row!.command).toBe("pnpm build");
  expect(row!.running).toBe(true);
  expect(row!.text).toBe("vite building…\n");
});

test("output that arrives before the start is not attributed to nothing", () => {
  const activity = new CommandActivity();
  activity.applyStream(chunk("orphan"));
  expect(activity.forTurn("T")).toHaveLength(0);
});

test("finishing folds it into one line", () => {
  const activity = new CommandActivity();
  activity.applyTool(started());
  activity.applyStream(chunk("done\n"));
  activity.applyTool(exited());
  const [row] = activity.forTurn("T");
  expect(row!.running).toBe(false);
  expect(row!.exitCode).toBe(0);
  expect(summarize(row!)).toBe("pnpm build · exit 0 · 8.2s");
  expect(row!.text).toBe("done\n");
});

test("only shell earns a row; the quick tools would just be noise", () => {
  const activity = new CommandActivity();
  activity.applyTool(started({ name: "write_file", command: undefined }));
  expect(activity.forTurn("T")).toHaveLength(0);
});

test("a duplicated frame does not print twice", () => {
  const activity = new CommandActivity();
  activity.applyTool(started());
  activity.applyStream(chunk("hello"));
  activity.applyStream(chunk("hello"));
  expect(activity.forTurn("T")[0]!.text).toBe("hello");
});

test("the tail is kept, not the whole build log", () => {
  const activity = new CommandActivity();
  activity.applyTool(started());
  const big = "x".repeat(ACTIVITY_TAIL_BYTES + 500);
  activity.applyStream(chunk(big));
  const [row] = activity.forTurn("T");
  expect(row!.text.length).toBe(ACTIVITY_TAIL_BYTES);
});

test("two commands in one turn keep their own output and order", () => {
  const activity = new CommandActivity();
  activity.applyTool(started({ id: "c1", command: "pnpm build" }));
  activity.applyStream(chunk("build", 0, "T:c1"));
  activity.applyTool(started({ id: "c2", command: "pnpm test" }));
  activity.applyStream(chunk("test", 0, "T:c2"));
  const rows = activity.forTurn("T");
  expect(rows.map((row) => row.command)).toEqual(["pnpm build", "pnpm test"]);
  expect(rows.map((row) => row.text)).toEqual(["build", "test"]);
});

test("a finished turn leaves nothing behind", () => {
  const activity = new CommandActivity();
  activity.applyTool(started());
  activity.applyTool(started({ turn_id: "OTHER", id: "c9" }));
  activity.forget("T");
  expect(activity.forTurn("T")).toHaveLength(0);
  expect(activity.forTurn("OTHER")).toHaveLength(1);
});

test("a long command line is clipped rather than wrapped across the bubble", () => {
  const activity = new CommandActivity();
  activity.applyTool(started({ command: "echo " + "y".repeat(200) }));
  activity.applyTool(exited({ exit_code: 1, duration_ms: 450 }));
  const line = summarize(activity.forTurn("T")[0]!);
  expect(line.length).toBeLessThan(80);
  expect(line).toContain("exit 1");
  expect(line).toContain("450ms");
});
