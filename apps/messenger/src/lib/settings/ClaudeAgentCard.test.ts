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

test("under each account something runs on, one line of its usage; the whole of it is the widget's", async () => {
  const account = {
    config_dir: null, email: "you@example.com", available: true, reason: null, plan: "pro", credits: null, checked_at: "2026-10-08T11:00:00.000Z", error: null,
    windows: [
      { minutes: 10_080, model: null, percent: 40, resets_at: null },
      { minutes: 300, model: null, percent: 18, resets_at: "2026-10-08T15:40:00.000Z" },
      { minutes: 10_080, model: "Opus", percent: 95, resets_at: null },
    ],
  };
  const usage = { runner: "claude_code" as const, custom_id: null, label: "Claude Agent", today: { turns: 0, tokens: 0, estimated_usd: 0 }, accounts: [account] };
  const shown = render(ClaudeAgentCard, { api: apiOf(async () => status()), t, usage });
  await sleep(0);
  const line = shown.host.querySelector("[data-claude-account] [data-claude-card-usage]");
  // The plan's own windows, shortest first; the ring is the tightest window, the model's own.
  expect(line?.textContent?.replace(/\s+/g, " ").trim()).toBe("5h 82% · 7d 60%");
  expect(line?.querySelector(".usage-ring")?.classList.contains("is-danger")).toBe(true);
  shown.close();

  const noPlan = render(ClaudeAgentCard, {
    api: apiOf(async () => status({ auth_method: "api_key" })), t,
    usage: { ...usage, accounts: [{ ...account, available: false, reason: "no_plan" as const, windows: [] }] },
  });
  await sleep(0);
  expect(noPlan.host.querySelector("[data-claude-card-usage]")?.textContent).toContain(t.usage.noPlan);
  noPlan.close();

  // Nothing runs on Claude Agent: the card says nothing about usage.
  const unused = render(ClaudeAgentCard, { api: apiOf(async () => status()), t });
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

test("with Bots on two accounts each account's usage line sits in that account's group", async () => {
  const windows = [{ minutes: 300, model: null, percent: 18, resets_at: null }];
  const one = { available: true, reason: null, plan: "pro", credits: null, checked_at: "2026-10-08T11:00:00.000Z", error: null, windows, config_dir: null, email: "you@example.com" };
  const two = { ...one, plan: "team", config_dir: "/Users/you/.claude-b", email: "team@example.com", windows: [{ ...windows[0]!, percent: 60 }] };
  const usage = { runner: "claude_code" as const, custom_id: null, label: "Claude Agent", today: { turns: 0, tokens: 0, estimated_usd: 0 }, accounts: [one, two] };
  const own = { config_dir: null, config_directory: "/Users/you/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "you@example.com", error: null, login_command: "claude auth login" };
  const team = { ...own, config_dir: "/Users/you/.claude-b", config_directory: "/Users/you/.claude-b", subscription_type: "team", email: "team@example.com",
    login_command: "CLAUDE_CONFIG_DIR=/Users/you/.claude-b claude auth login" };
  const view = render(ClaudeAgentCard, { api: apiOf(async () => status({ accounts: [own, team] })), t, usage });
  await sleep(0);
  const ownGroup = view.host.querySelector("[data-claude-account]")!;
  const teamGroup = view.host.querySelector('[data-claude-account-dir="/Users/you/.claude-b"]')!;
  expect(ownGroup.querySelector("[data-usage-line]")?.textContent?.trim()).toBe("5h 82%");
  expect(teamGroup.querySelector("[data-usage-line]")?.textContent?.trim()).toBe("5h 40%");
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
