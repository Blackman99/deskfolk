import { afterEach, expect, test } from "bun:test";
import type { AgentStatus, AgentsStatusResponse, ClaudeCodeStatus } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { aBot } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import AgentsTab from "./AgentsTab.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = realMatchMedia; });

function asPhone(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runner: "codex", custom_id: null, label: "Codex", path: "/usr/local/bin/codex", source: "path", version: "0.130.0",
    logged_in: true, auth: "ChatGPT Plus", login_command: "codex login", models: [{ id: "gpt-5.6", name: "GPT-5.6", efforts: [] }], default_model: null,
    proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}

function claude(over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-05T00:00:00.000Z", error: null, ...over,
  };
}

const list: AgentsStatusResponse = {
  items: [
    status(),
    status({ runner: "grok", label: "Grok", logged_in: false, auth: null, login_command: "grok login", models: [] }),
    status({ runner: "opencode", label: "OpenCode", auth: "OpenCode Go, Alibaba, DeepSeek, Nvidia", models: [{ id: "a/b", name: "a/b", efforts: [] }, { id: "c/d", name: "c/d", efforts: [] }] }),
    status({ runner: "zcode", label: "ZCode", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null, models: [] }),
    status({ runner: "custom", custom_id: "ca-1", label: "my-agent", path: "/bin/my-agent", source: "custom", logged_in: null, auth: null, login_command: null, models: [] }),
  ],
  custom_agents: [{ id: "ca-1", name: "my-agent", command: "/bin/my-agent", args: ["acp"] }],
};

function client(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      claudeCode: async () => { calls.push("claudeCode"); return claude(); },
      detectClaudeCode: async () => { calls.push("detectClaudeCode"); return claude(); },
      setClaudeCodePath: async () => claude(),
      agents: async (refresh?: boolean) => { calls.push(refresh ? "agents:refresh" : "agents"); return list; },
      detectAgent: async () => status(),
      setAgentPath: async () => status(),
      setAgentAccounts: async () => status(),
      setCustomAgents: async () => list,
      ...over,
    },
  };
}

const rowKeys = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".agents-list:not(.is-missing) > [data-agent-row]")].map((row) => row.dataset.agentRow);
const summaryOf = (host: HTMLElement, key: string) => host.querySelector(`[data-agent-row="${key}"] .agent-row-summary`)?.textContent;

test("one line per agent, ready ones first, how it is signed in and what it runs; those not installed folded at the foot", async () => {
  asPhone(false);
  const c = client();
  const bots = [aBot({ id: "b1", runner: "codex" }), aBot({ id: "b2", runner: "codex" }), aBot({ id: "b3", runner: "codex", archived_at: "2026-10-01T00:00:00.000Z" })];
  const view = render(AgentsTab, { api: c.api as never, t, bots });
  await sleep(0);
  expect(rowKeys(view.host)).toEqual(["claude_code", "codex", "opencode", "custom:ca-1", "grok", "custom-agents"]);
  // Signed in with many providers: the first and how many, so the models still fit.
  expect(summaryOf(view.host, "opencode")).toBe(`${t.agents.list.signedInMany("OpenCode Go", 4)} · 2 个模型`);
  expect(summaryOf(view.host, "codex")).toBe("ChatGPT Plus · 1 个模型");
  // One whose sign-in is only known on its first turn says so.
  expect(summaryOf(view.host, "custom:ca-1")).toBe(t.agents.list.signInLater);
  expect(summaryOf(view.host, "grok")).toBe(t.agents.list.signedOut("grok login"));
  expect(summaryOf(view.host, "claude_code")).toBe("Claude Pro 订阅 · 2.1.289");
  expect(view.host.querySelector('[data-agent-row="grok"]')?.getAttribute("data-agent-state")).toBe("signin");
  // Two Bots run on Codex; an archived one does not count.
  expect(view.host.querySelector('[data-agent-row="codex"] [data-agent-row-bots]')?.textContent).toBe(t.agents.list.bots(2));
  // No card is open, and ZCode waits folded.
  expect(view.host.querySelector("[data-agent-card], [data-claude-agent]")).toBeNull();
  expect(view.host.querySelector('[data-agent-row="zcode"]')).toBeNull();
  click(view.host.querySelector("[data-agents-missing-toggle]"));
  expect(view.host.querySelector('.agents-list.is-missing [data-agent-row="zcode"] .agent-row-summary')?.textContent).toBe(t.agents.list.notFound("zcode-acp"));
  await sleep(20);
  expect(c.calls.filter((call) => call === "agents")).toHaveLength(1);
  view.close();
});

test("a line opens its agent's details in place, one at a time; a check there updates the line", async () => {
  asPhone(false);
  const signedOut = status({ logged_in: false, auth: null });
  const c = client({ detectAgent: async () => signedOut });
  const view = render(AgentsTab, { api: c.api as never, t });
  await sleep(0);
  click(view.host.querySelector('[data-agent-row="codex"] .agent-row-head'));
  expect(view.host.querySelector('[data-agent-row="codex"] .agent-row-head')?.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelector('[data-agent-row="codex"] [data-agent-card="codex"]')).not.toBeNull();
  // Its path field waits behind a link, and the card has no heading of its own.
  expect(view.host.querySelector("[data-agent-path-input]")).toBeNull();
  expect(view.host.querySelector("[data-agent-card] .agent-title")).toBeNull();
  click(view.host.querySelector("[data-agent-path-open]"));
  expect(view.host.querySelector("[data-agent-path-input]")).not.toBeNull();
  click(view.host.querySelector("[data-agent-recheck]"));
  await sleep(0);
  expect(summaryOf(view.host, "codex")).toBe(t.agents.list.signedOut("codex login"));
  // Opening Claude closes Codex.
  click(view.host.querySelector('[data-agent-row="claude_code"] .agent-row-head'));
  await sleep(0);
  expect(view.host.querySelector("[data-agent-card]")).toBeNull();
  expect(view.host.querySelector('[data-agent-row="claude_code"] [data-claude-agent]')).not.toBeNull();
  click(view.host.querySelector('[data-agent-row="claude_code"] .agent-row-head'));
  expect(view.host.querySelector("[data-claude-agent]")).toBeNull();
  view.close();
});

