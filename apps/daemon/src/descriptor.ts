import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APP_SUPPORT_DIRNAME,
  LOCAL_API_DESCRIPTOR_NAME,
  STATE_DB_NAME,
  type LocalApiDescriptor,
} from "@real-bot/protocol";

export function defaultDataDir(): string {
  return join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME);
}

export function descriptorPath(dataDir: string): string {
  return join(dataDir, LOCAL_API_DESCRIPTOR_NAME);
}

export function stateDbPath(dataDir: string): string {
  return join(dataDir, STATE_DB_NAME);
}

export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

export function writeDescriptor(dataDir: string, descriptor: LocalApiDescriptor): void {
  ensureDataDir(dataDir);
  const dest = descriptorPath(dataDir);
  const tmp = `${dest}.${process.pid}.tmp`;
  const body = `${JSON.stringify(descriptor, null, 2)}\n`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
}

export function removeDescriptor(dataDir: string): void {
  try {
    unlinkSync(descriptorPath(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function mintLocalToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function readDescriptor(dataDir: string): LocalApiDescriptor | null {
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath(dataDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.pid !== "number" || !Number.isInteger(row.pid)) return null;
    if (typeof row.port !== "number" || !Number.isInteger(row.port)) return null;
    if (typeof row.token !== "string" || row.token.length === 0) return null;
    if (typeof row.started_at !== "string") return null;
    return { pid: row.pid, port: row.port, token: row.token, started_at: row.started_at };
  } catch {
    return null;
  }
}

/** `kill(pid, 0)`: the process exists (including one we cannot signal). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
