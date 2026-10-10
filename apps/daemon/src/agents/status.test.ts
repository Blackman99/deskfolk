/**
 * The agents' statuses as Settings › Agents asks for them (ADR 0079): an agent takes seconds to ask,
 * so one seen before is shown as it was and looked at again behind it, and what was seen is kept
 * across restarts. The agents themselves are stood in for.
 */
import { expect, test } from "bun:test";
import type { AgentStatus, BotRunner, CustomAgent } from "@real-bot/protocol";
import { createAgentProbe, type AgentStatusMemory } from "./status";

function status(runner: BotRunner, version: string): AgentStatus {
  return {
    runner, custom_id: null, label: runner, path: `/bin/${runner}`, source: "path", version, logged_in: true, auth: null,
    login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "", error: null,
  };
}

function probe(options: { remembered?: AgentStatusMemory } = {}) {
  let clock = 1_000_000;
  let version = "1";
  const asked: string[] = [];
  const answers: Array<() => void> = [];
  let held = false;
  const saved: AgentStatusMemory[] = [];
  const agents = createAgentProbe({
    path: () => null,
    configDirs: () => [],
    customAgents: () => [] as CustomAgent[],
    now: () => clock,
    remembered: { load: () => options.remembered ?? {}, save: (memory) => saved.push(memory) },
    describe: async (runner) => {
      asked.push(runner);
      const answer = status(runner, version);
      if (held) await new Promise<void>((resolve) => answers.push(resolve));
      return answer;
    },
  });
  return {
    agents, asked, saved,
    later: (ms: number) => { clock += ms; },
    answerWith: (next: string) => { version = next; },
    hold: () => { held = true; },
    release: () => { held = false; for (const resolve of answers.splice(0)) resolve(); },
  };
}

test("the first look waits; one seen too long ago is shown as it was and looked at again behind it", async () => {
  const p = probe();
  const first = await p.agents.list();
  expect(first.refreshing).toBeUndefined();
  expect(first.items.find((item) => item.runner === "codex")?.version).toBe("1");
  const looks = p.asked.length;
  // Within a minute: nothing is asked again.
  p.later(30_000);
  expect((await p.agents.list()).refreshing).toBeUndefined();
  expect(p.asked).toHaveLength(looks);
  // Later: the old answer at once, a new look behind it, and `wait` has the new one.
  p.later(60_000);
  p.answerWith("2");
  p.hold();
  const stale = await p.agents.list();
  expect(stale.refreshing).toBe(true);
  expect(stale.items.find((item) => item.runner === "codex")?.version).toBe("1");
  expect(p.asked).toHaveLength(looks * 2);
  const waiting = p.agents.list(undefined, true);
  p.release();
  const fresh = await waiting;
  expect(fresh.refreshing).toBeUndefined();
  expect(fresh.items.find((item) => item.runner === "codex")?.version).toBe("2");
  // Waiting with nothing going asks nothing new.
  await p.agents.list(undefined, true);
  expect(p.asked).toHaveLength(looks * 2);
});

test("check again waits for every agent afresh", async () => {
  const p = probe();
  await p.agents.list();
  p.answerWith("3");
  const again = await p.agents.list(0);
  expect(again.items.every((item) => item.version === "3")).toBe(true);
});

test("what was seen is kept, and after a restart shown at once while it is looked at again", async () => {
  const first = probe();
  await first.agents.list();
  const kept = first.saved.at(-1)!;
  expect(Object.keys(kept).length).toBeGreaterThan(0);
  const restarted = probe({ remembered: kept });
  restarted.later(3_600_000);
  restarted.answerWith("4");
  restarted.hold();
  const shown = await restarted.agents.list();
  expect(shown.refreshing).toBe(true);
  expect(shown.items.find((item) => item.runner === "codex")?.version).toBe("1");
  restarted.release();
});
