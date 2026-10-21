import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import type { ProjectPathLookup } from "@real-bot/protocol";
import { aMessage, aProjectSession, anAgentRun, anAttachment, fakeRuntime } from "../test-fixtures.ts";
import { toasts } from "../toast.svelte.ts";
import { settle } from "../test-async.ts";
import { click, fill, press, render } from "../test-render.ts";
import { flushSync } from "svelte";
import ProjectChat from "./ProjectChat.svelte";

const t = copyFor("zh");

function open(run: ReturnType<typeof anAgentRun> | null, stubs: Record<string, unknown> = {}) {
  const session = aProjectSession();
  const runtime = fakeRuntime(
    {
      sessions: [session],
      messages: [
        aMessage({ id: "m1", session_id: "proj-1", body: "跑一下测试", created_at: "2026-09-19T02:00:00.000Z" }),
        aMessage({ id: "m2", session_id: "proj-1", kind: "bot", author: "agent", body: "**好的**，在跑。", created_at: "2026-09-19T02:00:05.000Z" }),
        aMessage({ id: "m3", session_id: "proj-1", kind: "system", author: "app", body: "来自终端会话", created_at: "2026-09-19T02:00:06.000Z" }),
      ],
      agentRuns: run ? { "proj-1": run } : {},
    },
    stubs,
  );
  const view = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: () => {} });
  return { ...view, runtime };
}

test("your lines, the agent's and the app's each sit in their own place", () => {
  const { host, close } = open(null);
  expect(host.querySelector('[data-line="you"] .bubble')?.textContent).toBe("跑一下测试");
  expect(host.querySelector('[data-line="agent"] strong')?.textContent).toBe("好的");
  expect(host.querySelector('[data-line="app"]')?.textContent).toBe("来自终端会话");
  expect(host.querySelector("[data-agent-run]")).toBeNull();
  close();
});

test("a running run is a working bubble at the end, as a Bot's, with Stop in the composer", () => {
  const { host, runtime, close } = open(anAgentRun({ activity: "Bash npm test", partial: "先看一下 **日志**" }));
  const bubble = host.querySelector('[data-line="working"][data-agent-run]');
  expect(bubble?.querySelector("strong")?.textContent).toBe("日志");
  expect(bubble?.querySelector(".streaming-cursor")).not.toBeNull();
  // Before any tool frame has come, the step is the one the run last stored.
  expect(bubble?.querySelector(".stream-foot .stream-step")?.textContent).toBe("Bash npm test");
  expect(bubble?.querySelector(".stream-foot .duration-badge")).not.toBeNull();
  expect(host.querySelector("[data-agent-approval]")).toBeNull();
  // No Stop in the bubble: it is beside Send, as in a Bot's direct.
  expect(bubble?.querySelector("button")).toBeNull();
  const stop = host.querySelector<HTMLButtonElement>(`.composer button[aria-label="${t.composer.stopGeneration}"]`);
  click(stop);
  expect(runtime.calls.find((c) => c.name === "stopAgentRun")?.args).toEqual(["run-1"]);
  close();
});

test("the working bubble reads the run's tool frames: its commands folded above the step it is on", async () => {
  const session = aProjectSession();
  const runtime = fakeRuntime({ sessions: [session], agentRuns: { "proj-1": anAgentRun() } });
  const now = Date.now();
  (runtime as unknown as { stepOf: (id: string) => unknown }).stepOf = (id: string) =>
    id === "run-1" ? { id: "c2", name: "Read", target: "src/login.ts", mcp: null, startedAt: now, running: true, exitCode: null } : null;
  runtime.activity.applyTool({ type: "tool", turn_id: "run-1", id: "c1", name: "Bash", phase: "started", command: "bun test src/a.test.ts" });
  runtime.activity.applyTool({ type: "tool", turn_id: "run-1", id: "c1", name: "Bash", phase: "exited", command: "bun test src/a.test.ts", exit_code: 0, duration_ms: 1200 });
  const { host, close } = render(ProjectChat, { runtime, t, selected: session });
  const bubble = host.querySelector('[data-line="working"]');
  // Folded, as a Bot's: how many, and the commands once opened.
  const card = bubble?.querySelector(".command-activity");
  expect(card?.textContent).not.toContain("bun test");
  click(card?.querySelector("button"));
  await settle();
  expect(card?.textContent).toContain("bun test");
  expect(bubble?.querySelector(".stream-step")?.textContent).toContain("src/login.ts");
  close();
});

