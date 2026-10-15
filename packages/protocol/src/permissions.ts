/**
 * Permission modes (ADR 0092): what a Bot may do without asking you. One mode is the app's default
 * (Settings › General); a Bot may carry its own, which only you set. The workspace is where Bots
 * keep what they make, not a line they need your OK to cross: a mode counts what a call does, never
 * where it does it.
 *
 * | mode        | read | write files, run commands | change the app's setup |
 * |-------------|------|---------------------------|------------------------|
 * | `read_only` | yes  | refused                   | refused                |
 * | `ask_first` | yes  | asks                      | asks                   |
 * | `auto`      | yes  | yes                       | asks                   |
 * | `allow_all` | yes  | yes                       | yes                    |
 *
 * Calling a configured MCP tool and looking things up on the web run in every mode. Refusals that
 * are not about your OK stay in every mode, `allow_all` included: no Bot reads a local agent's
 * sign-in, and a recursive search of your whole home or `/` is refused before it runs.
 */
export const PERMISSION_MODES = ["read_only", "ask_first", "auto", "allow_all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The app's default until you choose one. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * What a call that a mode may stop does: `change` writes, moves or deletes files or runs a command
 * (a command can do anything a write can); `setup` changes the app's own configuration — MCP
 * servers, endpoints, built-in prompts.
 */
export type PermissionClass = "change" | "setup";

export type PermissionVerdict = "allow" | "ask" | "refuse";

export function permissionVerdict(mode: PermissionMode, kind: PermissionClass): PermissionVerdict {
  if (mode === "allow_all") return "allow";
  if (mode === "read_only") return "refuse";
  if (mode === "ask_first") return "ask";
  return kind === "change" ? "allow" : "ask";
}

/** Approval kinds about the app's own setup; every other kind is a `change`. */
export const SETUP_APPROVAL_KINDS = ["mcp-add", "mcp-edit", "endpoint-add", "endpoint-edit", "prompt-edit"] as const;

export function permissionClassOf(kindKey: string | null | undefined): PermissionClass {
  return kindKey != null && (SETUP_APPROVAL_KINDS as readonly string[]).includes(kindKey) ? "setup" : "change";
}

/**
 * The mode "allow from now on" on a card moves its Bot to: the narrowest one in which this kind of
 * call no longer asks — `auto` for a change, `allow_all` for a change to the app's setup.
 */
export function modeAllowing(kindKey: string | null | undefined): PermissionMode {
  return permissionClassOf(kindKey) === "setup" ? "allow_all" : "auto";
}
