import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import ClaudeAgentCard from "./ClaudeAgentCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status(over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-05T00:00:00.000Z", error: null, ...over,
  };
}

function apiOf(answer: () => Promise<ClaudeCodeStatus>) {
  return { claudeCode: answer, detectClaudeCode: answer, setClaudeCodePath: answer };
}

test("the card says which way Claude Code reaches Anthropic: the system proxy it is handed, or straight", async () => {
  const proxied = render(ClaudeAgentCard, { api: apiOf(async () => status({ proxy: "http://127.0.0.1:12334", proxy_source: "system" })), t });
  await sleep(0);
  const network = proxied.host.querySelector("[data-claude-network]")?.textContent ?? "";
  expect(network).toContain("http://127.0.0.1:12334");
  expect(network).toContain(t.claudeAgent.proxySource.system!);
  expect(proxied.host.querySelector("[data-claude-account]")?.textContent).toContain("you@example.com");
  proxied.close();

  let asked = 0;
  const direct = render(ClaudeAgentCard, { api: apiOf(async () => { asked += 1; return status(); }), t });
  await sleep(0);
  expect(direct.host.querySelector("[data-claude-network]")?.textContent?.trim()).toBe(t.claudeAgent.direct);
  // One answer does not set off the next ask.
  await sleep(20);
  expect(asked).toBe(1);
  direct.close();
});

test("an API key in use is said plainly: every turn is billed per token", async () => {
  const view = render(ClaudeAgentCard, { api: apiOf(async () => status({ auth_method: "api_key", subscription_type: null, email: null })), t });
  await sleep(0);
  expect(view.host.querySelector("[data-claude-api-key]")?.textContent).toBe(t.claudeAgent.apiKey);
  view.close();
});

test("over the relay the card only says it lives on the Mac", async () => {
  const view = render(ClaudeAgentCard, { api: apiOf(async () => { throw Object.assign(new Error("not found"), { status: 404 }); }), t });
  await sleep(0);
  expect(view.host.textContent).toContain(t.claudeAgent.localOnly);
  expect(view.host.querySelector("[data-claude-network]")).toBeNull();
  view.close();
});
