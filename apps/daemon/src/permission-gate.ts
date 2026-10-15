/**
 * How a Bot's permission mode (ADR 0092) meets one call, for every runner: the app's own tools
 * (`workspace-tools.ts`, the setup tools), a Claude Agent turn (`claude-code/policy.ts`) and the
 * other local agents (`engine/agent/policy.ts`). Reads are never asked about, so only a change — a
 * file written, moved or deleted, a command run — or a change to the app's setup comes here. Where
 * the call lands, in the workspace or not, does not matter.
 */
import { permissionVerdict, type PermissionClass, type PermissionMode, type PermissionVerdict } from "@real-bot/protocol";

/** The card kind of a file written, moved or deleted. */
export const FILE_WRITE_KIND = "file-write";
/** The card kind of a command. */
export const SHELL_KIND = "shell";

/** What a read-only Bot hears when it tries to change something. */
export const READ_ONLY_REFUSAL =
  "refused: this Bot's permission mode is read-only. It may read files and look things up, but not write, move or delete files, run commands, or change the app's setup. Work with what reading gives you and say in your reply what you would change; only the user can change the mode, in the Bot's panel.";

export function changeVerdict(mode: PermissionMode): PermissionVerdict {
  return permissionVerdict(mode, "change");
}

export function verdictFor(mode: PermissionMode, kind: PermissionClass): PermissionVerdict {
  return permissionVerdict(mode, kind);
}
