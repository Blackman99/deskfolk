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
