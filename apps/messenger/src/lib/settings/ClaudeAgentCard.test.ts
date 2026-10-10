import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
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
  // Anthropic's Claude Spark beside the title, in its own colour.
  expect(proxied.host.querySelector(".claude-head [data-claude-spark] path")?.getAttribute("fill")).toBe("#D97757");
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

test("a daemon without the route (an older Mac over the relay) gets a note instead of the facts", async () => {
  const view = render(ClaudeAgentCard, { api: apiOf(async () => { throw Object.assign(new Error("not found"), { status: 404 }); }), t });
  await sleep(0);
  expect(view.host.textContent).toContain(t.claudeAgent.unreachable);
  expect(view.host.querySelector("[data-claude-network]")).toBeNull();
  view.close();
});

test("the card shows the plan's usage under the facts, or says the sign-in has no plan to show", async () => {
  const usage = {
    available: true, reason: null, plan: "pro", checked_at: "2026-10-08T11:00:00.000Z", error: null,
    windows: [{ kind: "five_hour" as const, model: null, percent: 18, resets_at: "2026-10-08T15:40:00.000Z" }],
  };
  const refreshes: boolean[] = [];
  const shown = render(ClaudeAgentCard, {
    api: { ...apiOf(async () => status()), claudeUsage: async (refresh = false) => { refreshes.push(refresh); return usage; } }, t,
  });
  await sleep(0);
  const block = shown.host.querySelector("[data-claude-card-usage]");
  expect(block?.querySelector(".usage-name")?.textContent).toBe(t.claudeAgent.usage.fiveHour);
  expect(block?.querySelector(".usage-percent")?.textContent).toBe("剩82%");
  expect(refreshes).toEqual([false]);
  shown.close();

  const noPlan = render(ClaudeAgentCard, {
    api: { ...apiOf(async () => status({ auth_method: "api_key" })), claudeUsage: async () => ({ ...usage, available: false, reason: "no_plan" as const, windows: [] }) }, t,
  });
  await sleep(0);
  expect(noPlan.host.querySelector("[data-claude-card-usage]")?.textContent).toContain(t.claudeAgent.usage.noPlan);
  noPlan.close();

  // No Bot runs on Claude Agent: the card says nothing about usage.
  const unused = render(ClaudeAgentCard, {
    api: { ...apiOf(async () => status()), claudeUsage: async () => ({ ...usage, available: false, reason: "unused" as const, windows: [] }) }, t,
  });
  await sleep(0);
  expect(unused.host.querySelector("[data-claude-card-usage]")).toBeNull();
  unused.close();
});

