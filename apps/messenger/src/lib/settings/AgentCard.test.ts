import { expect, test } from "bun:test";
import type { AgentStatus, BotRunner, CustomAgent } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { click, fill, render } from "../test-render.ts";
import AgentCard from "./AgentCard.svelte";

const t = copyFor("zh");
const en = copyFor("en");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runner: "codex", custom_id: null, label: "Codex", path: "/Users/you/.local/bin/codex", source: "known", version: "0.130.0",
    logged_in: true, auth: "ChatGPT Plus", login_command: "codex login", models: [{ id: "gpt-5.5", name: "GPT-5.5", efforts: [] }, { id: "gpt-5.5-mini", name: "GPT-5.5 mini", efforts: [] }],
    default_model: "gpt-5.5", proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}

type Call = { name: string; args: unknown[] };

/** An API that records what it is asked and answers with `answer` (the status it is given is what a real daemon would answer after the change). */
function apiOf(answer: (call: Call) => Promise<AgentStatus>) {
  const calls: Call[] = [];
  const ask = (name: string) => (...args: unknown[]) => {
    const call = { name, args };
    calls.push(call);
    return answer(call);
  };
  return { calls, api: { detectAgent: ask("detectAgent"), setAgentPath: ask("setAgentPath"), setAgentAccounts: ask("setAgentAccounts") } as never };
}

function open(props: { status?: AgentStatus; answer?: (call: Call) => Promise<AgentStatus>; custom?: CustomAgent | null; copy?: typeof t } = {}) {
  const changes: AgentStatus[] = [];
  const stub = apiOf(props.answer ?? (async () => status()));
  const view = render(AgentCard, { status: props.status ?? status(), api: stub.api, t: props.copy ?? t, custom: props.custom ?? null, onChange: (next: AgentStatus) => changes.push(next) });
  return { ...view, calls: stub.calls, changes };
}

test("a found agent says where it is, which version, how it is signed in, how it reaches the network and which models it lists", () => {
  const view = open();
  expect(view.host.querySelector("[data-agent-label]")?.textContent).toBe("Codex");
  const path = view.host.querySelector("[data-agent-path]")?.textContent ?? "";
  expect(path).toContain("/Users/you/.local/bin/codex");
  expect(path).toContain(t.agents.source.known!);
  expect(view.host.querySelector("[data-agent-version]")?.textContent).toBe("0.130.0");
  expect(view.host.querySelector("[data-agent-signin]")?.textContent?.trim()).toBe("已登录 · ChatGPT Plus");
  expect(view.host.querySelector("[data-agent-network]")?.textContent?.trim()).toBe(t.agents.direct);
  expect(view.host.querySelector("[data-agent-models]")?.textContent).toBe("2 个，默认 gpt-5.5");
  expect(view.host.querySelector("[data-agent-missing]")).toBeNull();
  // Its own logo before its name; Claude's spark is Claude Agent's alone.
  expect(view.host.querySelector(".agent-title")?.firstElementChild?.getAttribute("data-agent-logo")).toBe("codex");
  expect(view.host.querySelector("[data-claude-spark]")).toBeNull();
  view.close();

  const english = open({ copy: en });
  expect(english.host.querySelector("[data-agent-signin]")?.textContent?.trim()).toBe("Signed in · ChatGPT Plus");
  expect(english.host.querySelector("[data-agent-models]")?.textContent).toBe("2, default gpt-5.5");
  english.close();
});

test("the way it reaches the network is the proxy it is handed, any password already hidden, or straight", () => {
  const view = open({ status: status({ proxy: "http://127.0.0.1:12334", proxy_source: "system" }) });
  const network = view.host.querySelector("[data-agent-network]")?.textContent ?? "";
  expect(network).toContain("http://127.0.0.1:12334");
  expect(network).toContain(t.agents.proxySource.system!);
  view.close();
});

