import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procStartTime, recordLiveProc, stopGroup, stopOrphanProcs } from "./live-procs";
import { memoryKeyStore } from "./secrets";
import { Store, type LiveProc } from "./store";
import { runWorkspaceTool } from "./workspace-tools";

// Real process groups and real signals: these run wherever there are groups to signal.
const posix = process.platform !== "win32";

const dirs: string[] = [];
const strays: number[] = [];

afterEach(() => {
  // Whatever a failing assertion left running is not left for the rest of the suite.
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "real-bot-procs-")));
  dirs.push(dir);
  return dir;
}

async function storeWithWorkspace(): Promise<{ store: Store; root: string }> {
  const root = tempDir();
  const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
  await store.patchSettings({ workspace_path: root });
  return { store, root };
}

function rows(store: Store): LiveProc[] {
  return store.db.query<LiveProc, []>(`SELECT * FROM live_procs ORDER BY boot_id, pid`).all();
}

/** A row another run wrote; unless it says otherwise, that run was this process before a `bun --watch` restart. */
function insertRow(store: Store, row: Partial<LiveProc> & { boot_id: string; pid: number }): void {
  store.db.run(
    `INSERT INTO live_procs
       (boot_id, pid, pgid, turn_id, tool_call_id, command, started_at, proc_start_time, platform, daemon_pid, daemon_start_time)
     VALUES (?, ?, ?, NULL, NULL, 'x', '2026-09-30T00:00:00.000Z', ?, ?, ?, ?)`,
    [row.boot_id, row.pid, row.pgid === undefined ? row.pid : row.pgid, row.proc_start_time ?? null, row.platform ?? process.platform,
      row.daemon_pid ?? process.pid, row.daemon_start_time ?? null],
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

/** Waits for a command to write its pid file, then reads it. */
async function pidFrom(path: string): Promise<number> {
  expect(await until(() => existsSync(path) && readFileSync(path, "utf8").trim() !== "")).toBe(true);
  const pid = Number(readFileSync(path, "utf8").trim());
  strays.push(pid);
  return pid;
}

describe("a shell's process group", () => {
  test.skipIf(!posix)("a stop takes down what the command started, not just its shell", async () => {
    const { store, root } = await storeWithWorkspace();
    const abort = new AbortController();
    const command = "sleep 30 & echo $! > grandchild.pid; wait";
    const running = runWorkspaceTool({ store, signal: abort.signal, turnId: "turn-1", toolCallId: "call-1" }, "shell", { command });
    const grandchild = await pidFrom(join(root, "grandchild.pid"));
    const [row] = rows(store);
    expect(row).toMatchObject({ boot_id: store.bootId, turn_id: "turn-1", tool_call_id: "call-1", command, platform: process.platform });
    // The shell leads a group of its own, and the row names that group.
    expect(row!.pgid).toBe(row!.pid);
    expect(alive(grandchild)).toBe(true);

    abort.abort();
    const got = await running;
    expect(got.error?.message).toBe("interrupted");
    // On a Mac only the sh used to get the signal; the sleep under it ran on for its 30 seconds.
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(await until(() => rows(store).length === 0)).toBe(true);
    store.close();
  });

  test.skipIf(!posix)("what ignores SIGTERM gets SIGKILL once the grace is up", async () => {
    const { store, root } = await storeWithWorkspace();
    const abort = new AbortController();
    const running = runWorkspaceTool({ store, signal: abort.signal, stopGraceMs: 400 }, "shell", {
      command: `sh -c 'trap "" TERM; echo $$ > stubborn.pid; exec sleep 30' & wait`,
    });
    const stubborn = await pidFrom(join(root, "stubborn.pid"));
    abort.abort();
    // A stop does not wait on the grace: the call is over as soon as the SIGTERM is out.
    expect((await running).error?.message).toBe("interrupted");
    await Bun.sleep(100);
    expect(alive(stubborn)).toBe(true);
    expect(await until(() => !alive(stubborn))).toBe(true);
    store.close();
  });

  test.skipIf(!posix)("the timeout takes the command's children with it too", async () => {
    const { store, root } = await storeWithWorkspace();
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal, shellTimeoutMs: 300 }, "shell", {
      command: "sleep 30 & echo $! > background.pid",
    });
    expect(got.error?.message).toContain("timed out");
    const background = await pidFrom(join(root, "background.pid"));
    expect(await until(() => !alive(background))).toBe(true);
    store.close();
  });

  test.skipIf(!posix)("a command that cannot be put on record is killed, and the call fails", async () => {
    const { store } = await storeWithWorkspace();
    const refused: number[] = [];
    // What a full disk or a database locked by someone else does to the insert.
    (store as unknown as { registerLiveProc: (input: { pid: number }) => void }).registerLiveProc = (input) => {
      refused.push(input.pid);
      strays.push(input.pid);
      throw new Error("database or disk is full");
    };
    const got = await runWorkspaceTool({ store, signal: new AbortController().signal }, "shell", { command: "sleep 30" });
    expect(got.error?.message).toBe("shell failed");
    expect(refused).toHaveLength(1);
    expect(await until(() => !alive(refused[0]!))).toBe(true);
    expect(rows(store)).toEqual([]);
    store.close();
  });

  test.skipIf(!posix)("a command is on record, with the OS's start time, until it exits", async () => {
    const { store } = await storeWithWorkspace();
    const running = runWorkspaceTool({ store, signal: new AbortController().signal }, "shell", { command: "sleep 0.6; echo done" });
    expect(await until(() => rows(store)[0]?.proc_start_time != null)).toBe(true);
    const [row] = rows(store);
    expect(row!.proc_start_time).toBe((await procStartTime(row!.pid))!);
    // And whose it is: this daemon, as the OS knows it.
    expect(row!.daemon_pid).toBe(process.pid);
    expect(row!.daemon_start_time).toBe((await procStartTime(process.pid))!);
    const got = await running;
    expect(got.data?.stdout).toBe("done\n");
    expect(await until(() => rows(store).length === 0)).toBe(true);
    store.close();
  });
});

