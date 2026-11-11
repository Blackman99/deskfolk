/** Which of your Claude accounts work goes on with once one is out of usage (ADR 0110). */
import { expect, test } from "bun:test";
import type { ClaudeCodeAccount, ClaudeCodeStatus } from "@real-bot/protocol";
import type { AccountOut } from "../store/account-limits";
import { claudeSeats, pickClaudeAccount, soonestBack } from "./account-pick";

const env = { CLAUDE_CONFIG_DIR: undefined, HOME: "/Users/me" };
const account = (configDir: string | null, email: string | null, loggedIn = true): ClaudeCodeAccount => ({
  config_dir: configDir, config_directory: configDir, logged_in: loggedIn, auth_method: "claude.ai", subscription_type: "pro", email, error: null, login_command: "",
});
const statusOf = (...accounts: ClaudeCodeAccount[]): ClaudeCodeStatus => ({
  path: "/u/claude", source: "path", version: "2.1.300", sdk_version: "2.1.289", outdated: false, logged_in: accounts[0]?.logged_in ?? true,
  auth_method: "claude.ai", subscription_type: "pro", email: accounts[0]?.email ?? null, base_url_set: false, proxy: null, proxy_source: null,
  checked_at: "2026-11-12T00:00:00.000Z", error: null, accounts,
});
const out = (dir: string, email: string | null, until: number, known = true): AccountOut => ({ runner: "claude_code", dir, email, until, known });

test("one seat per account: a listed directory the daemon's own environment reads, or the same email signed in twice, is one", () => {
  const own = require("node:os").homedir() + "/.claude";
  const status = statusOf(account(null, "Pro@a.c"), account(own, "pro@a.c"), account("/opt/b", "PRO@a.c"), account("/opt/c", "team@a.c"));
  expect(claudeSeats(status, [own, "/opt/b", "/opt/c"], env).map((seat) => seat.configDir)).toEqual([null, "/opt/c"]);
});

test("the account named while it is not out; else the first other one signed in and not out; else none", () => {
  const status = statusOf(account(null, "pro@a.c"), account("/opt/b", "b@a.c", false), account("/opt/c", "c@a.c"), account("/opt/d", "d@a.c"));
  const listed = ["/opt/b", "/opt/c", "/opt/d"];
  const later = Date.now() + 3_600_000;
  expect(pickClaudeAccount({ status, listed, preferred: null, outs: [], env })).toEqual({ configDir: null, switched: false });
  // Out by email, whichever directory the note was taken on: /opt/b is signed out, so /opt/c.
  expect(pickClaudeAccount({ status, listed, preferred: null, outs: [out("/elsewhere", "pro@a.c", later)], env })).toEqual({ configDir: "/opt/c", switched: true });
  // Tried in this turn counts as out too.
  expect(pickClaudeAccount({ status, listed, preferred: null, outs: [out("/opt/c", "c@a.c", later)], tried: [require("node:os").homedir() + "/.claude"], env }))
    .toEqual({ configDir: "/opt/d", switched: true });
  expect(pickClaudeAccount({ status, listed, preferred: "/opt/c", outs: [out("/opt/c", null, later), out("/opt/d", null, later), out("/x", "pro@a.c", later)], env })).toBeNull();
});

test("an account billed per token is never moved to: a plan's limit is not turned into a bill", () => {
  const status = statusOf(account(null, "pro@a.c"), { ...account("/opt/key", "key@a.c"), auth_method: "api_key" },
    { ...account("/opt/cloud", null), auth_method: "third_party" }, { ...account("/opt/token", "token@a.c"), auth_method: "oauth_token" });
  const listed = ["/opt/key", "/opt/cloud", "/opt/token"];
  const later = Date.now() + 3_600_000;
  expect(pickClaudeAccount({ status, listed, preferred: null, outs: [out("/x", "pro@a.c", later)], env })).toEqual({ configDir: "/opt/token", switched: true });
  expect(pickClaudeAccount({ status, listed, preferred: null, outs: [out("/x", "pro@a.c", later), out("/opt/token", null, later)], env })).toBeNull();
  // Named by the Bot itself, it is still used: that was your choice.
  expect(pickClaudeAccount({ status, listed, preferred: "/opt/key", outs: [], env })).toEqual({ configDir: "/opt/key", switched: false });
});

test("the soonest reset of a signed-in account that said one; a guess or a signed-out account never counts", () => {
  const status = statusOf(account(null, "pro@a.c"), account("/opt/b", "b@a.c", false), account("/opt/c", "c@a.c"));
  const listed = ["/opt/b", "/opt/c"];
  const now = Date.now();
  expect(soonestBack(status, listed, [out("/x", "pro@a.c", now + 5_000), out("/opt/c", "c@a.c", now + 9_000)], env)).toBe(now + 5_000);
  expect(soonestBack(status, listed, [out("/x", "pro@a.c", now + 5_000, false), out("/opt/c", "c@a.c", now + 9_000), out("/opt/b", null, now + 1_000)], env)).toBe(now + 9_000);
  expect(soonestBack(status, listed, [out("/x", "pro@a.c", now + 5_000, false)], env)).toBeNull();
});
