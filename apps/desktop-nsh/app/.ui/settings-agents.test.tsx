import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

async function opened(part: string, options: { width?: number; height?: number } = {}) {
  const app = await openStory("settings-agents", { height: 900, ...options });
  await app.waitFor("id:settings-agents", { timeout: 15_000 });
  if (part !== "live") await app.press(`id:story-show-${part}`);
  await app.waitFor("id:agents-tab");
  return app;
}

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";
const summary = (app: App, key: string) => app.shows(`id:agent-row-summary-${key}`);

test("on the runtime's own client the tab asks once and lists Claude Code, what it found, and your own ACP agents as one line", async () => {
  const app = await opened("live");
  await app.waitFor("id:agent-row-custom-agents", { timeout: 15_000 });
  expect(app.shows("text:Bot 可以交给这台电脑上装好并登录的 Agent 来跑。点开一个看详情、换路径或加账号。")).toBe(true);
  expect(app.shows("text:全部重新检测")).toBe(true);
  expect(app.shows("text:添加任何讲 ACP 的命令")).toBe(true);
  // Claude Code's line is there whether it was found or not (found, it is open to details; missing, folded away).
  await app.waitUntil(() => app.shows("id:agent-row-head-claude_code") || app.shows("id:agents-missing-toggle"));
  // No Bot runs on your own agents' line.
  expect(app.shows("id:agent-row-bots-custom-agents")).toBe(false);
  await app.press("id:agent-row-head-custom-agents");
  await app.waitFor("id:custom-agents");
  expect(app.shows("id:custom-add")).toBe(true);
  await app.press("id:agent-row-head-custom-agents");
  await app.waitFor("id:custom-agents", { state: "gone" });
  app.dispose();
});

test("one line per agent, ready ones first, how it is signed in and what it runs; those not installed folded at the foot", async () => {
  const app = await opened("stub");
  await app.waitFor("id:agent-row-codex");
  // Signed in with many providers: the first and how many, so the models still fit.
  expect(app.shows("text:OpenCode Go 等 4 家 · 2 个模型")).toBe(true);
  expect(app.shows("text:ChatGPT Plus · 1 个模型")).toBe(true);
  // One whose sign-in is only known on its first turn says so.
  expect(app.shows("text:登录在首轮时检查")).toBe(true);
  expect(app.shows("text:没登录 · 运行 grok login")).toBe(true);
  expect(app.shows("text:Claude Pro 订阅 · 2.1.289")).toBe(true);
  // Two Bots run on Codex; an archived one does not count.
  expect(app.shows("text:2 个 Bot")).toBe(true);
  expect(app.count("id:agent-row-bots-codex")).toBe(1);
  expect(app.shows("text:要登录")).toBe(true);
  // No card is open, and ZCode waits folded.
  expect(app.shows("id:agent-card-codex")).toBe(false);
  expect(app.shows("id:claude-agent")).toBe(false);
  expect(app.shows("id:agent-row-zcode")).toBe(false);
  await app.press("id:agents-missing-toggle");
  await app.waitFor("id:agent-row-zcode");
  expect(app.shows("text:没找到 zcode-acp")).toBe(true);
  expect(summary(app, "custom:ca-1")).toBe(true);
  expect(log(app).split(" ").filter((word) => word === "agents")).toHaveLength(1);
  app.dispose();
});

test("a line opens its agent's details in place, one at a time; a check there is asked of the daemon", async () => {
  const app = await opened("stub");
  await app.waitFor("id:agent-row-codex");
  await app.press("id:agent-row-head-codex");
  await app.waitFor("id:agent-card-codex");
  // Its path field waits behind a link, and the card has no heading of its own.
  expect(app.shows("id:agent-path-input")).toBe(false);
  expect(app.shows("id:agent-label")).toBe(false);
  await app.press("id:agent-path-open");
  await app.waitFor("id:agent-path-input");
  await app.press("id:agent-recheck");
  await app.waitUntil(() => log(app).includes("detectAgent:codex"));
  // Opening Claude closes Codex.
  await app.press("id:agent-row-head-claude_code");
  await app.waitFor("id:claude-agent");
  expect(app.shows("id:agent-card-codex")).toBe(false);
  await app.press("id:agent-row-head-claude_code");
  await app.waitFor("id:claude-agent", { state: "gone" });
  app.dispose();
});

test("an agent with config directories lists its accounts: one a Bot runs on stays, a new one is added and removed", async () => {
  const app = await opened("stub");
  await app.waitFor("id:agent-row-codex");
  await app.press("id:agent-row-head-codex");
  await app.waitFor("id:agent-account-open");
  await app.press("id:agent-account-open");
  await app.waitFor("id:agent-account-input");
  expect(app.shows("id:agent-account-add")).toBe(true);
  expect(app.enabled("id:agent-account-add")).toBe(false);
  await app.type("id:agent-account-input", "/home");
  await app.press("id:agent-account-add");
  await app.waitFor("id:agent-account-error");
  expect(app.shows("text:还有 Bot 在用这个账号：先在它的面板里换一个账号，再移除。")).toBe(true);
  expect(app.shows("text:Bot Writer runs on it")).toBe(true);
  await app.clear("id:agent-account-input");
  await app.type("id:agent-account-input", "/Users/you/.codex-c");
  await app.press("id:agent-account-add");
  await app.waitFor("id:agent-account-/Users/you/.codex-c");
  expect(log(app)).toContain("setAgentAccounts:codex:/Users/you/.codex-c");
  expect(app.shows("id:agent-account-input")).toBe(false);
  await app.press("id:agent-account-remove-/Users/you/.codex-c");
  await app.waitFor("id:agent-account-/Users/you/.codex-c", { state: "gone" });
  app.dispose();
});