test("your own ACP agents open as one line: their list, and adding, renaming or removing one", async () => {
  asPhone(false);
  const c = client({ setCustomAgents: async () => ({ items: [list.items[0]!], custom_agents: [] }) });
  const view = render(AgentsTab, { api: c.api as never, t });
  await sleep(0);
  expect(summaryOf(view.host, "custom-agents")).toBe(t.agents.list.customSummary(1));
  click(view.host.querySelector('[data-agent-row="custom-agents"] .agent-row-head'));
  click(view.host.querySelector("[data-custom-remove]"));
  await sleep(0);
  expect(summaryOf(view.host, "custom-agents")).toBe(t.agents.list.customSummary(0));
  expect(view.host.querySelector('[data-agent-row="custom:ca-1"]')).toBeNull();
  view.close();
});

test("check all asks Claude Code and every agent again, even while the first answer is still coming", async () => {
  asPhone(false);
  let answer: ((value: AgentsStatusResponse) => void) | null = null;
  const c = client({
    agents: (refresh?: boolean) => {
      c.calls.push(refresh ? "agents:refresh" : "agents");
      return refresh ? Promise.resolve(list) : new Promise<AgentsStatusResponse>((resolve) => (answer = resolve));
    },
  });
  const view = render(AgentsTab, { api: c.api as never, t });
  await sleep(0);
  click(view.host.querySelector("[data-agents-recheck-all]"));
  await sleep(0);
  expect(c.calls).toContain("detectClaudeCode");
  expect(c.calls).not.toContain("agents:refresh");
  answer!(list);
  await sleep(0);
  await sleep(0);
  expect(c.calls).toContain("agents:refresh");
  view.close();
});

test("on a phone a line opens as a page of its own, named in the page head, and Back goes to the list", async () => {
  asPhone(true);
  const c = client();
  const view = render(AgentsTab, { api: c.api as never, t });
  await sleep(0);
  const tab = view.app as unknown as { sectionTitle(): string | null; backFromSection(): boolean };
  expect(tab.sectionTitle()).toBeNull();
  expect(tab.backFromSection()).toBe(false);
  click(view.host.querySelector('[data-agent-row="codex"] .agent-row-head'));
  expect(view.host.querySelector('[data-agents-page="codex"] [data-agent-card="codex"]')).not.toBeNull();
  expect(view.host.querySelector(".agents-list")).toBeNull();
  expect(tab.sectionTitle()).toBe("Codex");
  expect(tab.backFromSection()).toBe(true);
  await sleep(0);
  expect(view.host.querySelector("[data-agents-page]")).toBeNull();
  expect(rowKeys(view.host)).toContain("codex");
  view.close();
});

test("a daemon without the route gets a note; any other failure a retry; no client, nothing", async () => {
  asPhone(false);
  const old = render(AgentsTab, { api: client({ agents: async () => { throw new ApiError(404, "not_found", "not found"); } }).api as never, t });
  await sleep(0);
  expect(old.host.querySelector("[data-agents-unreachable]")?.textContent).toBe(t.agents.unreachable);
  expect(rowKeys(old.host)).toEqual(["claude_code"]);
  old.close();

  let fail = true;
  const view = render(AgentsTab, { api: client({ agents: async () => { if (fail) throw new Error("down"); return list; } }).api as never, t });
  await sleep(0);
  expect(view.host.querySelector("[data-agents-failed]")?.textContent).toContain(t.agents.loadFailed);
  fail = false;
  click(view.host.querySelector("[data-agents-failed] button"));
  await sleep(0);
  expect(rowKeys(view.host)).toContain("codex");
  view.close();

  const none = render(AgentsTab, { api: null, t });
  expect(none.host.textContent?.trim()).toBe("");
  none.close();
});

test("lines shown as last seen catch up by themselves when the daemon's new looks come in", async () => {
  asPhone(false);
  let answer: ((value: AgentsStatusResponse) => void) | null = null;
  const asked: string[] = [];
  const stale = { ...list, items: list.items.map((item) => (item.runner === "codex" ? { ...item, logged_in: false, auth: null } : item)), refreshing: true };
  const c = client({
    agents: (refresh?: boolean, wait?: boolean) => {
      asked.push(wait ? "wait" : refresh ? "refresh" : "list");
      return wait ? new Promise<AgentsStatusResponse>((resolve) => (answer = resolve)) : Promise.resolve(stale);
    },
  });
  const view = render(AgentsTab, { api: c.api as never, t });
  await sleep(0);
  // At once, as last seen; the check-all button says it is looking.
  expect(summaryOf(view.host, "codex")).toBe(t.agents.list.signedOut("codex login"));
  expect(view.host.querySelector("[data-agents-recheck-all]")?.textContent).toBe(t.agents.checking);
  expect(asked).toEqual(["list", "wait"]);
  answer!(list);
  await sleep(0);
  expect(summaryOf(view.host, "codex")).toBe("ChatGPT Plus · 1 个模型");
  expect(view.host.querySelector("[data-agents-recheck-all]")?.textContent).toBe(t.agents.list.recheckAll);
  expect(asked).toEqual(["list", "wait"]);
  view.close();
});
