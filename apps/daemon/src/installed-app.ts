/**
 * Which installed copy of the app shares this daemon's database, for the version gate's engine
 * level (`raiseEngineLevel` in store/schema-gate.ts). The installed app and a source run use the
 * same data folder by default, and the window starts its own bundled daemon whenever nothing
 * answers on the port, so an installed copy from before the gate can open a database a source run
 * moved on — that is what the engine level has to wait out.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
// Where apps live on a Mac, written the Mac's way whatever the host: the paths are only ever read on a Mac.
import { join } from "node:path/posix";
import type { SharedInstall } from "./store/schema-gate";

/**
 * The bundle names the desktop build has shipped under (tauri.conf.json `productName`): Deskfolk
 * since v0.1.0-rc.6, "Real Bot" before. Both have the same bundle id and data folder, and a copy
 * from before the rename cannot update itself into the new name, so it may well still be there.
 */
const APP_BUNDLES = ["Deskfolk.app", "Real Bot.app"];

/**
 * Null when no installed app shares the database: this daemon is the installed app's own (it was
 * compiled into it), or it runs on a data folder other than the default, which no installed app
 * opens. Otherwise the version of the oldest copy found where apps are installed on a Mac (empty
 * when one is there but its version cannot be read), or, when this is not a Mac, that there is no
 * telling what is installed. Both of those count as too old to share with.
 */
export function sharedInstalledVersion(input: {
  dataDir: string;
  defaultDataDir: string;
  compiled: boolean;
  platform?: string;
  home?: string;
  read?: (path: string) => string | null;
}): SharedInstall | null {
  if (input.compiled) return null;
  if (resolve(input.dataDir) !== resolve(input.defaultDataDir)) return null;
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") return { unseen: `a source run cannot tell which app is installed on ${platform}` };
  const read = input.read ?? readIfThere;
  const home = input.home ?? homedir();
  const versions: string[] = [];
  for (const root of ["/Applications", join(home, "Applications")]) {
    for (const bundle of APP_BUNDLES) {
      const plist = read(join(root, bundle, "Contents", "Info.plist"));
      if (plist !== null) versions.push(bundleVersion(plist));
    }
  }
  if (versions.length === 0) return null;
  return { version: versions.reduce((oldest, version) => (older(version, oldest) ? version : oldest)) };
}

/** `CFBundleShortVersionString` from an XML property list; empty when it is not there (a binary plist, say). */
export function bundleVersion(plist: string): string {
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]?.trim() ?? "";
}

function older(a: string, b: string): boolean {
  if (!a) return true;
  if (!b) return false;
  try {
    return Bun.semver.order(a, b) < 0;
  } catch {
    return true;
  }
}

function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