test("an agent that was not found says which command, once, and the path field to point at it", () => {
  const view = open({ status: status({ runner: "grok", label: "Grok", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null, models: [], default_model: null, error: "grok was not found on PATH" }) });
  expect(view.host.querySelector("[data-agent-missing]")?.textContent).toBe(t.agents.notFound("grok"));
  // The runtime's own words say the same again, in English: left out, as the Claude card does.
  expect(view.host.querySelector("[data-agent-error]")).toBeNull();
  expect(view.host.querySelector(".agent-facts")).toBeNull();
  // Nothing to sign in or list accounts on until it is found.
  expect(view.host.querySelector("[data-agent-accounts]")).toBeNull();
  expect(view.host.querySelector("[data-agent-path-input]")?.getAttribute("placeholder")).toBe(t.agents.pathPlaceholder("grok"));
  expect(view.host.querySelector("[data-agent-recheck]")).not.toBeNull();
  view.close();

  // Antigravity's command is agy.
  const agy = open({ status: status({ runner: "antigravity", label: "Antigravity", path: null, source: null }) });
  expect(agy.host.querySelector("[data-agent-missing]")?.textContent).toBe(t.agents.notFound("agy"));
  agy.close();
});

test("signed in, signed out with the command to run in a terminal, or not known until the first turn", () => {
  const out = open({ status: status({ logged_in: false, auth: null, login_command: "codex login" }) });
  const signedOut = out.host.querySelector("[data-agent-signin]");
  expect(signedOut?.textContent?.replace(/\s+/g, " ").trim()).toBe("没登录，在终端运行 codex login");
  expect(signedOut?.querySelector("code")?.textContent).toBe("codex login");
  out.close();

  const noCommand = open({ status: status({ logged_in: false, auth: null, login_command: null }) });
  expect(noCommand.host.querySelector("[data-agent-signin]")?.textContent?.trim()).toBe(t.agents.signedOutNoCommand);
  noCommand.close();

  const unknown = open({ status: status({ logged_in: null, auth: null }) });
  expect(unknown.host.querySelector("[data-agent-signin]")?.textContent?.trim()).toBe("首轮时检查");
  unknown.close();

  const noModels = open({ status: status({ models: [], default_model: null }) });
  expect(noModels.host.querySelector("[data-agent-models]")?.textContent).toBe(t.agents.modelsNone);
  noModels.close();
});

test("a path you give is saved as typed, an empty one lets the daemon look again, and the answer goes to the host", async () => {
  const next = status({ path: "/opt/codex/bin/codex", source: "setting" });
  const view = open({ answer: async () => next });
  // Found, it keeps its path field behind a link.
  expect(view.host.querySelector("[data-agent-path-input]")).toBeNull();
  click(view.host.querySelector("[data-agent-path-open]"));
  const input = view.host.querySelector<HTMLInputElement>("[data-agent-path-input]")!;
  expect(input.value).toBe("");
  fill(input, "  /opt/codex/bin/codex  ");
  click(view.host.querySelector("[data-agent-path-save]"));
  await sleep(0);
  expect(view.calls).toEqual([{ name: "setAgentPath", args: ["codex", "/opt/codex/bin/codex"] }]);
  expect(view.changes).toEqual([next]);

  fill(input, "   ");
  click(view.host.querySelector("[data-agent-path-save]"));
  await sleep(0);
  expect(view.calls[1]).toEqual({ name: "setAgentPath", args: ["codex", null] });
  view.close();

  // A path you set earlier fills the field.
  const set = open({ status: status({ source: "setting", path: "/opt/codex/bin/codex" }) });
  click(set.host.querySelector("[data-agent-path-open]"));
  expect(set.host.querySelector<HTMLInputElement>("[data-agent-path-input]")?.value).toBe("/opt/codex/bin/codex");
  set.close();
});

test("a path the daemon refuses says so with its words under ours; a failed ask says to try again", async () => {
  let error: Error = new ApiError(422, "invalid_args", "path must be absolute");
  const view = open({ answer: async () => { throw error; } });
  click(view.host.querySelector("[data-agent-path-open]"));
  fill(view.host.querySelector("[data-agent-path-input]"), "codex");
  click(view.host.querySelector("[data-agent-path-save]"));
  await sleep(0);
  const refused = view.host.querySelector("[data-agent-path-error]");
  expect(refused?.textContent).toContain(t.agents.pathInvalid);
  expect(refused?.textContent).toContain("path must be absolute");
  expect(view.changes).toEqual([]);

  error = new Error("network down");
  click(view.host.querySelector("[data-agent-recheck]"));
  await sleep(0);
  expect(view.host.querySelector("[data-agent-failed]")?.textContent).toBe(t.agents.failed);
  expect(view.host.querySelector("[data-agent-path-error]")).toBeNull();
  view.close();
});

