import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

type App = Awaited<ReturnType<typeof openStory>>;

async function opened(part: string) {
  const app = await openStory("settings-agents", { height: 1000 });
  await app.waitFor("id:settings-agents", { timeout: 15_000 });
  await app.press(`id:story-show-${part}`);
  return app;
}

const log = (app: App) => app.texts().find((text) => text.startsWith("log:")) ?? "";

test("a found agent says where it is, which version, how it is signed in, how it reaches the network and which models it lists", async () => {
  const app = await opened("codex");
  await app.waitFor("id:agent-card-codex");
  expect(app.shows("id:agent-label")).toBe(true);
  expect(app.texts()).toContain("/usr/local/bin/codex");
  expect(app.shows("text:· PATH")).toBe(true);
  expect(app.shows("text:0.130.0")).toBe(true);
  expect(app.shows("text:已登录 · ChatGPT Plus")).toBe(true);
  expect(app.shows("text:直连")).toBe(true);
  expect(app.shows("text:1 个，默认 gpt-5.6")).toBe(true);
  expect(app.shows("id:agent-missing")).toBe(false);
  // Its listed account is a block with its directory and what the agent says of its sign-in.
  expect(app.shows("id:agent-account-/Users/you/.codex-b")).toBe(true);
  expect(app.shows("text:没登录，在终端运行")).toBe(true);
  expect(app.shows("text:CODEX_HOME=/Users/you/.codex-b codex login")).toBe(true);
  app.dispose();
});

test("an agent that was not found says which command, once, and the path field to point at it", async () => {
  const app = await opened("grok");
  await app.waitFor("id:agent-missing");
  expect(app.shows("text:没找到 grok。装好后点「重新检测」，或在下面填它的完整路径。")).toBe(true);
  expect(app.shows("id:agent-path-input")).toBe(true);
  expect(app.shows("id:agent-path-open")).toBe(false);
  expect(app.shows("id:agent-account-open")).toBe(false);
  expect(app.shows("id:agent-recheck")).toBe(true);
  app.dispose();
});

test("a check reads the agent again and the card tells its host the daemon's answer", async () => {
  const app = await opened("codex");
  await app.waitFor("id:agent-card-codex");
  expect(app.shows("text:codex:true:2")).toBe(true);
  await app.press("id:agent-recheck");
  await app.waitUntil(() => log(app).includes("detectAgent:codex"));
  // A path set behind its link is sent, and the daemon's answer says where it came from.
  await app.press("id:agent-path-open");
  await app.waitFor("id:agent-path-input");
  await app.type("id:agent-path-input", "/opt/codex");
  await app.press("id:agent-path-save");
  await app.waitUntil(() => log(app).includes("setAgentPath:codex:/opt/codex"));
  await app.waitUntil(() => app.texts().includes("/opt/codex"));
  expect(app.shows("text:· 你填的路径")).toBe(true);
  app.dispose();
});

test("Claude Code's card: where it is, the account it signs in with, usage under it, and other accounts added or refused", async () => {
  const app = await opened("claude");
  await app.waitFor("id:claude-agent");
  await app.waitFor("id:claude-accounts");
  expect(app.texts()).toContain("/Users/you/.local/bin/claude");
  expect(app.shows("text:2.1.289")).toBe(true);
  expect(app.shows("id:claude-network")).toBe(true);
  expect(app.shows("text:Claude Pro 订阅")).toBe(true);
  expect(app.texts()).toContain("/Users/you/.claude");
  expect(app.shows("id:claude-card-usage")).toBe(true);
  expect(app.shows("id:claude-missing")).toBe(false);
  expect(app.shows("text:claude:true")).toBe(true);
  // The path field and the account field wait behind links.
  expect(app.shows("id:claude-path-input")).toBe(false);
  expect(app.shows("id:claude-account-input")).toBe(false);
  await app.press("id:claude-account-open");
  await app.waitFor("id:claude-account-input");
  await app.type("id:claude-account-input", "relative");
  await app.press("id:claude-account-add");
  await app.waitFor("id:claude-account-error");
  await app.clear("id:claude-account-input");
  await app.type("id:claude-account-input", "/Users/you/.claude-b");
  await app.press("id:claude-account-add");
  await app.waitFor("id:claude-account-/Users/you/.claude-b");
  expect(app.shows("id:claude-account-error")).toBe(false);
  expect(app.shows("id:claude-account-input")).toBe(false);
  await app.press("id:claude-account-remove-/Users/you/.claude-b");
  await app.waitFor("id:claude-account-/Users/you/.claude-b", { state: "gone" });
  await app.press("id:claude-path-open");
  await app.waitFor("id:claude-path-input");
  await app.press("id:claude-recheck");
  await app.waitUntil(() => log(app).includes("detectClaudeCode"));
  app.dispose();
});

test("your own ACP agents' card, on its own: a heading, the list with each command, and the add form", async () => {
  const app = await opened("custom");
  await app.waitFor("id:custom-agents");
  expect(app.shows("text:你自己的 ACP Agent")).toBe(true);
  expect(app.shows("id:custom-agent-ca-1")).toBe(true);
  expect(app.texts()).toContain("/bin/my-agent acp --stdio");
  expect(app.shows("id:custom-add")).toBe(true);
  // A name that is blank cannot be saved.
  await app.press("id:custom-rename-ca-1");
  await app.waitFor("id:custom-rename-input");
  await app.clear("id:custom-rename-input");
  expect(app.enabled("id:custom-rename-save")).toBe(false);
  await app.press("id:custom-rename-cancel");
  await app.waitFor("id:custom-rename-input", { state: "gone" });
  expect(app.shows("text:my-agent")).toBe(true);
  await app.type("id:custom-name-input", "second");
  await app.type("id:custom-command-input", "/bin/second");
  await app.press("id:custom-add-submit");
  await app.waitFor("text:customs:my-agent,second");
  expect(log(app)).toContain("setCustomAgents:my-agent,second");
  app.dispose();
});
