/**
 * Every command a Bot's `shell` starts runs in a process group of its own and is on record in
 * `live_procs` from the moment it has a pid until it exits (ADR 0040 I10). That is what lets a stop
 * take the whole tree — `sh -c "… ffmpeg …"` used to stop only the `sh` on a Mac, while the ffmpeg
 * under it went on writing its file — and what lets the next boot stop whatever a crashed or
 * restarted daemon left running. A pid from an earlier boot is signalled only once the OS confirms
 * it still started when the row says: pids are reused, and one that has since gone to some other
 * program is left alone. Nor is a row whose daemon is still running: a daemon started on a copy of
 * the live database (a fixture replay, say) finds the live daemon's rows there, and those commands
 * are that daemon's to stop.
 *
 * win32 has no process groups. A stop there walks the tree with `killProcessTree`, as it already
 * did, and the boot cleanup does the same for a root whose start time still matches.
 */
import { readFileSync } from "node:fs";
import { killProcessTree, resolvePowerShell } from "./platform";
import type { LiveProc, Store } from "./store";

/** Between SIGTERM and SIGKILL: time for a renderer to close the file it is writing, no more. */
export const GROUP_STOP_GRACE_MS = 3_000;

/** The OS's own record of when `pid` started, as text to compare, or null when there is no such process. */
export type StartTimeReader = (pid: number) => Promise<string | null>;

/** False when nothing in the group was there to signal. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to the whole group, then SIGKILL to whatever is still in it once `graceMs` is up. The
 * group id cannot be handed to anyone else while a member is alive, so the second signal reaches
 * the same group or nothing.
 */
export function stopGroup(pgid: number, graceMs: number = GROUP_STOP_GRACE_MS): Promise<void> {
  if (!signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      signalGroup(pgid, "SIGKILL");
      resolve();
    }, graceMs);
  });
}

let kernelBootId: string | null | undefined;

/**
 * Linux counts a process's start in clock ticks since the kernel booted, which is exact where
 * `ps`'s wall-clock rendering of it drifts by a second between reads; the kernel's boot id goes
 * with it, since tick counts start over on every reboot.
 */
function linuxStartTime(pid: number): string | null {
  try {
    kernelBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    kernelBootId = null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name sits in parentheses and may hold spaces or parentheses of its own; the
    // fields after the last ")" are fixed, and starttime (field 22) is the twentieth of them.
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return ticks ? `${kernelBootId ?? ""}:${ticks}` : null;
  } catch {
    return null;
  }
}

async function readOutput(argv: string[], env: Record<string, string> | undefined, spawn: typeof Bun.spawn): Promise<string | null> {
  try {
    const proc = spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", ...(env ? { env } : {}) });
    const text = (await new Response(proc.stdout).text()).replace(/\s+/g, " ").trim();
    await proc.exited;
    return text || null;
  } catch {
    return null;
  }
}

