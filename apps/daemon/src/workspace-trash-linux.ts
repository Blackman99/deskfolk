import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** The answer for a path on another disk when `gio` is not there to carry it over. */
export const LINUX_TRASH_OTHER_DISK = "not on the same disk as your home folder, so it cannot go to the Trash";

/** `$XDG_DATA_HOME/Trash` when that is an absolute path (the spec ignores a relative one), else `~/.local/share/Trash`. */
export function homeTrashDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(home, ".local", "share");
  return `${base.replace(/\/+$/, "")}/Trash`;
}

/** Bytes the spec leaves bare in `Path=`: RFC 2396 unreserved, plus the `/` between segments. */
const BARE = /[A-Za-z0-9\-_.!~*'()/]/;

function encodePath(path: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && BARE.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The body of a `.trashinfo` file. The date is local time with no zone, as the spec asks. */
export function trashInfo(originalPath: string, deletedAt: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const date =
    `${deletedAt.getFullYear()}-${two(deletedAt.getMonth() + 1)}-${two(deletedAt.getDate())}` +
    `T${two(deletedAt.getHours())}:${two(deletedAt.getMinutes())}:${two(deletedAt.getSeconds())}`;
  return `[Trash Info]\nPath=${encodePath(originalPath)}\nDeletionDate=${date}\n`;
}

export interface LinuxTrashOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  now?: () => Date;
  /** Path to `gio`, or null when there is none. */
  gio?: string | null;
  runGio?: (gio: string, path: string) => Promise<string>;
  /** Tests only: stands in for `renameSync` so a cross-disk move can be simulated. */
  rename?: (from: string, to: string) => void;
}

async function defaultRunGio(gio: string, path: string): Promise<string> {
  const child = Bun.spawn([gio, "trash", "--", path], { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited, new Response(child.stdout).text()]);
  return code === 0 ? "" : err.trim() || `gio trash exited ${code}`;
}

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** `name.tar.gz` -> `name.tar` + `.gz`; a leading dot (`.env`) is part of the stem, not an extension. */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "could not move to the Trash";
}

/**
 * Move paths into the home Trash by the freedesktop.org Trash spec: write `info/<name>.trashinfo`,
 * then rename into `files/<name>`. The info file is created exclusively so two trashers racing for
 * one name cannot overwrite each other; the loser takes the next number. A path on another disk
 * cannot be renamed into the home Trash, so it is handed to `gio trash`, which knows the per-disk
 * Trash folders; without `gio` it is left where it is.
 */
export async function trashOnLinux(abs: string[], options: LinuxTrashOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const trash = homeTrashDir(env, options.home ?? homedir());
  const now = options.now ?? (() => new Date());
  const gio = options.gio === undefined ? (Bun.which("gio") ?? null) : options.gio;
  const runGio = options.runGio ?? defaultRunGio;
  const rename = options.rename ?? renameSync;
  const answers: string[] = [];
  for (const path of abs) {
    try {
      answers.push(await trashOne(path));
    } catch (error) {
      answers.push(errorMessage(error));
    }
  }
  return answers;

  async function trashOne(path: string): Promise<string> {
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    mkdirSync(join(trash, "files"), { recursive: true });
    mkdirSync(join(trash, "info"), { recursive: true });
    const [stem, ext] = splitName(basename(path));
    let info = "";
    let target = "";
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`;
      info = join(trash, "info", `${name}.trashinfo`);
      target = join(trash, "files", name);
      if (exists(info) || exists(target)) continue;
      try {
        writeFileSync(info, trashInfo(path, now()), { flag: "wx" });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    try {
      rename(path, target);
      return "";
    } catch (error) {
      rmSync(info, { force: true });
      if (errorCode(error) === "EXDEV") return gio ? await runGio(gio, path) : LINUX_TRASH_OTHER_DISK;
      return errorMessage(error);
    }
  }
}