test("a run waiting on you shows the approval card and answers it", async () => {
  const { host, runtime, close } = open(
    anAgentRun({ status: "waiting_approval", approval: { kind_key: "bash", target: "rm -rf dist", summary: "Bash: rm -rf dist" } }),
  );
  expect(host.querySelector("[data-agent-approval] pre")?.textContent).toBe("Bash: rm -rf dist");
  expect(host.querySelector('[data-line="working"] .stream-step')?.textContent).toBe(t.project.waiting);
  const byText = (text: string) => [...host.querySelectorAll("[data-agent-approval] button")].find((b) => b.textContent?.trim() === text);
  click(byText(t.project.allow));
  await settle();
  click(byText(t.project.deny));
  const answers = runtime.calls.filter((c) => c.name === "answerAgentRun").map((c) => c.args);
  expect(answers).toEqual([["run-1", true], ["run-1", false]]);
  close();
});

test("a finished run leaves no live area", () => {
  const { host, close } = open(anAgentRun({ status: "completed" }));
  expect(host.querySelector("[data-agent-run]")).toBeNull();
  close();
});

test("Enter sends the line, Shift+Enter and an input method's Enter do not", () => {
  const sent: unknown[][] = [];
  const { host, close } = open(null, { send: (...args: unknown[]) => { sent.push(args); return Promise.resolve(true); } });
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  fill(field, "再跑一次");
  press(field, "Enter", { shiftKey: true });
  press(field, "Enter", { isComposing: true });
  expect(sent).toHaveLength(0);
  press(field, "Enter");
  expect(sent).toEqual([[{ sessionId: "proj-1" }]]);
  close();
});

test("opening the chat reads the session's newest run once", () => {
  const { runtime, close } = open(null);
  expect(runtime.calls.filter((c) => c.name === "loadProjectRun").map((c) => c.args)).toEqual([["proj-1"]]);
  close();
});

/** The composer's picker of the account, the model and the thinking level, and its columns once open. */
const tuneTrigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-project-tune] .tune-trigger");
const tuneRows = (host: HTMLElement, level: string) => [...host.querySelectorAll<HTMLElement>(`[data-tune-column="${level}"] [role=option]`)];
const tuneLabels = (host: HTMLElement, level: string) => tuneRows(host, level).map((row) => row.querySelector(".tune-row-label, .sheet-item-label")?.firstChild?.textContent?.trim());
const tuneRow = (host: HTMLElement, level: string, label: string) => tuneRows(host, level).find((row) => row.querySelector(".tune-row-label, .sheet-item-label")?.firstChild?.textContent?.trim() === label) ?? null;
const tunes = (runtime: ReturnType<typeof fakeRuntime>) => runtime.calls.filter((c) => c.name === "tuneProjectSession").map((c) => c.args);

test("one picker holds the model and its thinking level: the session's path opens at once, your settings' default first, one set elsewhere stays a choice", async () => {
  const { host, runtime, close } = open(null);
  const trigger = tuneTrigger(host);
  expect(trigger?.textContent).toContain(t.project.modelDefault);
  expect(trigger?.textContent).toContain(t.project.effortDefault);
  expect(trigger?.getAttribute("title")).toContain(t.project.modelDefaultHint);
  click(trigger);
  // One account: its column is left out; the model's levels open beside the models.
  expect(host.querySelector('[data-tune-column="account"]')).toBeNull();
  expect(tuneLabels(host, "model")).toEqual([t.project.modelDefault, "sonnet", "opus", "haiku", "fable"]);
  expect(tuneLabels(host, "effort")).toEqual([t.project.effortDefault, "低", "中", "高", "极高", "最大"]);
  expect(tuneRow(host, "model", t.project.modelDefault)?.getAttribute("aria-selected")).toBe("true");
  click(tuneRow(host, "model", "opus"));
  await settle();
  expect(tunes(runtime)).toEqual([["proj-1", { model: "opus" }]]);
  expect(host.querySelector("[data-tune-column]")).toBeNull();
  close();

  const session = aProjectSession({ project_model: "claude-opus-5-5" });
  const pinned = fakeRuntime({ sessions: [session] });
  const view = render(ProjectChat, { runtime: pinned, t, selected: session, onOpenArtifact: () => {} });
  expect(tuneTrigger(view.host)?.textContent).toContain("claude-opus-5-5");
  click(tuneTrigger(view.host));
  click(tuneRow(view.host, "model", t.project.modelDefault));
  await settle();
  expect(tunes(pinned)).toEqual([["proj-1", { model: null }]]);
  view.close();
});

