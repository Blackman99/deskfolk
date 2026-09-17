import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