export function procStartTime(
  pid: number,
  platform: string = process.platform,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<string | null> {
  if (platform === "linux") return Promise.resolve(linuxStartTime(pid));
  if (platform === "win32") {
    // A FILETIME count of 100 ns steps: exact, and the same whatever the zone or the locale.
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`;
    return readOutput([resolvePowerShell(), "-NoProfile", "-NonInteractive", "-Command", script], undefined, spawn);
  }
  // Seconds only, but a pid does not come round again within the same second. The zone and locale
  // are pinned because the text is compared with one read on a later boot, after either may change.
  return readOutput(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { LC_ALL: "C", TZ: "UTC" }, spawn);
}

let ownStartTime: Promise<string | null> | undefined;

/**
 * When the OS says this daemon started. Read once: it never changes, not even across a `bun --watch`
 * restart, which re-execs in place and keeps the pid too. A failed read is tried again next time.
 */
function daemonStartTime(): Promise<string | null> {
  ownStartTime ??= procStartTime(process.pid).then((startTime) => {
    if (startTime === null) ownStartTime = undefined;
    return startTime;
  });
  return ownStartTime;
}

/**
 * Puts a just-spawned command on record. Its pid only exists once the spawn has returned, so this
 * runs in the same tick, before anything awaits: from here on, however the daemon ends, the next
 * boot knows the process. The OS's start times, the command's and this daemon's, are read a moment
 * later and added to the row; the row goes when the process exits. Throws when the row cannot be
 * written, so the caller can refuse to let a command run unrecorded.
 */
export function recordLiveProc(
  store: Store,
  proc: { pid: number; exited: Promise<unknown> },
  input: { pgid: number | null; turnId?: string; toolCallId?: string; command: string },
): void {
  const { bootId } = store;
  const { pid } = proc;
  store.registerLiveProc({ bootId, pid, pgid: input.pgid, turnId: input.turnId, toolCallId: input.toolCallId,
    command: input.command, platform: process.platform, daemonPid: process.pid });
  // Either write can land after the store has closed on the way out; the row then waits for the
  // next boot, which finds its process gone or stops it.
  void Promise.all([procStartTime(pid), daemonStartTime()]).then(
    ([startTime, daemonStart]) => {
      // Both or neither: a row the next boot may act on always says whose daemon it was.
      if (!startTime || !daemonStart) return;
      try {
        store.noteLiveProcStart(bootId, pid, startTime, daemonStart);
      } catch {
        // store closed
      }
    },
    () => {},
  );
  const forget = () => {
    try {
      store.forgetLiveProc(bootId, pid);
    } catch {
      // store closed
    }
  };
  void proc.exited.then(forget, forget);
}

export type OrphanSweep = { stopped: number; reused: number; gone: number; owned: number };

/**
 * At boot: a row another boot wrote names a command that was still running when that daemon ended
 * (this boot's own rows are never looked at). If that daemon has not ended — it still runs with the
 * start time on record, so this one was opened on a copy of its database — the row is left as it
 * is: the command is that daemon's to stop. A recorded daemon pid equal to this process's own counts
 * as an earlier run all the same, since `bun --watch` restarts in place. Otherwise a command whose
 * pid still started at the recorded time is that very command, and its group gets SIGTERM, then
 * SIGKILL; one whose pid now started at another time belongs to some other program and is only
 * logged, as is one whose start time never got read. Those rows are dropped once dealt with.
 */
export async function stopOrphanProcs(
  store: Store,
  deps: {
    platform?: string;
    startTime?: StartTimeReader;
    stopGroup?: (pgid: number) => Promise<void>;
    killTree?: (pid: number) => void;
    log?: (line: string) => void;
  } = {},
): Promise<OrphanSweep> {
  const platform = deps.platform ?? process.platform;
  const startTime = deps.startTime ?? ((pid: number) => procStartTime(pid, platform));
  const stop = deps.stopGroup ?? ((pgid: number) => stopGroup(pgid));
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid, platform));
  const log = deps.log ?? ((line: string) => console.error(line));
  const sweep: OrphanSweep = { stopped: 0, reused: 0, gone: 0, owned: 0 };
  // One read per daemon, however many of its commands are on record.
  const daemons = new Map<number, Promise<string | null>>();
  const daemonRuns = (row: LiveProc): Promise<boolean> => {
    if (row.daemon_pid === process.pid || row.daemon_start_time === null || row.platform !== platform) {
      return Promise.resolve(false);
    }
    let read = daemons.get(row.daemon_pid);
    if (!read) daemons.set(row.daemon_pid, (read = startTime(row.daemon_pid)));
    return read.then((now) => now === row.daemon_start_time);
  };
  await Promise.all(
    store.liveProcsFromOtherBoots(store.bootId).map(async (row) => {
      // The command line stays out of the log: a Bot may have put a key in it.
      const which = `pid ${row.pid} (turn ${row.turn_id ?? "?"}, call ${row.tool_call_id ?? "?"})`;
      if (await daemonRuns(row)) {
        sweep.owned += 1;
        log(`[live-procs] ${which} belongs to daemon pid ${row.daemon_pid}, which is still running; left to it`);
        return;
      }
      const now = await startTime(row.pid);
      if (now === null) {
        sweep.gone += 1;
      } else if (row.proc_start_time === null || row.platform !== platform || now !== row.proc_start_time) {
        sweep.reused += 1;
        log(
          row.proc_start_time === null
            ? `[live-procs] ${which} from an earlier run never had its start time read; left running`
            : `[live-procs] ${which} from an earlier run is now another process; left alone`,
        );
      } else {
        sweep.stopped += 1;
        log(`[live-procs] stopping ${which}, still running from an earlier run`);
        if (platform === "win32") killTree(row.pid);
        else await stop(row.pgid ?? row.pid);
      }
      try {
        store.forgetLiveProc(row.boot_id, row.pid);
      } catch {
        // store closed
      }
    }),
  );
  return sweep;
}
