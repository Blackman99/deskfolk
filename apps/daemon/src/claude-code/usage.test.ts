import { expect, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { ClaudeCodeProbe } from "./probe";
import { CLAUDE_USAGE_MAX_AGE_MS, createClaudeUsageProbe, readUsage, type AskUsage, type UsageAnswer } from "./usage";

const signedIn: ClaudeCodeStatus = {
  path: "/u/claude", source: "path", version: "2.1.294", sdk_version: "2.1.289", outdated: false,
  logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, base_url_set: false,
  proxy: "http://127.0.0.1:12334", proxy_source: "system", checked_at: "2026-10-08T00:00:00.000Z", error: null,
};

function probeOf(status: ClaudeCodeStatus): ClaudeCodeProbe {
  return { last: () => status, current: async () => status, detect: async () => status };
}

/** What Claude Code 2.1.294 answered on a Pro plan, 2026-10-08, with the untyped keys it also sent. */
const answer: UsageAnswer & Record<string, unknown> = {
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 2, resets_at: "2026-10-08T15:49:59.889937+00:00" },
    seven_day: { utilization: 91, resets_at: "2026-10-11T01:59:59.889960+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: "Fable", utilization: 4, resets_at: "2026-10-11T01:59:59.890163+00:00" }],
    ...{ iguana_necktie: { utilization: 26.9, resets_at: "2026-11-05T07:59:00+00:00" }, limits: [{ percent: 2 }] },
  } as UsageAnswer["rate_limits"],
};

test("the plan's two windows come first, then each model's own; keys the SDK does not type are left out", () => {
  const usage = readUsage(answer, "2026-10-08T11:00:00.000Z");
  expect(usage).toEqual({
    available: true, reason: null, plan: "pro", checked_at: "2026-10-08T11:00:00.000Z", error: null,
    windows: [
      { kind: "five_hour", model: null, percent: 2, resets_at: "2026-10-08T15:49:59.889937+00:00" },
      { kind: "seven_day", model: null, percent: 91, resets_at: "2026-10-11T01:59:59.889960+00:00" },
      { kind: "model", model: "Fable", percent: 4, resets_at: "2026-10-11T01:59:59.890163+00:00" },
    ],
  });
});

test("Opus and Sonnet's weekly windows are model rows, named once even when listed twice", () => {
  const usage = readUsage({
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 120, resets_at: "not a date" },
      seven_day_opus: { utilization: 40, resets_at: null },
      model_scoped: [{ display_name: "opus", utilization: 41, resets_at: null }, { display_name: " ", utilization: 1 }, { display_name: "Haiku", utilization: null }],
    },
  }, "t");
  expect(usage.windows).toEqual([
    { kind: "seven_day", model: null, percent: 100, resets_at: null },
    { kind: "model", model: "Opus", percent: 40, resets_at: null },
  ]);
});

test("an API key, a third-party platform or an empty answer has no plan to show", () => {
  expect(readUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, "t")).toMatchObject({ available: false, reason: "no_plan" });
  expect(readUsage({ rate_limits_available: true, rate_limits: { five_hour: null } }, "t")).toMatchObject({ available: false, reason: "no_plan" });
});

test("nothing is asked while no Bot runs on Claude Agent, or when claude is missing, signed out or billed per token", async () => {
  let asked = 0;
  const ask: AskUsage = async () => {
    asked += 1;
    return answer;
  };
  let inUse = false;
  const probe = createClaudeUsageProbe({ claudeCode: probeOf(signedIn), inUse: () => inUse, ask });
  expect(await probe.current()).toMatchObject({ available: false, reason: "unused" });
  for (const [status, reason] of [
    [{ ...signedIn, path: null }, "missing"],
    [{ ...signedIn, logged_in: false }, "signed_out"],
    [{ ...signedIn, auth_method: "api_key" }, "no_plan"],
    [{ ...signedIn, auth_method: "third_party" }, "no_plan"],
  ] as const) {
    const other = createClaudeUsageProbe({ claudeCode: probeOf(status), inUse: () => true, ask });
    expect(await other.current()).toMatchObject({ available: false, reason });
  }
  expect(asked).toBe(0);
  inUse = true;
  expect(await probe.current()).toMatchObject({ available: true });
  expect(asked).toBe(1);
});

test("one claude at a time, kept for a while; Claude Code is run with its own environment and the system proxy", async () => {
  let clock = 1_000_000;
  const launches: Array<{ executable: string; env: Record<string, string> }> = [];
  let resolve: (value: UsageAnswer) => void = () => {};
  const ask: AskUsage = (launch) => {
    launches.push(launch);
    return new Promise((done) => (resolve = done));
  };
  const probe = createClaudeUsageProbe({
    claudeCode: probeOf(signedIn), inUse: () => true, ask, now: () => clock,
    env: { PATH: "/usr/bin", CLAUDECODE: "1", REAL_BOT_DEV: "1", CLAUDE_CODE_OAUTH_TOKEN: "theirs" },
  });
  const both = Promise.all([probe.current(), probe.current()]);
  await Bun.sleep(0);
  resolve(answer);
  const [a, b] = await both;
  expect(a).toBe(b);
  expect(launches).toHaveLength(1);
  expect(launches[0]!.executable).toBe("/u/claude");
  expect(launches[0]!.env).toMatchObject({ PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:12334", CLAUDE_CODE_OAUTH_TOKEN: "theirs" });
  expect(launches[0]!.env.CLAUDECODE).toBeUndefined();
  expect(launches[0]!.env.REAL_BOT_DEV).toBeUndefined();
  clock += CLAUDE_USAGE_MAX_AGE_MS - 1;
  expect(await probe.current()).toBe(a);
  expect(launches).toHaveLength(1);
  // A refresh you ask for takes a shorter age, still bounded.
  clock += 1;
  const again = probe.current(30_000);
  await Bun.sleep(0);
  resolve(answer);
  await again;
  expect(launches).toHaveLength(2);
});

test("a failed ask keeps showing the last windows with its error, and is not retried at once", async () => {
  let clock = 0;
  let fail = false;
  let asked = 0;
  const ask: AskUsage = async () => {
    asked += 1;
    if (fail) throw new Error("Unsupported control request: get_usage");
    return answer;
  };
  const probe = createClaudeUsageProbe({ claudeCode: probeOf(signedIn), inUse: () => true, ask, now: () => clock });
  const first = await probe.current();
  fail = true;
  clock += CLAUDE_USAGE_MAX_AGE_MS;
  const failed = await probe.current();
  expect(failed).toMatchObject({ available: true, windows: first.windows, checked_at: first.checked_at, error: "Unsupported control request: get_usage" });
  expect(await probe.current()).toBe(failed);
  expect(asked).toBe(2);

  const never = createClaudeUsageProbe({ claudeCode: probeOf(signedIn), inUse: () => true, ask, now: () => clock });
  expect(await never.current()).toMatchObject({ available: false, reason: "failed", error: "Unsupported control request: get_usage" });
});
