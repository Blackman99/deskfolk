import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aMessage, aProjectSession, anAgentRun, fakeRuntime } from "../test-fixtures.ts";
import { settle } from "../test-async.ts";
import { click, fill, press, render } from "../test-render.ts";
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
  const view = render(ProjectChat, { runtime, t, selected: session });
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

test("a running run shows what it does, what it has said, and Stop", () => {
  const { host, runtime, close } = open(anAgentRun({ activity: "Bash npm test", partial: "先看一下 **日志**" }));
  expect(host.querySelector("[data-agent-run]")?.textContent).toContain(t.project.working);
  expect(host.querySelector(".activity")?.textContent).toBe("Bash npm test");
  expect(host.querySelector(".partial strong")?.textContent).toBe("日志");
  expect(host.querySelector("[data-agent-approval]")).toBeNull();
  const stop = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(t.project.stop));
  click(stop);
  expect(runtime.calls.find((c) => c.name === "stopAgentRun")?.args).toEqual(["run-1"]);
  close();
});

test("a run waiting on you shows the approval card and answers it", async () => {
  const { host, runtime, close } = open(
    anAgentRun({ status: "waiting_approval", approval: { kind_key: "bash", target: "rm -rf dist", summary: "Bash: rm -rf dist" } }),
  );
  expect(host.querySelector("[data-agent-approval] pre")?.textContent).toBe("Bash: rm -rf dist");
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

test("the composer picks the session's model: your settings' default, Claude Code's names, and one set elsewhere stays a choice", async () => {
  const { host, runtime, close } = open(null);
  const trigger = host.querySelector("[data-project-model] .real-select-trigger");
  // The thinking level's picker sits beside it: two pickers, so each is read in its own box.
  expect(trigger?.textContent).toContain(t.project.modelDefault);
  click(trigger);
  const rows = () => [...host.querySelectorAll("[data-project-model] [role=option]")].map((row) => row.querySelector(".real-select-option-label")?.textContent?.trim());
  expect(rows()).toEqual([t.project.modelDefault, "sonnet", "opus", "haiku", "fable"]);
  expect(host.querySelector("[data-project-model]")?.getAttribute("title")).toBe(t.project.modelDefaultHint);
  click([...host.querySelectorAll("[data-project-model] [role=option]")].find((row) => row.textContent?.includes("opus")) ?? null);
  await settle();
  expect(runtime.calls.find((c) => c.name === "tuneProjectSession")?.args).toEqual(["proj-1", { model: "opus" }]);
  close();

  const session = aProjectSession({ project_model: "claude-opus-5-5" });
  const pinned = fakeRuntime({ sessions: [session] });
  const view = render(ProjectChat, { runtime: pinned, t, selected: session });
  expect(view.host.querySelector("[data-project-model] .real-select-trigger")?.textContent).toContain("claude-opus-5-5");
  click(view.host.querySelector("[data-project-model] .real-select-trigger"));
  click([...view.host.querySelectorAll("[data-project-model] [role=option]")].find((row) => row.textContent?.includes(t.project.modelDefault)) ?? null);
  await settle();
  expect(pinned.calls.find((c) => c.name === "tuneProjectSession")?.args).toEqual(["proj-1", { model: null }]);
  view.close();
});

test("the composer picks the session's thinking level beside the model, the default first", async () => {
  const { host, runtime, close } = open(null);
  const box = host.querySelector("[data-project-effort]");
  expect(box?.getAttribute("title")).toBe(t.project.effortDefaultHint);
  expect(box?.querySelector(".real-select-trigger")?.textContent).toContain(t.project.effortDefault);
  click(box?.querySelector(".real-select-trigger"));
  const rows = [...host.querySelectorAll("[data-project-effort] [role=option]")];
  expect(rows.map((row) => row.querySelector(".real-select-option-label")?.textContent?.trim())).toEqual([t.project.effortDefault, "低", "中", "高", "极高", "最大"]);
  click(rows.find((row) => row.textContent?.includes("极高")) ?? null);
  await settle();
  expect(runtime.calls.find((c) => c.name === "tuneProjectSession")?.args).toEqual(["proj-1", { effort: "xhigh" }]);
  close();

  const session = aProjectSession({ project_effort: "max" });
  const set = render(ProjectChat, { runtime: fakeRuntime({ sessions: [session] }), t, selected: session });
  expect(set.host.querySelector("[data-project-effort] .real-select-trigger")?.textContent).toContain("最大");
  expect(set.host.querySelector("[data-project-effort]")?.getAttribute("title")).toBeNull();
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
  const { host, close } = render(ProjectChat, { runtime, t, selected: session });
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
