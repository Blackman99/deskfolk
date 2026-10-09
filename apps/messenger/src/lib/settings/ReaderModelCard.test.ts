import { expect, test } from "bun:test";
import type { ClaudeCodeStatus, Provider, SettingsPatch } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { click, render } from "../test-render.ts";
import ReaderModelCard from "./ReaderModelCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providers = [
  { id: "p1", name: "My CPA", models: ["grok-4.7-build-fast", "gemini-3.8-flash-high"] },
  { id: "p2", name: "阿里百炼", models: ["deepseek-v4.1-flash"] },
] as unknown as Provider[];

function fakePatch(opts: { fail?: boolean } = {}) {
  const sent: SettingsPatch[] = [];
  return { sent, patch: async (patch: SettingsPatch) => { sent.push(patch); return opts.fail ? { code: "conflict" } : null; } };
}

const trigger = (host: HTMLElement) => host.querySelector(".reader-pick .real-select-trigger")!;
/** What a row or the closed picker reads: the model, then where it runs (an endpoint, or Claude Agent). */
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const claudeRow = (model: string) => `${model} ${t.claudeAgent.title}`;

test("following the default names the default model; every listed model can be chosen, and the choice is saved", async () => {
  const { sent, patch } = fakePatch();
  const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(trigger(view.host).textContent).toContain(t.readerModel.followDefault("grok-4.7-build-fast"));
  click(trigger(view.host));
  await sleep(0);
  const options = [...view.host.querySelectorAll(".real-select-option")];
  expect(options.map(text)).toEqual([
    t.readerModel.followDefault("grok-4.7-build-fast"),
    "grok-4.7-build-fast My CPA",
    "gemini-3.8-flash-high My CPA",
    "deepseek-v4.1-flash 阿里百炼",
  ]);
  click(options[3]!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: { provider_id: "p2", model: "deepseek-v4.1-flash" } }]);
  view.close();
});

test("a chosen model shows as chosen, and following the default again saves null", async () => {
  const { sent, patch } = fakePatch();
  const view = render(ReaderModelCard, { providers, chosen: { provider_id: "p2", model: "deepseek-v4.1-flash" }, defaultModel: "grok-4.7-build-fast", patch, t });
  expect(text(trigger(view.host))).toBe("deepseek-v4.1-flash 阿里百炼");
  // Neither endpoint is a built-in one, so the closed picker marks the chosen model Custom.
  expect(trigger(view.host).querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("custom");
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[0]!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: null }]);
  view.close();
});

test("a choice that is not saved says so", async () => {
  const { patch } = fakePatch({ fail: true });
  const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: null, patch, t });
  click(trigger(view.host));
  await sleep(0);
  click(view.host.querySelectorAll(".real-select-option")[1]!);
  await sleep(0);
  expect(view.host.querySelector(".reader-error")?.textContent).toBe(t.readerModel.failed);
  view.close();
});

const own = { logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "me@example.com" };
function claudeStatus(over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    path: "/u/claude", source: "path", version: "2.1.294", sdk_version: "2.1.289", outdated: false, ...own, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: "2026-10-08T00:00:00.000Z", error: null,
    accounts: [{ config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" }],
    ...over,
  };
}
const statusOf = (status: ClaudeCodeStatus | Error) => async () => {
  if (status instanceof Error) throw status;
  return status;
};
const optionTexts = (host: HTMLElement) => [...host.querySelectorAll(".real-select-option")].map(text);

test("with Claude Code signed in, its models are their own group, haiku first, and choosing one saves it on the default account", async () => {
  const { sent, patch } = fakePatch();
  const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: null, patch, claudeCode: statusOf(claudeStatus()), t });
  await sleep(0);
  expect(view.host.querySelector("[data-reader-account]")).toBeNull();
  expect(view.host.querySelector("[data-reader-claude-note]")?.textContent).toBe(t.readerModel.claudeNote);
  click(trigger(view.host));
  await sleep(0);
  expect(view.host.querySelector(".real-select-group")?.textContent).toBe(t.sidebar.botRunnerClaude);
  expect(optionTexts(view.host).slice(-4)).toEqual(["haiku", "sonnet", "opus", "fable"].map(claudeRow));
  const marks = [...view.host.querySelectorAll(".real-select-option")].map((el) => el.querySelector("[data-model-source]")?.getAttribute("data-model-source") ?? null);
  expect(marks).toEqual([null, "custom", "custom", "custom", "claude-agent", "claude-agent", "claude-agent", "claude-agent"]);
  click([...view.host.querySelectorAll(".real-select-option")].at(-4)!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: { runner: "claude_code", model: "haiku", config_dir: null } }]);
  view.close();
});