test("check again asks the daemon for a fresh look at this agent, a custom one by its id", async () => {
  const view = open();
  click(view.host.querySelector("[data-agent-recheck]"));
  await sleep(0);
  expect(view.calls).toEqual([{ name: "detectAgent", args: ["codex", null] }]);
  expect(view.changes).toHaveLength(1);
  view.close();

  const own: CustomAgent = { id: "ca-1", name: "my-agent", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] };
  const custom = open({ status: status({ runner: "custom", custom_id: "ca-1", label: "my-agent", path: "/usr/local/bin/my-agent", source: "custom", login_command: null, logged_in: null, auth: null }), custom: own });
  click(custom.host.querySelector("[data-agent-recheck]"));
  await sleep(0);
  expect(custom.calls).toEqual([{ name: "detectAgent", args: ["custom", "ca-1"] }]);
  custom.close();
});

test("one of your own ACP agents shows its command and arguments, and no path field: the command is set with the agent", () => {
  const own: CustomAgent = { id: "ca-1", name: "my-agent", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] };
  const view = open({ status: status({ runner: "custom", custom_id: "ca-1", label: "my-agent", path: "/usr/local/bin/my-agent", source: "custom", login_command: null, logged_in: null, auth: null }), custom: own });
  expect(view.host.querySelector("[data-agent-label]")?.textContent).toBe("my-agent");
  // No vendor's mark: the plain glyph an agent of your own wears.
  expect(view.host.querySelector(".agent-title")?.firstElementChild?.getAttribute("data-agent-logo")).toBe("custom");
  expect(view.host.querySelector("[data-agent-path]")?.textContent).toContain("/usr/local/bin/my-agent");
  expect(view.host.querySelector("[data-agent-args]")?.textContent).toBe("acp --stdio");
  expect(view.host.querySelector("[data-agent-path-input]")).toBeNull();
  expect(view.host.querySelector("[data-agent-accounts]")).toBeNull();
  view.close();

  const bare = open({ status: status({ runner: "custom", custom_id: "ca-2", label: "bare", path: "/bin/bare", source: "custom" }), custom: { id: "ca-2", name: "bare", command: "/bin/bare", args: [] } });
  expect(bare.host.querySelector("[data-agent-args]")?.textContent).toBe(t.agents.noArgs);
  bare.close();

  const missing = open({ status: status({ runner: "custom", custom_id: "ca-3", label: "gone", path: null, source: null }), custom: { id: "ca-3", name: "gone", command: "/bin/gone", args: [] } });
  expect(missing.host.querySelector("[data-agent-missing]")?.textContent).toBe(t.agents.notFoundCustom("/bin/gone"));
  missing.close();
});