test("other accounts are listed with their sign-in, added and removed as a whole list; one a Bot runs on stays", async () => {
  const own = { config_dir: null, config_directory: "/Users/you/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", error: null, login_command: "claude auth login" };
  const team = { config_dir: "/Users/you/.claude-b", config_directory: "/Users/you/.claude-b", logged_in: true, auth_method: "claude.ai", subscription_type: "team", email: "team@example.com", error: null,
    login_command: "CLAUDE_CONFIG_DIR=/Users/you/.claude-b claude auth login" };
  const out = { ...team, config_dir: "/Users/you/.claude-c", config_directory: "/Users/you/.claude-c", logged_in: false, auth_method: "none", subscription_type: null, email: null,
    login_command: "CLAUDE_CONFIG_DIR=/Users/you/.claude-c claude auth login" };
  const sent: string[][] = [];
  let refuse = false;
  const view = render(ClaudeAgentCard, {
    api: {
      ...apiOf(async () => status({ accounts: [own, team, out] })),
      setClaudeCodeAccounts: async (dirs: string[]) => {
        sent.push(dirs);
        if (refuse) throw Object.assign(new Error("in use"), { status: 409 });
        return status({ accounts: [own, ...dirs.map((dir) => ({ ...team, config_dir: dir, config_directory: dir }))] });
      },
    },
    t,
  });
  await sleep(0);
  // The default account is a group of its own, with the directory it reads.
  const ownGroup = view.host.querySelector("[data-claude-account]")!;
  expect(ownGroup.textContent).toContain("/Users/you/.claude");
  expect(ownGroup.textContent).toContain(t.claudeAgent.accounts.defaultTag);
  const rows = [...view.host.querySelectorAll("[data-claude-account-dir]")];
  expect(rows.map((row) => row.getAttribute("data-claude-account-dir"))).toEqual(["/Users/you/.claude-b", "/Users/you/.claude-c"]);
  expect(rows[0]!.textContent).toContain("Claude Team 订阅 · team@example.com");
  expect(rows[1]!.textContent).toContain("CLAUDE_CONFIG_DIR=/Users/you/.claude-c claude auth login");

  // Another account's field waits behind a link.
  expect(view.host.querySelector("[data-claude-accounts] input")).toBeNull();
  click(view.host.querySelector("[data-claude-account-open]"));
  const input = view.host.querySelector<HTMLInputElement>("[data-claude-accounts] input")!;
  input.value = "~/.claude-d";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(0);
  view.host.querySelector<HTMLFormElement>("[data-claude-accounts] form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await sleep(0);
  expect(sent).toEqual([["/Users/you/.claude-b", "/Users/you/.claude-c", "~/.claude-d"]]);
  // Added, the field folds away again.
  expect(view.host.querySelector("[data-claude-accounts] input")).toBeNull();

  refuse = true;
  click(view.host.querySelector<HTMLButtonElement>("[data-claude-account-dir] button")!);
  await sleep(0);
  expect(sent[1]).toEqual(["/Users/you/.claude-c", "~/.claude-d"]);
  expect(view.host.querySelector("[data-claude-account-error]")?.textContent).toBe(t.claudeAgent.accounts.inUse);
  view.close();
});

test("with Bots on two accounts each account's usage sits in that account's group, with one refresh", async () => {
  const windows = [{ kind: "five_hour" as const, model: null, percent: 18, resets_at: null }];
  const one = { available: true, reason: null, plan: "pro", checked_at: "2026-10-08T11:00:00.000Z", error: null, windows, config_dir: null, email: "you@example.com" };
  const two = { ...one, plan: "team", config_dir: "/Users/you/.claude-b", email: "team@example.com" };
  const own = { config_dir: null, config_directory: "/Users/you/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", error: null, login_command: "claude auth login" };
  const team = { ...own, config_dir: "/Users/you/.claude-b", config_directory: "/Users/you/.claude-b", subscription_type: "team", email: "team@example.com",
    login_command: "CLAUDE_CONFIG_DIR=/Users/you/.claude-b claude auth login" };
  const view = render(ClaudeAgentCard, { api: { ...apiOf(async () => status({ accounts: [own, team] })), claudeUsage: async () => ({ ...one, accounts: [one, two] }) }, t });
  await sleep(0);
  const ownGroup = view.host.querySelector("[data-claude-account]")!;
  const teamGroup = view.host.querySelector('[data-claude-account-dir="/Users/you/.claude-b"]')!;
  expect(ownGroup.textContent).toContain("you@example.com");
  expect(ownGroup.querySelectorAll("[data-claude-usage-rows]")).toHaveLength(1);
  expect(teamGroup.textContent).toContain("team@example.com");
  expect(teamGroup.querySelectorAll("[data-claude-usage-rows]")).toHaveLength(1);
  expect(view.host.querySelectorAll("[data-claude-accounts] .usage-foot button")).toHaveLength(1);
  view.close();
});

test("the explanations sit behind a ? and show on hover", async () => {
  const view = render(ClaudeAgentCard, { api: apiOf(async () => status()), t });
  await sleep(0);
  expect(view.host.textContent).not.toContain(t.claudeAgent.hint);
  const tips = [...view.host.querySelectorAll<HTMLButtonElement>("[data-help-tip]")];
  expect(tips.map((tip) => tip.getAttribute("aria-label"))).toEqual([t.claudeAgent.help, t.claudeAgent.accounts.help]);
  click(tips[0]!);
  await sleep(0);
  expect(document.querySelector("[data-help-tip-text]")?.textContent).toBe(t.claudeAgent.hint);
  view.close();
});
