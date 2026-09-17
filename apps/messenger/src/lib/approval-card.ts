import type { Approval, Message } from "@real-bot/protocol";

/** Kinds that may be written to `allow_rules`. Matches the matrix in 危险动作矩阵和 Always allow 种类. */
const ALWAYS_ALLOW_KINDS = new Set([
  "outside-read",
  "outside-write",
  "unconstrained-shell",
  "outbound-http",
]);

export function canAlwaysAllow(kindKey: string | null | undefined): boolean {
  return kindKey != null && ALWAYS_ALLOW_KINDS.has(kindKey);
}

export function needsEndpointKey(
  kindKey: string | null | undefined,
  target?: string | null,
): boolean {
  if (kindKey === "endpoint-add" || kindKey === "endpoint-edit") return true;
  return isHttpMcpApproval(kindKey, target);
}

export function endpointKeyRequired(
  kindKey: string | null | undefined,
  _target?: string | null,
): boolean {
  return kindKey === "endpoint-add";
}

export function isHttpMcpApproval(
  kindKey: string | null | undefined,
  target?: string | null,
): boolean {
  if (kindKey !== "mcp-add" && kindKey !== "mcp-edit") return false;
  return Boolean(target && /^https?:\/\//i.test(target.trim()));
}

export function approvalNeedsSecret(
  card: Pick<Approval, "kind_key" | "target" | "requires_api_key">,
): boolean {
  if (card.requires_api_key) return true;
  return needsEndpointKey(card.kind_key, card.target);
}

export function approvalSecretRequired(
  card: Pick<Approval, "kind_key" | "target" | "requires_api_key">,
): boolean {
  if (card.requires_api_key) return true;
  if (endpointKeyRequired(card.kind_key, card.target)) return true;
  return card.kind_key === "mcp-add" && isHttpMcpApproval(card.kind_key, card.target);
}

export function approvalForMessage(
  approvals: readonly Approval[],
  message: Message,
): Approval | undefined {
  if (message.kind !== "approval") return undefined;
  const byMessage = approvals.find((row) => row.message_id === message.id);
  if (byMessage) return byMessage;
  if (!message.turn_id) return undefined;
  return approvals.find((row) => row.turn_id === message.turn_id);
}

export function isPendingApproval(message: Message, approvals: readonly Approval[]): boolean {
  return approvalForMessage(approvals, message)?.status === "pending";
}
