/**
 * The system's own secret stores, which no Bot reads whatever agent runs it: shared by the app's
 * own credential guard (`engine/agent/credentials.ts`) and Claude Code's (`claude-code/policy.ts`).
 * macOS keeps them in its keychains; a Linux desktop in GNOME Keyring or KWallet, behind the
 * Secret Service (`org.freedesktop.secrets`) that Deskfolk's own keys go to there as well.
 *
 * The one agent that cannot be made to ask first (Antigravity) is refused less: only what signs an
 * agent in or holds the app's keys there, by the item's name ({@link asksKeychainForAgentSecret}).
 */
import { posix } from "node:path";
import { KEYCHAIN_SERVICE } from "@real-bot/protocol";

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

/** Asks the macOS keychain for one item, the one the command names: `security find-generic-password`, `find-internet-password`. */
const MAC_ONE_ITEM = /\bsecurity\s+find-(?:generic|internet)-password\b/;
/** Asks the macOS keychain for all it holds: `security dump-keychain`, `security export`. */
const MAC_EVERYTHING = /\bsecurity\s+(?:dump-keychain|export)\b/;
/** Asks the Linux keyring for one item, named by its attributes: `secret-tool lookup`. */
const LINUX_ONE_ITEM = /\bsecret-tool\s+lookup\b/;
/** What can hand over any item of the Linux keyring: `secret-tool search`, `kwallet-query`, the Secret Service or KWallet over D-Bus. */
const LINUX_EVERYTHING = /\bsecret-tool\s+search\b|\bkwallet-query\b|\borg\.freedesktop\.secrets\b|\borg\.kde\.kwalletd\d*\b/;

/**
 * A command that asks the keychain for a secret (`security find-generic-password` and the like),
 * or on Linux the keyring: `secret-tool lookup|search`, `kwallet-query`, or the Secret Service
 * itself over D-Bus (`gdbus`, `busctl`, `dbus-send`, a script — they all have to name it).
 */
export function asksKeychainForSecret(command: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false;
  if (platform === "linux" && (LINUX_ONE_ITEM.test(command) || LINUX_EVERYTHING.test(command))) return true;
  return MAC_ONE_ITEM.test(command) || MAC_EVERYTHING.test(command);
}

/**
 * The keychain items that sign your agents in and hold this app's own keys, by the service names
 * their makers give them: the app's ({@link KEYCHAIN_SERVICE}), Claude Code's
 * (`Claude Code-credentials`, with a hashed ending for an account's config directory, ADR 0061), and
 * Codex's where it keeps its sign-in in the keyring (`Codex Auth`, `Codex MCP Credentials`, as its
 * source names them). The other agents keep theirs in files (`isAgentSecretPath`).
 */
const AGENT_KEYCHAIN_ITEMS = [KEYCHAIN_SERVICE, "Claude Code-credentials", "Codex Auth", "Codex MCP Credentials"];

/** One of those names anywhere in a command, any case, a blank in it written as the shell takes it (`Claude\ Code-credentials`). */
const NAMES_AGENT_KEYCHAIN_ITEM = new RegExp(
  AGENT_KEYCHAIN_ITEMS.map((name) => name.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\\\?\\s+")).join("|"), "i");

/**
 * A command that asks the keychain for what signs one of your agents in or for this app's own keys
 * ({@link AGENT_KEYCHAIN_ITEMS}): it asks for an item and writes such an item's name anywhere — as
 * the item asked for, or in a variable the ask is built from — or it asks for all the keychain
 * holds, theirs with the rest (`security dump-keychain`, `export`; on Linux `secret-tool search`,
 * `kwallet-query`, the Secret Service over D-Bus).
 *
 * For the agent that cannot be made to ask first (ADR 0111 addendum 2026-11-26), where a refusal
 * stops the turn after the call has run. An ask for any other item — the test account you gave the
 * session to keep, a project's signing profile — is no agent's sign-in: it goes by the permission
 * mode, as does a call that asks for nothing (`security find-generic-password -h`). Which item an
 * ask names is not read off its arguments: a name is looked for in the whole command.
 */
export function asksKeychainForAgentSecret(command: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false;
  if (MAC_EVERYTHING.test(command) || (platform === "linux" && LINUX_EVERYTHING.test(command))) return true;
  return asksKeychainForSecret(command, platform) && NAMES_AGENT_KEYCHAIN_ITEM.test(command);
}