describe("the start time", () => {
  test.skipIf(!posix)("reads the same for a process every time, and nothing for a pid nobody holds", async () => {
    const first = await procStartTime(process.pid);
    expect(first).not.toBeNull();
    expect(await procStartTime(process.pid)).toBe(first);
    expect(await procStartTime(999_999_999)).toBeNull();
  });

  test("win32 asks PowerShell for the FILETIME and trims what comes back", async () => {
    let argv: string[] = [];
    const fakeSpawn = ((args: string[]) => {
      argv = args;
      return { stdout: new Response("133417334123456789\r\n").body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    expect(await procStartTime(4242, "win32", fakeSpawn)).toBe("133417334123456789");
    expect(argv.at(-1)).toContain("Get-Process -Id 4242");
    expect(argv.at(-1)).toContain("ToFileTimeUtc()");
  });
});

describe("the boot cleanup", () => {
  test.skipIf(!posix)("the next boot stops a command the last one left running", async () => {
    const db = join(tempDir(), "state.sqlite");
    const pidFile = join(tempDir(), "grandchild.pid");
    const earlier = new Store({ filename: db, endpointKey: memoryKeyStore() });
    // Spawned and recorded the way `shell` does it; then that daemon is gone without a word.
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 30 & echo $! > '${pidFile}'; wait`], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    strays.push(leader.pid);
    recordLiveProc(earlier, leader, { pgid: leader.pid, turnId: "turn-1", toolCallId: "call-1", command: "render" });
    const grandchild = await pidFrom(pidFile);
    expect(await until(() => rows(earlier)[0]?.daemon_start_time != null)).toBe(true);
    earlier.close();

    // The same process opening the file again is what a `bun --watch` restart looks like: the
    // recorded daemon is still "running", with this very pid and start time, and is an earlier run.
    const next = new Store({ filename: db, endpointKey: memoryKeyStore() });
    const log: string[] = [];
    const sweep = await stopOrphanProcs(next, { stopGroup: (pgid) => stopGroup(pgid, 200), log: (line) => log.push(line) });
    expect(sweep).toEqual({ stopped: 1, reused: 0, gone: 0, owned: 0 });
    await leader.exited;
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(rows(next)).toEqual([]);
    expect(log.join("\n")).toContain(`stopping pid ${leader.pid} (turn turn-1, call call-1)`);
    // The command line stays out of the log.
    expect(log.join("\n")).not.toContain("render");
    next.close();
  });

  test.skipIf(!posix)("a daemon on a copy of a live database leaves the live daemon's commands alone", async () => {
    const live = join(tempDir(), "state.sqlite");
    const pidFile = join(tempDir(), "command.pid");
    // The live daemon is a process of its own: it records a command the way `shell` does, says
    // which once both start times are on the row, and stays up.
    const script = `
      const { Store } = await import(${JSON.stringify(join(import.meta.dir, "store"))});
      const { memoryKeyStore } = await import(${JSON.stringify(join(import.meta.dir, "secrets"))});
      const { recordLiveProc } = await import(${JSON.stringify(join(import.meta.dir, "live-procs"))});
      const store = new Store({ filename: ${JSON.stringify(live)}, endpointKey: memoryKeyStore() });
      const command = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      recordLiveProc(store, command, { pgid: command.pid, command: "render" });
      while (!store.db.query("SELECT daemon_start_time FROM live_procs").get()?.daemon_start_time) await Bun.sleep(20);
      await Bun.write(${JSON.stringify(pidFile)}, String(command.pid));
      setInterval(() => {}, 1000);
    `;
    const daemon = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    strays.push(daemon.pid);
    const command = await pidFrom(pidFile);

    // How a fixture replay starts: the file and its WAL copied while the live daemon keeps working.
    const copy = join(tempDir(), "state.sqlite");
    for (const suffix of ["", "-wal"]) if (existsSync(live + suffix)) copyFileSync(live + suffix, copy + suffix);
    const replay = new Store({ filename: copy, endpointKey: memoryKeyStore() });
    const log: string[] = [];
    const sweep = () => stopOrphanProcs(replay, { stopGroup: (pgid) => stopGroup(pgid, 200), log: (line) => log.push(line) });
    expect(await sweep()).toEqual({ stopped: 0, reused: 0, gone: 0, owned: 1 });
    await Bun.sleep(300);
    expect(alive(command)).toBe(true);
    expect(rows(replay)).toHaveLength(1);
    expect(log).toEqual([
      `[live-procs] pid ${command} (turn ?, call ?) belongs to daemon pid ${daemon.pid}, which is still running; left to it`,
    ]);

    // Once that daemon is gone without a word, its command is an orphan like any other.
    daemon.kill("SIGKILL");
    await daemon.exited;
    expect(await sweep()).toEqual({ stopped: 1, reused: 0, gone: 0, owned: 0 });
    expect(await until(() => !alive(command))).toBe(true);
    expect(rows(replay)).toEqual([]);
    replay.close();
  }, 15_000);

  test("only a recorded daemon that is still the same process, and not this one, keeps its rows", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    // 301's daemon still runs; 302's daemon pid has gone to another program; 303 was this process.
    insertRow(store, { boot_id: "live", pid: 301, proc_start_time: "p301", daemon_pid: 9_301, daemon_start_time: "d1" });
    insertRow(store, { boot_id: "earlier", pid: 302, proc_start_time: "p302", daemon_pid: 9_302, daemon_start_time: "d2" });
    insertRow(store, { boot_id: "watch", pid: 303, proc_start_time: "p303", daemon_start_time: "self" });
    const reads: number[] = [];
    const stopped: number[] = [];
    const log: string[] = [];
    const sweep = await stopOrphanProcs(store, {
      startTime: async (pid) => {
        reads.push(pid);
        if (pid === 9_301) return "d1";
        if (pid === 9_302) return "someone else";
        if (pid === process.pid) return "self";
        return `p${pid}`;
      },
      stopGroup: async (pgid) => {
        stopped.push(pgid);
      },
      // The rows are this host's platform, and on win32 the sweep walks a tree instead of a group:
      // never the real one, since these pids belong to nobody the test started.
      killTree: (pid) => {
        stopped.push(pid);
      },
      log: (line) => log.push(line),
    });
    expect(sweep).toEqual({ stopped: 2, reused: 0, gone: 0, owned: 1 });
    expect(stopped.sort()).toEqual([302, 303]);
    // A live daemon's command is not even looked up, and its row stays for that daemon to drop.
    expect(reads).not.toContain(301);
    expect(reads).not.toContain(process.pid);
    expect(rows(store).map((row) => [row.boot_id, row.pid])).toEqual([["live", 301]]);
    expect(log).toContain("[live-procs] pid 301 (turn ?, call ?) belongs to daemon pid 9301, which is still running; left to it");
    store.close();
  });

  test.skipIf(!posix)("a pid that now belongs to another process is left alone", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    const bystander = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    strays.push(bystander.pid);
    expect(await procStartTime(bystander.pid)).not.toBeNull();
    // What an earlier boot recorded for this pid: a process that started long before this one did.
    insertRow(store, { boot_id: "earlier", pid: bystander.pid, proc_start_time: "Thu Jan  1 00:00:00 1970" });
    const stopped: number[] = [];
    const log: string[] = [];
    const sweep = await stopOrphanProcs(store, {
      stopGroup: async (pgid) => {
        stopped.push(pgid);
      },
      log: (line) => log.push(line),
    });
    expect(sweep).toEqual({ stopped: 0, reused: 1, gone: 0, owned: 0 });
    expect(stopped).toEqual([]);
    expect(alive(bystander.pid)).toBe(true);
    expect(rows(store)).toEqual([]);
    expect(log).toEqual([`[live-procs] pid ${bystander.pid} (turn ?, call ?) from an earlier run is now another process; left alone`]);
    bystander.kill("SIGKILL");
    store.close();
  });

  test("this boot's rows stay; a gone process or an unread start time only loses its row", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    insertRow(store, { boot_id: store.bootId, pid: 101, proc_start_time: "same" });
    insertRow(store, { boot_id: "earlier", pid: 102, proc_start_time: "same" });
    insertRow(store, { boot_id: "earlier", pid: 103 });
    const stopped: number[] = [];
    const log: string[] = [];
    const sweep = await stopOrphanProcs(store, {
      startTime: async (pid) => (pid === 102 ? null : "same"),
      stopGroup: async (pgid) => {
        stopped.push(pgid);
      },
      log: (line) => log.push(line),
    });
    expect(sweep).toEqual({ stopped: 0, reused: 1, gone: 1, owned: 0 });
    expect(stopped).toEqual([]);
    expect(rows(store).map((row) => [row.boot_id, row.pid])).toEqual([[store.bootId, 101]]);
    expect(log).toEqual(["[live-procs] pid 103 (turn ?, call ?) from an earlier run never had its start time read; left running"]);
    store.close();
  });

  test("on win32 the tree of a root whose start time matches is walked, and nothing else", async () => {
    const store = new Store({ endpointKey: memoryKeyStore() });
    insertRow(store, { boot_id: "earlier", pid: 201, pgid: null, proc_start_time: "133", platform: "win32" });
    insertRow(store, { boot_id: "earlier", pid: 202, pgid: null, proc_start_time: "134", platform: "win32" });
    const walked: number[] = [];
    const stopped: number[] = [];
    const sweep = await stopOrphanProcs(store, {
      platform: "win32",
      startTime: async (pid) => (pid === 201 ? "133" : "999"),
      killTree: (pid) => walked.push(pid),
      stopGroup: async (pgid) => {
        stopped.push(pgid);
      },
      log: () => {},
    });
    expect(sweep).toEqual({ stopped: 1, reused: 1, gone: 0, owned: 0 });
    expect(walked).toEqual([201]);
    expect(stopped).toEqual([]);
    expect(rows(store)).toEqual([]);
    store.close();
  });
});
