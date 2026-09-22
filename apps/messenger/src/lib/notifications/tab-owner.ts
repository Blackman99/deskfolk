export const TAB_LOCK_NAME = "real-bot-device-connection";
export const TAB_CHANNEL = "real-bot-tab";
export const TAKEOVER_MS = 5000;

export type TabRole = "owner" | "standby" | "single";
export type TabControlMessage =
  | { type: "inbox" }
  | { type: "owner" }
  | { type: "standby" }
  | { type: "takeover-request" }
  | { type: "takeover-ack" };

export function isTabControlMessage(data: unknown): data is TabControlMessage {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  if (type !== "inbox" && type !== "owner" && type !== "standby" && type !== "takeover-request" && type !== "takeover-ack") {
    return false;
  }
  return Object.keys(data as object).join() === "type";
}

export function supportsWebLocks(locks: unknown): locks is LockManager {
  return Boolean(locks && typeof (locks as LockManager).request === "function");
}

export type OwnerFocusTarget = { url?: string; focused?: boolean; frameType?: string };

export function pickOwnerClient<T extends OwnerFocusTarget>(
  clients: readonly T[],
  ownerUrl: string | null,
  origin: string,
  scopePath: string,
): T | null {
  const inScope = clients.filter((client) => clientInScope(client.url ?? "", origin, scopePath));
  if (ownerUrl) {
    const owner = inScope.find((client) => client.url === ownerUrl);
    if (owner) return owner;
  }
  return inScope.find((client) => client.focused) ?? inScope[0] ?? null;
}

export function clientInScope(url: string, origin: string, scopePath: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return false;
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    const scope = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
    return path.startsWith(scope) || parsed.pathname === scopePath;
  } catch {
    return false;
  }
}

/** Where a push click with no open window lands: the chat list, which carries the pending state. */
export function inboxOpenUrl(origin: string, scopePath: string): string {
  const base = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  return new URL(base, origin).toString();
}

export type CloseOutcome = {
  localRemoved: boolean;
  hostDisabled: boolean;
  hostConfirmed: boolean;
};

export function closeCopyKey(outcome: CloseOutcome): "closed" | "local_only" | "host_only" | "unconfirmed" {
  if (outcome.localRemoved && outcome.hostDisabled && outcome.hostConfirmed) return "closed";
  if (outcome.localRemoved && !outcome.hostConfirmed) return "local_only";
  if (!outcome.localRemoved && outcome.hostDisabled && outcome.hostConfirmed) return "host_only";
  return "unconfirmed";
}

export type PushHealth =
  | "ok"
  | "paused_upgrade"
  | "unsupported"
  | "denied"
  | "install_required"
  | "needs_repair"
  | "not_registered"
  | "gated";

export function classifyPushHealth(input: {
  permission: "default" | "granted" | "denied" | "unsupported";
  standalone: boolean;
  ios: boolean;
  transport: "legacy" | "paused_upgrade" | "policy_v2" | null;
  enabled: boolean;
  subscribed: boolean;
  recovery: "none" | "registration_missing" | "gone" | "expired" | "key_mismatch";
  remoteGate?: boolean;
}): PushHealth {
  if (input.permission === "unsupported") return "unsupported";
  if (input.ios && !input.standalone) return "install_required";
  if (input.permission === "denied") return "denied";
  if (input.remoteGate) return "gated";
  if (input.transport === "paused_upgrade") return "paused_upgrade";
  if (input.recovery !== "none") return "needs_repair";
  if (input.permission === "granted" && !input.subscribed) return "not_registered";
  if (input.enabled && input.subscribed && input.permission === "granted") return "ok";
  return "not_registered";
}