test("the thinking level is the picker's last column, the default first", async () => {
  const { host, runtime, close } = open(null);
  click(tuneTrigger(host));
  click(tuneRow(host, "effort", "极高"));
  await settle();
  expect(tunes(runtime)).toEqual([["proj-1", { effort: "xhigh" }]]);
  close();

  const session = aProjectSession({ project_effort: "max" });
  const set = render(ProjectChat, { runtime: fakeRuntime({ sessions: [session] }), t, selected: session, onOpenArtifact: () => {} });
  expect(tuneTrigger(set.host)?.textContent).toContain("最大");
  set.close();
});

test("the microphone puts what it heard where the caret was, in that session's box, and sends nothing", async () => {
  const { installFakeMic } = await import("../test-voice.ts");
  const mic = installFakeMic();
  const session = aProjectSession();
  const runtime = fakeRuntime({ sessions: [session] });
  runtime.snapshot = { ...runtime.snapshot, settings: { ...runtime.snapshot.settings, speech: { enabled: true, preset: "openai", format: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", language: null, key_provider_id: null, key_set: true } } };
  const sent: unknown[] = [];
  (runtime as unknown as { client: unknown }).client = { transcribe: async (body: unknown) => (sent.push(body), { text: "中间" }) };
  runtime.sessionView(session.id).draft = "前后";
  const { host, close } = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: () => {} });
  try {
    const field = host.querySelector<HTMLTextAreaElement>(".project-chat textarea")!;
    field.setSelectionRange(1, 1);
    const button = () => host.querySelector<HTMLButtonElement>("[data-voice-button]");
    expect(button()?.getAttribute("aria-label")).toBe(t.speech.micStart);
    click(button());
    await settle();
    expect(host.querySelector("[data-voice-status]")?.textContent).toContain("正在听");
    click(button());
    await settle();
    await settle();
    expect(sent).toHaveLength(1);
    expect(runtime.sessionView(session.id).draft).toBe("前中间后");
    expect(runtime.calls.some((c) => c.name === "send")).toBe(false);
  } finally {
    close();
    mic.restore();
  }
});

test("no speech endpoint, no microphone", () => {
  const { host, close } = open(null);
  expect(host.querySelector("[data-voice-button]")).toBeNull();
  close();
});

test("a file the agent cites opens where the Mac finds it under the project; one it cannot place is said, not opened", async () => {
  const session = aProjectSession();
  const runtime = fakeRuntime({
    sessions: [session],
    messages: [aMessage({
      id: "m1", session_id: "proj-1", kind: "bot", author: "agent", created_at: "2026-09-19T02:00:05.000Z",
      body: "改了 `comm/defs.go`，分支 `feat/adverse-media`，看 `server.go`，日志在 `/tmp/out/run.log`。",
    })],
  });
  const asked: Array<[string, string]> = [];
  const answers: Record<string, ProjectPathLookup> = {
    "comm/defs.go": { path: "/Users/a/proj/steez/comm/defs.go", kind: "file", matches: ["steez/comm/defs.go"] },
    "feat/adverse-media": { path: null, kind: null, matches: [] },
    "server.go": { path: null, kind: null, matches: ["a/server.go", "b/server.go"] },
  };
  (runtime as unknown as { client: unknown }).client = {
    locateProjectPath: async (id: string, path: string) => (asked.push([id, path]), answers[path]!),
  };
  const opened: unknown[][] = [];
  const { host, close } = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: (...args: unknown[]) => { opened.push(args); } });
  const chip = (path: string) => [...host.querySelectorAll<HTMLAnchorElement>("a.md-artifact-link")].find((a) => a.getAttribute("title") === path || a.textContent === path);
  try {
    toasts.current = null;
    click(chip("comm/defs.go"));
    await settle();
    expect(opened).toEqual([["/Users/a/proj/steez/comm/defs.go", undefined, "m1"]]);
    // Found once, opened again without asking.
    click(chip("comm/defs.go"));
    await settle();
    expect(opened).toHaveLength(2);
    expect(asked).toEqual([["proj-1", "comm/defs.go"]]);

    click(chip("feat/adverse-media"));
    await settle();
    expect(opened).toHaveLength(2);
    expect(toasts.current?.text).toBe(t.project.citedMissing("feat/adverse-media"));

    click(chip("server.go"));
    await settle();
    expect(opened).toHaveLength(2);
    expect(toasts.current?.text).toBe(t.project.citedAmbiguous("server.go", 2));

    // A path written absolute says where it is: it opens as written, nothing asked.
    click(chip("/tmp/out/run.log"));
    expect(opened.at(-1)).toEqual(["/tmp/out/run.log", undefined, "m1"]);
    expect(asked).toHaveLength(3);
  } finally {
    toasts.current = null;
    close();
  }
});

