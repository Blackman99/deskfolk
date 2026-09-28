import { describe, expect, test } from "bun:test";
import {
  envLookup,
  isCompiledBinary,
  killProcessTree,
  pickEnv,
  toolShell,
  windowsPowerShellFallback,
} from "./platform";

describe("isCompiledBinary", () => {
  test("POSIX compiled binaries live under /$bunfs/", () => {
    expect(isCompiledBinary("/$bunfs/root/real-bot-daemon")).toBe(true);
    expect(isCompiledBinary("/repo/apps/daemon/src/platform.ts")).toBe(false);
  });

  test("Windows compiled binaries embed at B:\\~BUN\\ (either slash direction)", () => {
    expect(isCompiledBinary("B:\\~BUN\\root\\real-bot-daemon.exe")).toBe(true);
    expect(isCompiledBinary("B:/~BUN/root/real-bot-daemon.exe")).toBe(true);
    expect(isCompiledBinary("C:\\repo\\apps\\daemon\\src\\platform.ts")).toBe(false);
  });
});

describe("envLookup / pickEnv", () => {
  test("exact match on every platform, including non-win32", () => {
    expect(envLookup({ PATH: "/bin" }, "PATH", "darwin")).toBe("/bin");
    expect(envLookup({}, "PATH", "darwin")).toBeUndefined();
  });

  test("win32 falls back to a case-insensitive match", () => {
    expect(envLookup({ Path: "C:\\Windows" }, "PATH", "win32")).toBe("C:\\Windows");
    expect(envLookup({ path: "C:\\Windows" }, "PATH", "win32")).toBe("C:\\Windows");
  });

  test("non-win32 never does the case-insensitive fallback", () => {
    expect(envLookup({ Path: "/bin" }, "PATH", "darwin")).toBeUndefined();
  });

  test("pickEnv copies only what's present, case-insensitively on win32", () => {
    expect(pickEnv({ SystemRoot: "C:\\Windows", HOME: "/x" }, ["SystemRoot", "windir"], "win32")).toEqual({
      SystemRoot: "C:\\Windows",
    });
  });
});

describe("windowsPowerShellFallback", () => {
  test("uses SystemRoot when set", () => {
    expect(windowsPowerShellFallback({ SystemRoot: "C:\\Windows" }, "win32")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  test("defaults to C:\\Windows when SystemRoot is unset", () => {
    expect(windowsPowerShellFallback({}, "win32")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe("toolShell", () => {
  test("non-win32 is unchanged: /bin/sh -c <command>, kind sh", () => {
    const shell = toolShell({}, "darwin", () => false);
    expect(shell.kind).toBe("sh");
    expect(shell.argv("echo hi")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(shell.label).toBe("/bin/sh");
  });

  test("REAL_BOT_TOOL_SHELL overrides everything else, as bash", () => {
    const env = { REAL_BOT_TOOL_SHELL: "D:\\tools\\bash.exe", ProgramFiles: "C:\\Program Files" };
    const shell = toolShell(env, "win32", (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe");
    expect(shell.kind).toBe("bash");
    expect(shell.argv("echo hi")).toEqual(["D:\\tools\\bash.exe", "-c", "echo hi"]);
  });

  test("REAL_BOT_TOOL_SHELL overrides everything else, as powershell", () => {
    const shell = toolShell({ REAL_BOT_TOOL_SHELL: "C:\\tools\\pwsh.exe" }, "win32", () => true);
    expect(shell.kind).toBe("powershell");
    expect(shell.argv("Get-Item .")).toEqual([
      "C:\\tools\\pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Item .",
    ]);
  });

  test("Git Bash found via %ProgramFiles%", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    const shell = toolShell(env, "win32", (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe");
    expect(shell.kind).toBe("bash");
    expect(shell.label).toBe("Git Bash");
    expect(shell.argv("ls")).toEqual(["C:\\Program Files\\Git\\bin\\bash.exe", "-c", "ls"]);
  });

  test("Git Bash found via %LOCALAPPDATA%\\Programs\\Git when Program Files has none", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const target = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    const shell = toolShell(env, "win32", (path) => path === target);
    expect(shell.kind).toBe("bash");
    expect(shell.argv("ls")[0]).toBe(target);
  });

  test("Git Bash derived from git.exe on PATH when no Program Files install exists", () => {
    const env = { PATH: "C:\\Windows\\System32;C:\\tools\\Git\\cmd" };
    const gitExe = "C:\\tools\\Git\\cmd\\git.exe";
    const target = "C:\\tools\\Git\\bin\\bash.exe";
    const shell = toolShell(env, "win32", (path) => path === gitExe || path === target);
    expect(shell.kind).toBe("bash");
    expect(shell.argv("ls")[0]).toBe(target);
  });

  test("WSL's bash.exe in System32 is never chosen even if it exists and leads PATH", () => {
    const env = { PATH: "C:\\Windows\\System32;C:\\tools\\Git\\cmd" };
    // Only System32\bash.exe "exists" (simulating WSL) — no git.exe, no Git Bash anywhere,
    // and no pwsh.exe either, so this must fall through to Windows PowerShell.
    const shell = toolShell(env, "win32", (path) => path === "C:\\Windows\\System32\\bash.exe");
    expect(shell.kind).toBe("powershell");
    expect(shell.label).toBe("Windows PowerShell");
  });

  test("only pwsh on PATH: no Git Bash anywhere, PowerShell via PATH", () => {
    const env = { PATH: "C:\\Windows\\System32;C:\\tools\\pwsh" };
    const shell = toolShell(env, "win32", (path) => path === "C:\\tools\\pwsh\\pwsh.exe");
    expect(shell.kind).toBe("powershell");
    expect(shell.label).toBe("PowerShell");
    expect(shell.argv("Get-Item .")[0]).toBe("C:\\tools\\pwsh\\pwsh.exe");
  });

  test("only Windows PowerShell: nothing at all found, falls back to the bundled exe", () => {
    const shell = toolShell({ SystemRoot: "C:\\Windows" }, "win32", () => false);
    expect(shell.kind).toBe("powershell");
    expect(shell.label).toBe("Windows PowerShell");
    expect(shell.argv("Get-Item .")[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("PATH lookups match env var name case-insensitively (win32 'Path')", () => {
    const env = { Path: "C:\\tools\\pwsh" };
    const shell = toolShell(env, "win32", (path) => path === "C:\\tools\\pwsh\\pwsh.exe");
    expect(shell.kind).toBe("powershell");
    expect(shell.label).toBe("PowerShell");
  });
});

describe("killProcessTree", () => {
  test("non-win32 sends SIGKILL to just the one pid (today's per-call-site behaviour)", () => {
    let killed: unknown[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number, signal: string) => {
      killed = [pid, signal];
      return true;
    }) as typeof process.kill;
    try {
      killProcessTree(4242, "darwin");
    } finally {
      process.kill = originalKill;
    }
    expect(killed).toEqual([4242, "SIGKILL"]);
  });

  test("win32 shells out to taskkill /PID <pid> /T /F", () => {
    let called: unknown[] = [];
    const fakeSpawn = ((argv: unknown[]) => {
      called = argv;
      return {} as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    killProcessTree(4242, "win32", fakeSpawn);
    expect(called).toEqual(["taskkill", "/PID", "4242", "/T", "/F"]);
  });

  test("win32 swallows a spawn failure rather than throwing", () => {
    const throwingSpawn = (() => {
      throw new Error("no taskkill here");
    }) as unknown as typeof Bun.spawn;
    expect(() => killProcessTree(4242, "win32", throwingSpawn)).not.toThrow();
  });
});
