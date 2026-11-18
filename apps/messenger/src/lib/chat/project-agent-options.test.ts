import { expect, setSystemTime, test } from "bun:test";
import type { ClaudeCodeStatus } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import { claudeModelsOf, loadClaudeModels } from "../claude-models.svelte.ts";
import { settle } from "../test-async.ts";
import {
  OPTIONS_FRESH_MS, accountChoices, agentsStatus, changedAccounts, claudeStatus, forgetClaudeOptions, loadAgentsStatus, loadClaudeStatus,
} from "./project-agent-options.svelte.ts";

test("accounts read by their email, this computer's own first", () => {
  const status = { email: "me@a.com", accounts: [
    { config_dir: null, email: "me@a.com" }, { config_dir: "/Users/a/.claude-b", email: "team@b.com" }, { config_dir: "/Users/a/.claude-c", email: null },
  ] } as unknown as ClaudeCodeStatus;
  expect(accountChoices(status, "", "默认账号")).toEqual([
    { value: "", label: "me@a.com" }, { value: "/Users/a/.claude-b", label: "team@b.com" }, { value: "/Users/a/.claude-c", label: "/Users/a/.claude-c" },
  ]);
  expect(accountChoices(null, "", "默认账号")).toEqual([{ value: "", label: "默认账号" }]);
  expect(accountChoices(null, "/gone", "默认账号").map((c) => c.value)).toEqual(["", "/gone"]);
});

const own = (email: string, extra: Record<string, unknown> = {}) => ({ config_dir: null, email, logged_in: true, auth_method: "claude.ai", subscription_type: "max", ...extra });
const statusOf = (...accounts: Array<Record<string, unknown>>) => ({ email: (accounts[0]?.email as string) ?? null, accounts }) as unknown as ClaudeCodeStatus;
const list = (dir: string | null, ...values: string[]) => ({ config_dir: dir, checked_at: "t", error: null, models: values.map((value) => ({ value, display_name: value, description: "", resolved_model: null, efforts: [] })) });

test("an account is another one when its directory signs in as someone else or on another plan; none on the first answer", () => {
  const before = statusOf(own("old@a.com"), { config_dir: "/b", email: "b@b.com", logged_in: true, auth_method: "claude.ai", subscription_type: "pro" });
  expect(changedAccounts(null, before)).toEqual([]);
  expect(changedAccounts(before, before)).toEqual([]);
  expect(changedAccounts(before, statusOf(own("new@a.com"), before.accounts![1]!))).toEqual([null]);
  expect(changedAccounts(before, statusOf(own("old@a.com"), { ...before.accounts![1]!, subscription_type: "max" }))).toEqual(["/b"]);
  // A daemon that lists no accounts still says who this computer signs in as.
  expect(changedAccounts({ email: "old@a.com" } as ClaudeCodeStatus, { email: "new@a.com" } as ClaudeCodeStatus)).toEqual([null]);
});

test("your accounts are asked for again once the answer has aged, the old one shown meanwhile, and a re-signed-in account's models with them", async () => {
  forgetClaudeOptions();
  let answer = statusOf(own("old@a.com"));
  let modelsAnswer = list(null, "opus");
  const asked: string[] = [];
  let release: () => void = () => {};
  const api = {
    claudeCode: async () => (asked.push("status"), answer),
    claudeCodeModels: async (dir: string | null) => {
      asked.push(`models ${dir}`);
      if (asked.filter((entry) => entry.startsWith("models")).length > 1) await new Promise<void>((resolve) => (release = resolve));
      return modelsAnswer;
    },
  } as unknown as MessengerApi;
  try {
    setSystemTime(new Date("2026-11-18T10:00:00Z"));
    loadClaudeStatus(api);
    loadClaudeModels(api, null);
    await settle();
    expect(accountChoices(claudeStatus(), "", "默认账号")[0]!.label).toBe("old@a.com");
    expect(claudeModelsOf(null)?.map((row) => row.value)).toEqual(["opus"]);

    // You sign in as someone else in a terminal; a picker opening a moment later does not ask again.
    answer = statusOf(own("new@a.com", { subscription_type: "pro" }));
    modelsAnswer = list(null, "sonnet");
    setSystemTime(new Date(Date.now() + OPTIONS_FRESH_MS - 1));
    loadClaudeStatus(api);
    await settle();
    expect(asked).toEqual(["status", "models null"]);

    // Once it has aged it asks; the new account shows, and its models are asked for with the old ones still listed.
    setSystemTime(new Date(Date.now() + 1));
    loadClaudeStatus(api);
    loadClaudeStatus(api);
    await settle();
    expect(asked).toEqual(["status", "models null", "status", "models null"]);
    expect(accountChoices(claudeStatus(), "", "默认账号")[0]!.label).toBe("new@a.com");
    expect(claudeModelsOf(null)?.map((row) => row.value)).toEqual(["opus"]);
    release();
    await settle();
    expect(claudeModelsOf(null)?.map((row) => row.value)).toEqual(["sonnet"]);

    // An ask that fails keeps what was had.
    api.claudeCode = async () => {
      throw new Error("offline");
    };
    setSystemTime(new Date(Date.now() + OPTIONS_FRESH_MS));
    loadClaudeStatus(api);
    await settle();
    expect(accountChoices(claudeStatus(), "", "默认账号")[0]!.label).toBe("new@a.com");
  } finally {
    setSystemTime();
    forgetClaudeOptions();
  }
});

test("your local agents are asked for again once the answer has aged, not at every picker", async () => {
  forgetClaudeOptions();
  let asks = 0;
  const api = { agents: async () => (asks++, { items: [] }) } as unknown as MessengerApi;
  try {
    setSystemTime(new Date("2026-11-18T10:00:00Z"));
    loadAgentsStatus(api);
    loadAgentsStatus(api);
    await settle();
    loadAgentsStatus(api);
    await settle();
    expect(asks).toBe(1);
    setSystemTime(new Date(Date.now() + OPTIONS_FRESH_MS));
    loadAgentsStatus(api);
    await settle();
    expect(asks).toBe(2);
    expect(agentsStatus()).toEqual({ items: [] } as unknown as ReturnType<typeof agentsStatus>);
  } finally {
    setSystemTime();
    forgetClaudeOptions();
  }
});