test("no Claude group while Claude Code is missing, signed out, or cannot be asked, unless a Claude model is already chosen", async () => {
  for (const status of [claudeStatus({ path: null, accounts: [] }), claudeStatus({ logged_in: false, accounts: [{ config_dir: null, config_directory: null, ...own, logged_in: false, error: null, login_command: "claude auth login" }] }), new Error("404")]) {
    const view = render(ReaderModelCard, { providers, chosen: null, defaultModel: null, patch: fakePatch().patch, claudeCode: statusOf(status), t });
    await sleep(0);
    click(trigger(view.host));
    await sleep(0);
    expect(view.host.querySelector(".real-select-group")).toBeNull();
    expect(view.host.querySelector("[data-reader-claude-note]")).toBeNull();
    view.close();
  }
  // On the phone, which cannot ask: the model chosen on the Mac stays shown, and can be swapped for another.
  const phone = render(ReaderModelCard, { providers, chosen: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" }, defaultModel: null, patch: fakePatch().patch, claudeCode: statusOf(new Error("404")), t });
  await sleep(0);
  expect(text(trigger(phone.host))).toBe(claudeRow("haiku"));
  expect(phone.host.querySelector("[data-reader-account]")).toBeNull();
  phone.close();
});

test("with several accounts listed there is an account select; changing it re-saves the chosen Claude model, and picking an endpoint model saves that", async () => {
  const { sent, patch } = fakePatch();
  const status = claudeStatus({
    accounts: [
      { config_dir: null, config_directory: null, ...own, error: null, login_command: "claude auth login" },
      { config_dir: "/opt/claude-b", config_directory: "/opt/claude-b", ...own, email: "b@example.com", error: null, login_command: "x" },
    ],
  });
  const view = render(ReaderModelCard, { providers, chosen: { runner: "claude_code", model: "sonnet", config_dir: null }, defaultModel: null, patch, claudeCode: statusOf(status), t });
  await sleep(0);
  expect(text(trigger(view.host))).toBe(claudeRow("sonnet"));
  const account = view.host.querySelector("[data-reader-account] .real-select-trigger")!;
  expect(account.textContent).toContain(t.sidebar.botAgentAccountDefault);
  click(account);
  await sleep(0);
  const accounts = [...view.host.querySelectorAll("[data-reader-account] .real-select-option")];
  expect(accounts).toHaveLength(2);
  click(accounts[1]!);
  await sleep(0);
  expect(sent).toEqual([{ reader_model: { runner: "claude_code", model: "sonnet", config_dir: "/opt/claude-b" } }]);
  view.close();

  // With nothing chosen yet, the account picked first is the one a model is then chosen on.
  const later = fakePatch();
  const fresh = render(ReaderModelCard, { providers, chosen: null, defaultModel: null, patch: later.patch, claudeCode: statusOf(status), t });
  await sleep(0);
  click(fresh.host.querySelector("[data-reader-account] .real-select-trigger")!);
  await sleep(0);
  click(fresh.host.querySelectorAll("[data-reader-account] .real-select-option")[1]!);
  await sleep(0);
  expect(later.sent).toEqual([]);
  click(trigger(fresh.host));
  await sleep(0);
  click([...fresh.host.querySelectorAll(".reader-pick .real-select-option")].at(-4)!);
  await sleep(0);
  expect(later.sent).toEqual([{ reader_model: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-b" } }]);
  fresh.close();
});
