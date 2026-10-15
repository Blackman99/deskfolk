import { expect, test } from "bun:test";
import type { Approval, Message } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import {
  approvalForMessage,
  approvalNeedsSecret,
  approvalSecretRequired,
  isPendingApproval,
  needsEndpointKey,
} from "./approval-card.ts";

function approval(partial: Partial<Approval> & Pick<Approval, "id">): Approval {
  return {
    turn_id: "turn-1",
    message_id: "appr-msg",
    status: "pending",
    kind_key: "file-write",
    summary: "file-write /tmp/x",
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
    body: "file-write /tmp/x",
    source_turn_id: null,
    created_at: "t",
    attachments: [],
    reactions: [],
    ...partial,
  };
}

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

test("adding a local model server offers the key field without requiring it (ADR 0067)", () => {
  const local = approval({ id: "a-local", kind_key: "endpoint-add", target: "http://localhost:11434/v1", requires_api_key: false });
  expect(approvalNeedsSecret(local)).toBe(true);
  expect(approvalSecretRequired(local)).toBe(false);
  const cloud = approval({ id: "a-cloud", kind_key: "endpoint-add", target: "https://api.example.com/v1", requires_api_key: true });
  expect(approvalSecretRequired(cloud)).toBe(true);
});

test("allowing from now on names the mode the card's Bot moves to (ADR 0092)", () => {
  const t = copyFor("zh");
  expect(t.permissions.allowFromNowCovers("开发助手", t.permissions.modes.auto, t.permissions.descriptions.auto))
    .toBe("开发助手 改成「自动」：写文件、跑命令直接做；加改 MCP、端点和内置提示词先问你。");
  const en = copyFor("en");
  expect(en.permissions.allowFromNowCovers("Coder", en.permissions.modes.allow_all, en.permissions.descriptions.allow_all)).toBe("Coder moves to Allow all: Asks nothing.");
});
