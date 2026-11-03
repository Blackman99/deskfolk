/**
 * The system's own secret stores, which no Bot reads whatever agent runs it: shared by the app's
 * own credential guard (`engine/agent/credentials.ts`) and Claude Code's (`claude-code/policy.ts`).
 */
import { posix } from "node:path";

/** A path in the macOS keychains, yours or the system's. `norm` is already resolved. */
export function isKeychainPath(norm: string, home: string, platform: NodeJS.Platform): boolean {
  return platform !== "win32" && (norm.startsWith(`${posix.join(home, "Library", "Keychains")}/`) || norm.startsWith("/Library/Keychains/"));
}

/** A command that asks the keychain for a secret (`security find-generic-password` and the like). */
export function asksKeychainForSecret(command: string, platform: NodeJS.Platform): boolean {
  return platform !== "win32" && /\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(command);
}
