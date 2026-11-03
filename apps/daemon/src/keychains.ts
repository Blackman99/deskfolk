/**
 * The system's own secret stores, which no Bot reads whatever agent runs it: shared by the app's
 * own credential guard (`engine/agent/credentials.ts`) and Claude Code's (`claude-code/policy.ts`).
 * macOS keeps them in its keychains; a Linux desktop in GNOME Keyring or KWallet, behind the
 * Secret Service (`org.freedesktop.secrets`) that Deskfolk's own keys go to there as well.
 */
import { posix } from "node:path";

/** Where GNOME Keyring and KWallet keep their files under your home folder, by default. */
const LINUX_KEYRING_DIRS = [
  ".local/share/keyrings",
  ".local/share/kwalletd",
  ".kde/share/apps/kwallet",
  ".kde4/share/apps/kwallet",
] as const;

/** A path in the macOS keychains or a Linux keyring, yours or the system's. `norm` is already resolved. */
export function isKeychainPath(norm: string, home: string, platform: NodeJS.Platform): boolean {
  if (platform === "linux" && LINUX_KEYRING_DIRS.some((dir) => `${norm}/`.startsWith(`${posix.join(home, dir)}/`))) return true;
  return platform !== "win32" && (norm.startsWith(`${posix.join(home, "Library", "Keychains")}/`) || norm.startsWith("/Library/Keychains/"));
}

/**
 * A command that asks the keychain for a secret (`security find-generic-password` and the like),
 * or on Linux the keyring: `secret-tool lookup|search`, `kwallet-query`, or the Secret Service
 * itself over D-Bus (`gdbus`, `busctl`, `dbus-send`, a script — they all have to name it).
 */
export function asksKeychainForSecret(command: string, platform: NodeJS.Platform): boolean {
  if (platform === "linux" && /\bsecret-tool\s+(lookup|search)\b|\bkwallet-query\b|\borg\.freedesktop\.secrets\b|\borg\.kde\.kwalletd\d*\b/.test(command)) return true;
  return platform !== "win32" && /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(command);
}