test("the account is the picker's first column; another account's models open beside it and a pick takes the path in one change", async () => {
  const { forgetClaudeOptions } = await import("./project-agent-options.svelte.ts");
  forgetClaudeOptions();
  const session = aProjectSession({ project_config_dir: "/Users/a/.claude-b", project_model: "haiku" });
  const runtime = fakeRuntime({ sessions: [session] });
  const askedModels: Array<string | null> = [];
  (runtime as unknown as { client: unknown }).client = {
    claudeCode: async () => ({ email: "me@a.com", accounts: [{ config_dir: null, email: "me@a.com" }, { config_dir: "/Users/a/.claude-b", email: "team@b.com" }] }),
    claudeCodeModels: async (dir: string | null) => (askedModels.push(dir), { config_dir: dir, checked_at: "t", error: null, models: [
      { value: "default", display_name: "Default (recommended)", description: "Opus 5.5", resolved_model: "claude-opus-5-5", efforts: ["low", "high"] },
      { value: "haiku", display_name: "Haiku 5.5", description: "Fastest", resolved_model: "claude-haiku-5-5", efforts: [] },
    ] }),
  };
  const { host, close } = render(ProjectChat, { runtime, t, selected: session });
  await settle();
  await settle();
  expect(askedModels).toEqual(["/Users/a/.claude-b"]);
  const trigger = tuneTrigger(host);
  expect(trigger?.textContent).toContain("Haiku 5.5");
  expect(trigger?.textContent).toContain("team@b.com");
  // Haiku takes no thinking level: there is none to show or pick.
  expect(trigger?.textContent).not.toContain(t.project.effortDefault);
  expect(trigger?.getAttribute("title")).toContain("Fastest");
  click(trigger);
  expect(tuneLabels(host, "account")).toEqual(["me@a.com", "team@b.com"]);
  expect(tuneLabels(host, "model")).toEqual(["Default (recommended)", "Haiku 5.5"]);
  // What Claude Code says of each model sits under its name.
  expect(tuneRow(host, "model", "Haiku 5.5")?.querySelector(".tune-row-detail")?.textContent).toBe("Fastest");
  expect(host.querySelector('[data-tune-column="effort"]')).toBeNull();
  click(tuneRow(host, "account", "me@a.com"));
  await settle();
  expect(tunes(runtime)).toEqual([["proj-1", { config_dir: null }]]);

  // By the keys: to the accounts, up to the other one (its models are asked for), over to its models, up to the default, taken.
  click(trigger);
  press(trigger, "ArrowLeft");
  press(trigger, "ArrowUp");
  await settle();
  expect(askedModels).toEqual(["/Users/a/.claude-b", null]);
  expect(tuneRow(host, "account", "me@a.com")?.classList.contains("is-focus")).toBe(true);
  press(trigger, "ArrowRight");
  press(trigger, "ArrowUp");
  // The default takes levels: they open beside it.
  expect(tuneLabels(host, "effort")).toEqual([t.project.effortDefault, "低", "高"]);
  press(trigger, "Enter");
  await settle();
  expect(tunes(runtime)[1]).toEqual(["proj-1", { config_dir: null, model: null }]);
  close();
  forgetClaudeOptions();
});

