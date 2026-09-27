import { afterEach, expect, test } from "bun:test";
import type { Terminal } from "@real-bot/protocol";
import type { MessengerApi } from "./messenger-api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { emptySnapshot } from "./snapshot.ts";
import type { PaneContent } from "./workbench/pane-content.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.destroy();
});

const shell = (cwd: string): Terminal => ({
  id: "term-1",
  title: cwd.split("/").at(-1) ?? "",
  cwd,
  rows: 24,
  cols: 80,
  created_at: "2026-09-27T00:00:00.000Z",
  status: "live",
  exit_code: null,
}) as Terminal;

function fixture(opts: { refuse?: boolean } = {}) {
  const rt = new MessengerRuntime();
  runtimes.push(rt);
  const opened: string[] = [];
  const held: Terminal[] = [];
  const api = {
    openTerminal: async (cwd: string) => {
      opened.push(cwd);
      if (opts.refuse) throw new Error("no helper");
      held.push(shell(cwd));
      return held.at(-1)!;
    },
    // The daemon's list, which a refresh after opening the page reads back.
    terminals: async () => [...held],
  } as unknown as MessengerApi;
  (rt as unknown as { api: MessengerApi | null }).api = api;
  rt.snapshot = { ...emptySnapshot(), settings: { ...emptySnapshot().settings, workspace_path: "/Users/me/ws" } };
  return { rt, opened };
}

test("a terminal opened at a folder starts there and lands in a tab of its own on the desktop", async () => {
  const { rt, opened } = fixture();
  const panes: PaneContent[] = [];
  rt.paneOpener = (content) => panes.push(content);
  await rt.openTerminalAt("/Users/me/ws/out/assets");
  expect(opened).toEqual(["/Users/me/ws/out/assets"]);
  expect(panes).toEqual([{ kind: "terminal", terminalId: "term-1", cwd: "/Users/me/ws/out/assets" }]);
  expect(rt.terminals.map((row) => row.id)).toEqual(["term-1"]);
  expect(rt.terminalOpen).toBe(false);
});

test("without a workbench the phone's terminal page opens over the workspace, showing the new shell", async () => {
  const { rt } = fixture();
  rt.workspaceOpen = true;
  await rt.openTerminalAt("/Users/me/ws/out");
  expect(rt.terminalOpen).toBe(true);
  expect(rt.workspaceOpen).toBe(false);
  expect(rt.terminals.map((row) => row.cwd)).toEqual(["/Users/me/ws/out"]);
});

test("a shell the daemon will not start opens nothing, and a plain new terminal still starts at the root", async () => {
  const refused = fixture({ refuse: true });
  const panes: PaneContent[] = [];
  refused.rt.paneOpener = (content) => panes.push(content);
  await refused.rt.openTerminalAt("/Users/me/ws/out");
  expect(panes).toEqual([]);
  expect(refused.rt.terminalOpen).toBe(false);

  const plain = fixture();
  await plain.rt.startTerminal();
  expect(plain.opened).toEqual(["/Users/me/ws"]);
});
