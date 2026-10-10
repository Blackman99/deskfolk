import { expect, test } from "bun:test";
import type { AgentStatus, AgentsStatusResponse } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import OtherAgents from "./OtherAgents.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runner: "codex", custom_id: null, label: "Codex", path: "/usr/local/bin/codex", source: "path", version: "0.130.0",
    logged_in: true, auth: "ChatGPT Plus", login_command: "codex login", models: [], default_model: null,
    proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}

const list: AgentsStatusResponse = {
  items: [
    status(),
    status({ runner: "grok", label: "Grok", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null }),
    status({ runner: "custom", custom_id: "ca-1", label: "my-agent", path: "/bin/my-agent", source: "custom", logged_in: null, auth: null, login_command: null }),
  ],
  custom_agents: [{ id: "ca-1", name: "my-agent", command: "/bin/my-agent", args: ["acp"] }],
};

test("asks the daemon once when it opens and shows a card for each agent, then the card for your own", async () => {
  let asked = 0;
  const client = { agents: async () => { asked += 1; return list; }, detectAgent: async () => status(), setAgentPath: async () => status(), setAgentAccounts: async () => status(), setCustomAgents: async () => list };
  const view = render(OtherAgents, { api: client as never, t });
  await sleep(0);
  expect([...view.host.querySelectorAll("[data-agent-card]")].map((card) => card.getAttribute("data-agent-card"))).toEqual(["codex", "grok", "custom"]);
  expect(view.host.querySelector("[data-custom-agents]")).not.toBeNull();
  // Each card wears its agent's logo before the name; an agent of your own the plain glyph.
  expect([...view.host.querySelectorAll("[data-agent-card] .agent-title [data-agent-logo]")].map((logo) => logo.getAttribute("data-agent-logo"))).toEqual(["codex", "grok", "custom"]);
  // The custom agent's card shows its arguments, from the list.
  expect(view.host.querySelector('[data-agent-custom-id="ca-1"] [data-agent-args]')?.textContent).toBe("acp");
  await sleep(20);
  expect(asked).toBe(1);
  view.close();
});

test("a check on one card replaces that card's status, and the card for your own agents refreshes them all", async () => {
  const signedOut = status({ logged_in: false, auth: null });
  const client = {
    agents: async () => list,
    detectAgent: async () => signedOut,
    setAgentPath: async () => signedOut,
    setAgentAccounts: async () => signedOut,
    setCustomAgents: async () => ({ items: [list.items[0]!], custom_agents: [] }),
  };
  const view = render(OtherAgents, { api: client as never, t });
  await sleep(0);
  click(view.host.querySelector('[data-agent-card="codex"] [data-agent-recheck]'));
  await sleep(0);
  expect(view.host.querySelector('[data-agent-card="codex"] [data-agent-signin]')?.textContent?.replace(/\s+/g, " ").trim()).toBe("没登录，在终端运行 codex login");
  expect(view.host.querySelectorAll("[data-agent-card]")).toHaveLength(3);

  click(view.host.querySelector("[data-custom-remove]"));
  await sleep(0);
  expect(view.host.querySelectorAll("[data-agent-card]")).toHaveLength(1);
  expect(view.host.querySelector("[data-custom-empty]")).not.toBeNull();
  view.close();
});

test("a daemon without the route gets a note; any other failure a retry", async () => {
  const old = render(OtherAgents, { api: { agents: async () => { throw new ApiError(404, "not_found", "not found"); } } as never, t });
  await sleep(0);
  expect(old.host.querySelector("[data-agents-unreachable]")?.textContent).toBe(t.agents.unreachable);
  expect(old.host.querySelector("[data-agent-card]")).toBeNull();
  old.close();

  let fail = true;
  const view = render(OtherAgents, { api: { agents: async () => { if (fail) throw new Error("down"); return list; } } as never, t });
  await sleep(0);
  expect(view.host.querySelector("[data-agents-failed]")?.textContent).toContain(t.agents.loadFailed);
  fail = false;
  click(view.host.querySelector("[data-agents-failed] button"));
  await sleep(0);
  expect(view.host.querySelectorAll("[data-agent-card]")).toHaveLength(3);
  view.close();

  // No client, nothing shown.
  const none = render(OtherAgents, { api: null, t });
  expect(none.host.textContent?.trim()).toBe("");
  none.close();
});