test("a model that does not take the session's thinking level takes it back to the default; a level picked beside a model takes both", async () => {
  const { forgetClaudeOptions } = await import("./project-agent-options.svelte.ts");
  forgetClaudeOptions();
  const session = aProjectSession({ project_effort: "high" });
  const runtime = fakeRuntime({ sessions: [session] });
  (runtime as unknown as { client: unknown }).client = {
    claudeCode: async () => ({ email: "me@a.com", accounts: [{ config_dir: null, email: "me@a.com" }] }),
    claudeCodeModels: async (dir: string | null) => ({ config_dir: dir, checked_at: "t", error: null, models: [
      { value: "default", display_name: "Default (recommended)", description: "Opus 5.5", resolved_model: "claude-opus-5-5", efforts: ["low", "high"] },
      { value: "sonnet", display_name: "Sonnet 5.5", description: "", resolved_model: "claude-sonnet-5-5", efforts: ["low", "medium", "high"] },
      { value: "haiku", display_name: "Haiku 5.5", description: "Fastest", resolved_model: "claude-haiku-5-5", efforts: [] },
    ] }),
  };
  const { host, close } = render(ProjectChat, { runtime, t, selected: session });
  await settle();
  await settle();
  const pick = (label: string) => {
    click(tuneTrigger(host));
    click(tuneRow(host, "model", label));
  };
  pick("Sonnet 5.5");
  await settle();
  pick("Haiku 5.5");
  await settle();
  expect(tunes(runtime)).toEqual([["proj-1", { model: "sonnet" }], ["proj-1", { model: "haiku", effort: null }]]);

  // Down to Sonnet by the keys: its levels open beside it, the session's 高 checked; 中 there takes Sonnet with it.
  click(tuneTrigger(host));
  press(tuneTrigger(host), "ArrowDown");
  expect(tuneLabels(host, "effort")).toEqual([t.project.effortDefault, "低", "中", "高"]);
  expect(tuneRow(host, "effort", "高")?.getAttribute("aria-selected")).toBe("true");
  click(tuneRow(host, "effort", "中"));
  await settle();
  expect(tunes(runtime)[2]).toEqual(["proj-1", { model: "sonnet", effort: "medium" }]);
  close();
  forgetClaudeOptions();
});

test("one account only: no account to pick; the account waits while a run is going", async () => {
  const { forgetClaudeOptions } = await import("./project-agent-options.svelte.ts");
  forgetClaudeOptions();
  const status = (accounts: unknown[]) => async () => ({ email: "me@a.com", accounts });
  const single = fakeRuntime({ sessions: [aProjectSession()] });
  (single as unknown as { client: unknown }).client = { claudeCode: status([{ config_dir: null, email: "me@a.com" }]), claudeCodeModels: async () => { throw new Error("old Mac"); } };
  const one = render(ProjectChat, { runtime: single, t, selected: aProjectSession() });
  await settle();
  click(tuneTrigger(one.host));
  expect(one.host.querySelector('[data-tune-column="account"]')).toBeNull();
  // A Mac that cannot list its models: Claude Code's aliases.
  expect(tuneLabels(one.host, "model")).toContain("opus");
  one.close();
  forgetClaudeOptions();
  const busy = fakeRuntime({ sessions: [aProjectSession()], agentRuns: { "proj-1": anAgentRun() } });
  (busy as unknown as { client: unknown }).client = { claudeCode: status([{ config_dir: null, email: "me@a.com" }, { config_dir: "/b", email: "b@b.com" }]), claudeCodeModels: async () => { throw new Error("no"); } };
  const two = render(ProjectChat, { runtime: busy, t, selected: aProjectSession() });
  await settle();
  // The model and its level still change mid-run; only the other account waits.
  expect(tuneTrigger(two.host)?.disabled).toBe(false);
  click(tuneTrigger(two.host));
  expect(tuneRow(two.host, "account", "b@b.com")?.getAttribute("aria-disabled")).toBe("true");
  expect(two.host.querySelector('[data-tune-column="account"] .tune-note')?.textContent).toBe(t.project.accountBusy);
  click(tuneRow(two.host, "account", "b@b.com"));
  await settle();
  expect(tunes(busy)).toEqual([]);
  two.close();
  forgetClaudeOptions();
});

