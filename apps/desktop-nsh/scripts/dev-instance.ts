/**
 * The NSH dev build's own instance: a port, a data directory and a Keychain service of its own,
 * so the installed stable Deskfolk keeps 17890, its data and its credentials while this one is
 * debugged beside it. Nothing here may fall back to the stable instance's values.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultAppDataDir, KEYCHAIN_SERVICE, LOCAL_API_BIND, LOCAL_API_PORT } from "../../../packages/protocol/src/index.ts";

export const DEV_HOST = "127.0.0.1";
export const DEV_PORT = 17990;
export const DEV_BIND = `${DEV_HOST}:${DEV_PORT}`;
export const DEV_ORIGIN = `http://${DEV_BIND}`;

/** A Keychain service of its own: the stable one's legacy items must stay out of reach. */
export const DEV_KEYCHAIN_SERVICE = `${KEYCHAIN_SERVICE}.nsh-dev`;
export const DEV_BUNDLE_ID = "com.real-bot.desktop.nsh-dev";
export const DEV_APP_NAME = "Deskfolk Dev";

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
