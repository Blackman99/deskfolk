import { expect, test } from "bun:test";
import { claudeLaunch, killsTree, stopClaudeTree } from "./spawn";

const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", Path: "C:\\Windows" };
const args = ["--output-format", "stream-json", "--add-dir", "C:\\Users\\me\\ws", "--setting-sources="];

test("a native claude starts as itself, on every platform", () => {
  expect(claudeLaunch("/Users/me/.local/bin/claude", args, {}, "darwin")).toEqual({ command: "/Users/me/.local/bin/claude", args, verbatim: false });
  expect(claudeLaunch("C:\\Users\\me\\.local\\bin\\claude.exe", args, env, "win32")).toEqual({ command: "C:\\Users\\me\\.local\\bin\\claude.exe", args, verbatim: false });
});

test("npm's claude.cmd starts through cmd.exe, its arguments escaped and nothing looked up again", () => {
  const launch = claudeLaunch("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", args, env, "win32");
  expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(launch.verbatim).toBe(true);
  expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(launch.args[3]).toStartWith('"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd ');
  expect(launch.args[3]).toContain('^"--setting-sources=^"');
});

test("a stop on Windows walks claude's whole tree; elsewhere it signals the group", () => {
  const walked: Array<[number, string | undefined]> = [];
  stopClaudeTree(4242, "SIGKILL", "win32", (pid, platform) => {
    walked.push([pid, platform]);
  });
  expect(walked).toEqual([[4242, "win32"]]);
});

test("whoever kills claude — a Stop, or the SDK closing its session — stops the tree, until claude has exited", () => {
  const stopped: Array<[number, string]> = [];
  const own: Array<string | number | undefined> = [];
  const child = { pid: 77, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: (signal?: NodeJS.Signals | number) => { own.push(signal); return true; } };
  killsTree(child, (pid, signal) => { stopped.push([pid, signal]); });
  // The SDK's own close sends SIGKILL; a Stop here sends SIGTERM; a numbered signal counts as a stop.
  child.kill("SIGKILL");
  child.kill("SIGTERM");
  child.kill(9);
  expect(stopped).toEqual([[77, "SIGKILL"], [77, "SIGTERM"], [77, "SIGTERM"]]);
  expect(own).toEqual([]);
  child.exitCode = 0;
  child.kill("SIGKILL");
  expect(own).toEqual(["SIGKILL"]);
  expect(stopped).toHaveLength(3);
});