test("on a phone the picker is a sheet: the three with what each is now, and a level of its own for each", async () => {
  const { forgetClaudeOptions } = await import("./project-agent-options.svelte.ts");
  forgetClaudeOptions();
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    const session = aProjectSession({ project_effort: "high" });
    const runtime = fakeRuntime({ sessions: [session] });
    (runtime as unknown as { client: unknown }).client = {
      claudeCode: async () => ({ email: "me@a.com", accounts: [{ config_dir: null, email: "me@a.com" }, { config_dir: "/b", email: "b@b.com" }] }),
      claudeCodeModels: async () => { throw new Error("no"); },
    };
    const { host, close } = render(ProjectChat, { runtime, t, selected: session });
    await settle();
    click(tuneTrigger(host));
    const nav = [...host.querySelectorAll("[data-tune-level]")];
    expect(nav.map((row) => row.getAttribute("data-tune-level"))).toEqual(["account", "model", "effort"]);
    expect(nav[2]?.textContent).toContain("高");
    click(nav[1]);
    expect(host.querySelector(".bottom-sheet-title")?.textContent).toBe(t.project.modelLabel);
    // Back goes up a level, not out of the sheet.
    click(host.querySelector(`.bottom-sheet-head button[aria-label="${t.common.back}"]`));
    expect(host.querySelectorAll("[data-tune-level]")).toHaveLength(3);
    click(host.querySelector('[data-tune-level="model"]'));
    click(tuneRow(host, "model", "sonnet"));
    await settle();
    expect(tunes(runtime)).toEqual([["proj-1", { model: "sonnet" }]]);
    expect(host.querySelector(".bottom-sheet-layer")).toBeNull();
    close();
  } finally {
    window.matchMedia = previous;
    forgetClaudeOptions();
  }
});

/** A paste as WebKit hands it over: a screenshot is one file item and no text; words are text alone. */
function paste(field: HTMLElement, data: { files?: File[]; text?: string }): Event {
  const items = (data.files ?? []).map((file) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) }));
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { items, types: items.length ? ["Files"] : ["text/plain"], getData: () => data.text ?? "" } });
  field.dispatchEvent(ev);
  flushSync();
  return ev;
}

test("a pasted picture waits in the box and goes with your line, even alone; it leaves the box once the Mac has it", async () => {
  const sent: unknown[] = [];
  const answers: Array<(ok: boolean) => void> = [];
  const { host, close } = open(null, { send: (opts: unknown) => { sent.push(opts); return new Promise<boolean>((resolve) => answers.push(resolve)); } });
  const field = host.querySelector("textarea") as HTMLTextAreaElement;
  // Words paste as the field pastes them.
  expect(paste(field, { text: "一句话" }).defaultPrevented).toBe(false);
  const shot = new File(["png"], "image.png", { type: "image/png" });
  expect(paste(field, { files: [shot] }).defaultPrevented).toBe(true);
  expect(host.querySelectorAll(".composer-attachment-item.is-img")).toHaveLength(1);
  expect((host.querySelector('[aria-label="发送"]') as HTMLButtonElement | null)?.disabled).toBe(false);

  press(field, "Enter");
  expect(sent).toEqual([{ sessionId: "proj-1", attachments: [shot] }]);
  // A send that fails keeps it; one the Mac has takes it out.
  answers.shift()!(false);
  await settle();
  expect(host.querySelectorAll(".composer-attachment-item")).toHaveLength(1);
  press(field, "Enter");
  answers.shift()!(true);
  await settle();
  expect(host.querySelectorAll(".composer-attachment-item")).toHaveLength(0);
  close();
});

test("the clip picks files for your line", () => {
  const { host, runtime, close } = open(null);
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  let picked = 0;
  input.click = () => { picked += 1; };
  click(host.querySelector("[data-project-attach]") as HTMLElement);
  expect(picked).toBe(1);
  const notes = new File(["# notes"], "notes.md", { type: "text/markdown" });
  Object.defineProperty(input, "files", { value: [notes], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(runtime.sessionView("proj-1").stagedAttachments.map((row) => [row.name, row.isImage])).toEqual([["notes.md", false]]);
  close();
});

test("a line of yours shows its picture in its bubble, and a click enlarges it", () => {
  const session = aProjectSession();
  const picture = anAttachment({ id: "a1", message_id: "m1", workspace_relpath: "inbox/2026-10-21/shot.png", original_filename: "shot.png", mime: "image/png" });
  const runtime = fakeRuntime({ sessions: [session], messages: [aMessage({ id: "m1", session_id: "proj-1", body: "", attachments: [picture], created_at: "2026-09-19T02:00:00.000Z" })] });
  const { host, close } = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: () => {} });
  const bubble = host.querySelector('[data-line="you"] .bubble') as HTMLElement;
  // No words, no empty line of them.
  expect(bubble.querySelector(".words") === null).toBe(true);
  expect(bubble.querySelector(".attachment-file-btn")?.getAttribute("title")).toBe("inbox/2026-10-21/shot.png");
  expect(host.querySelector(".msg-image-lightbox") === null).toBe(true);
  click(bubble.querySelector(".attachment-file-btn") as HTMLElement);
  expect(host.querySelector(".msg-image-lightbox") === null).toBe(false);
  close();
});
