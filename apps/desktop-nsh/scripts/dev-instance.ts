/**
 * The NSH dev build's own instance: a port, a data directory and a Keychain service of its own,
 * so the installed stable Deskfolk keeps 17890, its data and its credentials while this one is
 * debugged beside it. Nothing here may fall back to the stable instance's values.
 *
 * The one way to the stable instance is asking for it by name, `--stable-instance`: the NSH build
 * then runs as the one you use, on your own conversations, settings and remote access, in place of
 * the installed app rather than beside it.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultAppDataDir,
  KEYCHAIN_SERVICE,
  LOCAL_API_BIND,
  LOCAL_API_DESCRIPTOR_NAME,
  LOCAL_API_PORT,
} from "../../../packages/protocol/src/index.ts";

export const DEV_HOST = "127.0.0.1";
export const DEV_PORT = 17990;
export const DEV_BIND = `${DEV_HOST}:${DEV_PORT}`;
export const DEV_ORIGIN = `http://${DEV_BIND}`;

/** A Keychain service of its own: the stable one's legacy items must stay out of reach. */
export const DEV_KEYCHAIN_SERVICE = `${KEYCHAIN_SERVICE}.nsh-dev`;
export const DEV_BUNDLE_ID = "com.real-bot.desktop.nsh-dev";
export const DEV_APP_NAME = "Deskfolk Dev";

/**
 * The app's icon, the one every build wears (`apps/desktop/scripts/app-icon` makes it), and its
 * name in a bundle's Resources (`CFBundleIconFile`; the shell also sets it on the Dock from there).
 */
export const APP_ICON = resolve(import.meta.dir, "../../desktop/src-tauri/icons/icon.icns");
export const APP_ICON_FILE = "icon.icns";

/** Puts the app icon in `app`'s Resources; true when it was missing or different. */
export function placeAppIcon(app: string, icon: string = APP_ICON): boolean {
  const resources = join(app, "Contents", "Resources");
  const target = join(resources, APP_ICON_FILE);
  const bytes = readFileSync(icon);
  try {
    if (readFileSync(target).equals(bytes)) return false;
  } catch {
    // Not there yet.
  }
  mkdirSync(resources, { recursive: true });
  writeFileSync(target, bytes);
  return true;
}

/**
 * Launch Services and the icon cache keep what they read when they first saw a bundle, and the
 * icon cache goes by the bundle directory's own mtime, which writing files inside it never moves:
 * a dev app first seen without an icon stayed blank (the Tauri shell's `dev_bundle.rs` met this).
 * So the directory's time moves, then the bundle is registered again.
 */
export function registerAppIcon(app: string, now: Date = new Date()): void {
  utimesSync(app, now, now);
  spawnSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", app],
    { stdio: "ignore" },
  );
}

type Where = { platform?: string; env?: Record<string, string | undefined> };

/** The stable instance's directory on this platform (`defaultAppDataDir`). */
export function stableDataDir(home: string = homedir(), where: Where = {}): string {
  return defaultAppDataDir({ platform: where.platform ?? process.platform, env: where.env ?? process.env, home });
}

/** Beside the stable one, never it. */
export function devDataDir(home: string = homedir(), where: Where = {}): string {
  return `${stableDataDir(home, where)}-nsh-dev`;
}

export type DevInstance = { bind: string; port: number; dataDir: string; keychainService: string };

export function devInstance(home: string = homedir(), where: Where = {}): DevInstance {
  return { bind: DEV_BIND, port: DEV_PORT, dataDir: devDataDir(home, where), keychainService: DEV_KEYCHAIN_SERVICE };
}

/** `dev.ts` and `dev-runtime.ts` take this to run on the stable instance (`stableInstance`). */
export const STABLE_INSTANCE_FLAG = "--stable-instance";

/**
 * The stable instance itself: 17890, the standard data directory and the `com.real-bot.daemon`
 * Keychain service, as the installed app's runtime and a source `apps/daemon` run use them.
 */
export function stableInstance(home: string = homedir(), where: Where = {}): DevInstance {
  return { bind: LOCAL_API_BIND, port: LOCAL_API_PORT, dataDir: stableDataDir(home, where), keychainService: KEYCHAIN_SERVICE };
}

/** The stable instance when `argv` asks for it by name, the dev instance otherwise. */
export function chosenInstance(argv: string[] = process.argv, home: string = homedir(), where: Where = {}): DevInstance {
  return argv.includes(STABLE_INSTANCE_FLAG) ? stableInstance(home, where) : devInstance(home, where);
}

export function originOf(instance: DevInstance): string {
  return `http://${instance.bind}`;
}

/**
 * The installed app's runtime, when it is the one holding `dataDir` (its descriptor names a live
 * process run out of an `.app` bundle). The NSH build takes the stable instance only in its place:
 * a window of the NSH build on the installed app's runtime would meet a daemon a release behind.
 */
export function installedRuntime(dataDir: string): { pid: number; command: string } | undefined {
  let pid: number;
  try {
    pid = (JSON.parse(readFileSync(join(dataDir, LOCAL_API_DESCRIPTOR_NAME), "utf8")) as { pid?: unknown }).pid as number;
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const command = ps.status === 0 ? ps.stdout.trim() : "";
  return isInstalledCommand(command) ? { pid, command } : undefined;
}

/** A process run out of an app bundle (`/Applications/Deskfolk.app/Contents/…`), not from source. */
export function isInstalledCommand(command: string): boolean {
  return /\.app\/Contents\//.test(command);
}

/**
 * The relay host id the dev database shares with the stable one, if any: a dev directory seeded
 * from the stable database carries its relay registration but not its keys (those are a file in the
 * stable directory), so a dev runtime with remote on would knock at the relay as your Mac with
 * keys of its own.
 */
export function sharedRemoteHost(devDir: string, stableDir: string): string | undefined {
  const dev = remoteHostId(join(devDir, "state.sqlite"));
  return dev !== undefined && dev === remoteHostId(join(stableDir, "state.sqlite")) ? dev : undefined;
}

function remoteHostId(database: string): string | undefined {
  if (!existsSync(database)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(database, { readonly: true });
    return db.query<{ host_id: string }, []>("SELECT host_id FROM remote_host WHERE singleton = 1").get()?.host_id ?? undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** Throws when any part of `instance` is the stable instance's. */
export function assertApartFromStable(instance: DevInstance, home: string = homedir(), where: Where = {}): void {
  if (instance.port === LOCAL_API_PORT || instance.bind === LOCAL_API_BIND) {
    throw new Error(`the dev instance must not use the stable port ${LOCAL_API_PORT}`);
  }
  if (resolve(instance.dataDir) === resolve(stableDataDir(home, where))) {
    throw new Error(`the dev instance must not use the stable data directory ${stableDataDir(home, where)}`);
  }
  if (instance.keychainService === KEYCHAIN_SERVICE) {
    throw new Error(`the dev instance must not use the stable Keychain service ${KEYCHAIN_SERVICE}`);
  }
}
