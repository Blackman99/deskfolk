import { expect, test } from "bun:test";
import type { Approval, Message } from "@real-bot/protocol";
import {
  approvalForMessage,
  approvalNeedsSecret,
  approvalSecretRequired,
  canAlwaysAllow,
  isPendingApproval,
  needsEndpointKey,
} from "./approval-card.ts";

function approval(partial: Partial<Approval> & Pick<Approval, "id">): Approval {
  return {
    turn_id: "turn-1",
    message_id: "appr-msg",
    status: "pending",
    kind_key: "outside-write",
    summary: "outside-write /tmp/x",
    target: "/tmp/x",
    created_at: "t",
    resolved_at: null,
    requires_api_key: false,
    ...partial,
  };
}

function message(partial: Partial<Message> = {}): Message {
  return {
    id: "appr-msg",
    session_id: "s1",
    turn_id: "turn-1",
    parent_id: null,
    kind: "approval",
    author: "writer",
    body: "outside-write /tmp/x",
    source_turn_id: null,
    created_at: "t",
    attachments: [],
    reactions: [],
    ...partial,
  };
}

test("Always allow is offered for outside read/write, unconstrained shell, and reserved outbound http", () => {
  expect(canAlwaysAllow("outside-read")).toBe(true);
  expect(canAlwaysAllow("outside-write")).toBe(true);
  expect(canAlwaysAllow("unconstrained-shell")).toBe(true);
  expect(canAlwaysAllow("outbound-http")).toBe(true);
});

test("Always allow is not offered for must-approve MCP or endpoint kinds or a missing key", () => {
  expect(canAlwaysAllow("mcp-add")).toBe(false);
  expect(canAlwaysAllow("mcp-edit")).toBe(false);
  expect(canAlwaysAllow("endpoint-add")).toBe(false);
  expect(canAlwaysAllow("endpoint-edit")).toBe(false);
  expect(canAlwaysAllow(null)).toBe(false);
  expect(canAlwaysAllow(undefined)).toBe(false);
});

test("approvalForMessage matches the card message, then the turn", () => {
  const card = message();
  const row = approval({ id: "a1" });
  expect(approvalForMessage([row], card)?.id).toBe("a1");
  expect(
    approvalForMessage([approval({ id: "a2", message_id: null })], card)?.id,
  ).toBe("a2");
  expect(approvalForMessage([row], message({ kind: "bot", id: "m2" }))).toBeUndefined();
});

test("endpoint and HTTP MCP cards collect a key", () => {
  expect(needsEndpointKey("endpoint-add")).toBe(true);
  expect(needsEndpointKey("endpoint-edit")).toBe(true);
  expect(needsEndpointKey("mcp-add", "https://cpa.example/mcp")).toBe(true);
  expect(needsEndpointKey("mcp-edit", "https://cpa.example/mcp")).toBe(true);
  expect(needsEndpointKey("mcp-add", "bun run fix.ts")).toBe(false);
  expect(needsEndpointKey("outside-write")).toBe(false);
});

test("HTTP MCP add cards require Authorization from the stored flag, not a guessed URL", () => {
  const httpAdd = approval({
    id: "a-http",
    kind_key: "mcp-add",
    target: "https://cpa.example/mcp",
    requires_api_key: true,
  });
  expect(approvalNeedsSecret(httpAdd)).toBe(true);
  expect(approvalSecretRequired(httpAdd)).toBe(true);
  const stdioAdd = approval({
    id: "a-stdio",
    kind_key: "mcp-add",
    target: "bun run fix.ts",
    requires_api_key: false,
  });
  expect(approvalNeedsSecret(stdioAdd)).toBe(false);
  expect(approvalSecretRequired(stdioAdd)).toBe(false);
  const flagged = approval({
    id: "a-flag",
    kind_key: "mcp-add",
    target: "",
    requires_api_key: true,
  });
  expect(approvalNeedsSecret(flagged)).toBe(true);
  expect(approvalSecretRequired(flagged)).toBe(true);
});

test("a card is pending only while the approval row is pending", () => {
  const card = message();
  expect(isPendingApproval(card, [approval({ id: "a1" })])).toBe(true);
  expect(isPendingApproval(card, [approval({ id: "a1", status: "allowed_once" })])).toBe(false);
  expect(isPendingApproval(message({ kind: "ask" }), [approval({ id: "a1" })])).toBe(false);
});