test("your own ACP agents open as one line: adding, renaming and removing one, and the one a Bot runs on stays", async () => {
  const app = await opened("stub");
  await app.waitFor("id:agent-row-custom-agents");
  expect(app.shows("text:1 个 · 添加、改名或移除")).toBe(true);
  await app.press("id:agent-row-head-custom-agents");
  await app.waitFor("id:custom-agents");
  expect(app.shows("id:custom-agent-ca-1")).toBe(true);
  // Added: the name and the command are needed, the arguments one per line.
  expect(app.enabled("id:custom-add-submit")).toBe(false);
  await app.type("id:custom-name-input", "busy");
  await app.type("id:custom-command-input", "/bin/busy");
  await app.type("id:custom-args-input", "acp");
  await app.press("id:custom-add-submit");
  await app.waitFor("id:custom-agent-ca-2");
  expect(app.shows("text:2 个 · 添加、改名或移除")).toBe(true);
  expect(app.texts()).toContain("/bin/busy acp");
  // The daemon refuses to drop it: its own words under ours.
  await app.press("id:custom-remove-ca-2");
  await app.waitFor("id:custom-error");
  expect(app.shows("text:还有 Bot 在用它：先在它的面板里换一个运行方式，再移除。")).toBe(true);
  expect(app.shows("text:Bot Writer runs on busy")).toBe(true);
  // Renamed.
  await app.press("id:custom-rename-ca-1");
  await app.waitFor("id:custom-rename-input");
  await app.clear("id:custom-rename-input");
  await app.type("id:custom-rename-input", "renamed");
  await app.press("id:custom-rename-save");
  await app.waitFor("id:custom-rename-input", { state: "gone" });
  expect(app.shows("text:renamed")).toBe(true);
  // Removed.
  await app.press("id:custom-remove-ca-1");
  await app.waitFor("id:custom-agent-ca-1", { state: "gone" });
  app.dispose();
});

test("check all asks Claude Code and every agent again", async () => {
  const app = await opened("stub");
  await app.waitFor("id:agent-row-codex");
  await app.press("id:agents-recheck-all");
  await app.waitUntil(() => log(app).includes("detectClaudeCode") && log(app).includes("agents:refresh"));
  app.dispose();
});

test("on a phone a line opens as a page of its own, named in the page head, and Back goes to the list", async () => {
  const app = await opened("stub", { width: 600 });
  await app.waitFor("id:agent-row-codex");
  await app.press("id:story-title");
  expect(app.shows("text:title:")).toBe(true);
  await app.press("id:story-back");
  expect(app.shows("text:back:false")).toBe(true);
  // The state is a dot, not a word, on a phone.
  expect(app.shows("text:要登录")).toBe(false);
  await app.press("id:agent-row-head-codex");
  await app.waitFor("id:agents-page-codex");
  expect(app.shows("id:agent-card-codex")).toBe(true);
  expect(app.shows("id:agents-recheck-all")).toBe(false);
  await app.press("id:story-title");
  expect(app.shows("text:title:Codex")).toBe(true);
  await app.press("id:story-back");
  expect(app.shows("text:back:true")).toBe(true);
  await app.waitFor("id:agents-page-codex", { state: "gone" });
  expect(app.shows("id:agent-row-head-codex")).toBe(true);
  app.dispose();
});

/** The stub in a mode (its reads fail, 404 or hold fresh answers back), before the tab is mounted on it. */
async function inMode(mode: string, width = 1100) {
  const app = await openStory("settings-agents", { height: 900, width });
  await app.waitFor("id:settings-agents", { timeout: 15_000 });
  await app.press(`id:story-mode-${mode}`);
  await app.press("id:story-show-stub");
  await app.waitFor("id:agents-tab");
  return app;
}

test("a daemon without the routes gets a note, Claude's line says it cannot be asked, and your own agents are not offered", async () => {
  const app = await inMode("404");
  await app.waitFor("id:agents-unreachable");
  expect(app.shows("text:没查到其他 Agent 的状态。电脑上的 Deskfolk 版本较旧时，先在电脑上更新，手机上才能看到和设置。")).toBe(true);
  await app.waitFor("text:电脑上的 Deskfolk 较旧，查不到");
  expect(app.shows("id:agent-row-head-codex")).toBe(false);
  expect(app.shows("id:agent-row-head-custom-agents")).toBe(false);
  app.dispose();
});

test("any other failure says so with a retry that asks again", async () => {
  const app = await inMode("fail");
  await app.waitFor("id:agents-failed");
  expect(app.shows("text:没查到，再试一次")).toBe(true);
  expect(app.shows("id:agent-row-head-codex")).toBe(false);
  await app.press("id:story-mode-ok");
  await app.press("id:agents-retry");
  await app.waitFor("id:agent-row-head-codex");
  expect(app.shows("id:agents-failed")).toBe(false);
  app.dispose();
});

test("lines shown as last seen catch up by themselves when the daemon's new looks come in", async () => {
  const app = await inMode("refreshing");
  await app.waitFor("id:agent-row-head-codex");
  // At once, as last seen; the check-all button says it is looking.
  await app.waitFor("text:没登录 · 运行 codex login");
  expect(app.shows("text:检测中…")).toBe(true);
  expect(log(app)).toContain("agents:wait");
  await app.press("id:story-release");
  await app.waitFor("text:ChatGPT Plus · 1 个模型");
  expect(app.shows("text:全部重新检测")).toBe(true);
  expect(app.shows("text:检测中…")).toBe(false);
  app.dispose();
});