test("accounts are listed only for an agent that has config directories, added and removed as a whole list; one a Bot runs on stays", async () => {
  const own = { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: "codex login" };
  const team = { config_dir: "/Users/you/.codex-b", logged_in: true, auth: "ChatGPT Team", error: null, login_command: "CODEX_HOME=/Users/you/.codex-b codex login" };
  const out = { config_dir: "/Users/you/.codex-c", logged_in: false, auth: null, error: null, login_command: "CODEX_HOME=/Users/you/.codex-c codex login" };
  let refuse = false;
  const sent: string[][] = [];
  const view = open({
    status: status({ accounts: [own, team, out] }),
    answer: async (call) => {
      const dirs = call.args[1] as string[];
      sent.push(dirs);
      if (refuse) throw new ApiError(409, "conflict", "~/.codex-b is the Codex account of Researcher, Writer: move those Bots to another account first");
      return status({ accounts: [own, ...dirs.map((dir) => ({ ...team, config_dir: dir }))] });
    },
  });
  // The daemon's own environment is the facts above; the list is the others.
  const rows = [...view.host.querySelectorAll("[data-agent-account-dir]")];
  expect(rows.map((row) => row.getAttribute("data-agent-account-dir"))).toEqual(["/Users/you/.codex-b", "/Users/you/.codex-c"]);
  expect(rows[0]!.textContent).toContain("已登录 · ChatGPT Team");
  expect(rows[1]!.textContent?.replace(/\s+/g, " ")).toContain("没登录，在终端运行 CODEX_HOME=/Users/you/.codex-c codex login");
  // Another account's field waits behind a link.
  expect(view.host.querySelector("[data-agent-accounts] input")).toBeNull();
  click(view.host.querySelector("[data-agent-account-open]"));
  const input = view.host.querySelector<HTMLInputElement>("[data-agent-accounts] input")!;
  expect(input.getAttribute("placeholder")).toBe(t.agents.accounts.placeholder("~/.codex-b"));

  fill(input, "~/.codex-d");
  view.host.querySelector<HTMLFormElement>("[data-agent-accounts] form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await sleep(0);
  expect(view.calls[0]).toEqual({ name: "setAgentAccounts", args: ["codex", ["/Users/you/.codex-b", "/Users/you/.codex-c", "~/.codex-d"]] });
  // Added, the field folds away again.
  expect(view.host.querySelector("[data-agent-accounts] input")).toBeNull();
  expect(view.changes).toHaveLength(1);

  refuse = true;
  click(view.host.querySelector("[data-agent-account-dir] button"));
  await sleep(0);
  expect(sent[1]).toEqual(["/Users/you/.codex-c"]);
  const error = view.host.querySelector("[data-agent-account-error]");
  expect(error?.getAttribute("data-agent-account-error")).toBe("in_use");
  expect(error?.textContent).toContain(t.agents.accounts.inUse);
  // The daemon's words name the Bots in the way.
  expect(error?.textContent).toContain("Researcher, Writer");
  view.close();

  // Grok, OpenCode, Antigravity and ZCode have no config directory to list.
  for (const runner of ["grok", "opencode", "antigravity", "zcode"] as BotRunner[]) {
    const plain = open({ status: status({ runner, label: runner, accounts: [own] }) });
    expect(plain.host.querySelector("[data-agent-accounts]")).toBeNull();
    expect(plain.host.querySelector("[data-agent-account-open]")).toBeNull();
    plain.close();
  }
  const codex = open({ status: status({ runner: "codex", label: "Codex", accounts: [own] }) });
  // With no other account yet there is no list, only the link to add one.
  expect(codex.host.querySelector("[data-agent-accounts]")).toBeNull();
  click(codex.host.querySelector("[data-agent-account-open]"));
  expect(codex.host.querySelector("[data-agent-accounts]")).not.toBeNull();
  expect(codex.host.querySelector<HTMLInputElement>("[data-agent-accounts] input")?.getAttribute("placeholder")).toBe(t.agents.accounts.placeholder("~/.codex-b"));
  codex.close();
});

test("a config directory the daemon refuses says why, with its words under ours", async () => {
  const view = open({ answer: async () => { throw new ApiError(422, "invalid_args", "~/ is your home folder or holds it: name the account's own directory"); } });
  click(view.host.querySelector("[data-agent-account-open]"));
  fill(view.host.querySelector("[data-agent-accounts] input"), "~");
  view.host.querySelector<HTMLFormElement>("[data-agent-accounts] form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await sleep(0);
  const error = view.host.querySelector("[data-agent-account-error]");
  expect(error?.getAttribute("data-agent-account-error")).toBe("invalid");
  expect(error?.textContent).toContain(t.agents.accounts.invalid);
  expect(error?.textContent).toContain("home folder");
  view.close();
});

test("Antigravity says it cannot use Deskfolk's tools, ZCode that it runs through the bridge; the others say neither", () => {
  const agy = open({ status: status({ runner: "antigravity", label: "Antigravity" }) });
  expect(agy.host.querySelector('[data-agent-note="antigravity"]')?.textContent).toBe(t.agents.noteAntigravity);
  expect(agy.host.querySelector('[data-agent-note="zcode"]')).toBeNull();
  agy.close();

  const zcode = open({ status: status({ runner: "zcode", label: "ZCode" }) });
  expect(zcode.host.querySelector('[data-agent-note="zcode"]')?.textContent).toContain("zcode-acp");
  expect(zcode.host.querySelector('[data-agent-note="antigravity"]')).toBeNull();
  zcode.close();

  const codex = open();
  expect(codex.host.querySelector("[data-agent-note]")).toBeNull();
  codex.close();
});
