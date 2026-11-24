import { expect, test } from "bun:test";
import { isAgentCredentialPath, isAgentSecretPath, namesAgentSecret, touchesAgentCredentials } from "./credentials";

const home = "/Users/me";
const dirs = ["/Users/me/.grok-work", "/Users/me/.codex-b"];

test("a configured account dir is a credential dir, its bundled skills are readable", () => {
  expect(isAgentCredentialPath("/Users/me/.grok-work/auth.json", home, "darwin", dirs)).toBe(true);
  expect(isAgentCredentialPath("/Users/me/.grok-work", home, "darwin", dirs)).toBe(true);
  expect(isAgentCredentialPath("/Users/me/.grok-work/bundled/skills/x/SKILL.md", home, "darwin", dirs)).toBe(false);
  expect(isAgentCredentialPath("/Users/me/.grok-work/bundledx/a", home, "darwin", dirs)).toBe(true);
  expect(isAgentCredentialPath("/Users/me/.grok/bundled/skills/x", home, "darwin", [])).toBe(false);
  expect(isAgentCredentialPath("/Users/me/.grok/auth.json", home, "darwin", [])).toBe(true);
});

test("a command naming an account dir is refused, naming its bundled skills is not", () => {
  expect(touchesAgentCredentials("cat ~/.grok-work/auth.json", home, "darwin", dirs)).toBe(true);
  expect(touchesAgentCredentials("ls /Users/me/.grok-work", home, "darwin", dirs)).toBe(true);
  expect(touchesAgentCredentials("cat ~/.grok-work/bundled/skills/x/SKILL.md", home, "darwin", dirs)).toBe(false);
  expect(touchesAgentCredentials("cat $HOME/.grok-work/bundled/skills/x ~/.grok-work/auth.json", home, "darwin", dirs)).toBe(true);
  expect(touchesAgentCredentials("cat ~/.grok/bundled/skills/x", home, "darwin", dirs)).toBe(false);
});

const own = ["/Users/me/.gemini"];

test("file by file, a sign-in or settings file is a secret in another agent's folder, and nothing is in the agent's own", () => {
  const secret = (path: string, ownDirs = own) => isAgentSecretPath(path, home, "darwin", dirs, ownDirs);
  for (const path of ["/Users/me/.codex/auth.json", "/Users/me/.codex-b/auth.json", "/Users/me/.claude/.credentials.json", "/Users/me/.grok/.env",
    "/Users/me/.codex/x/TOKENS.json", "/Users/me/.local/share/opencode/mcp-auth.json", "/Users/me/Library/Keychains/login.keychain-db"]) {
    expect([path, secret(path)]).toEqual([path, true]);
  }
  for (const path of ["/Users/me/.claude/settings.json", "/Users/me/.claude.json", "/Users/me/.claude.json.backup", "/Users/me/.codex/config.toml", "/Users/me/.grok-work/user-settings.json", "/Users/me/.claude/.mcp.json"]) {
    expect([path, secret(path)]).toEqual([path, true]);
  }
  // Its own folder is its own, what signs it in too; nothing else in any agent's folder is a secret, nor any file elsewhere whatever its name.
  for (const path of ["/Users/me/.gemini/settings.json", "/Users/me/.gemini/antigravity-cli/settings.json", "/Users/me/.gemini/config/mcp_config.json", "/Users/me/.gemini/google_accounts.json",
    "/Users/me/.gemini/oauth_creds.json", "/Users/me/.gemini/.env", "/Users/me/.gemini/antigravity-cli/x/tokens.json",
    "/Users/me/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md", "/Users/me/.gemini", "/Users/me/.claude", "/Users/me/.claude/CLAUDE.md", "/Users/me/.claude/skills/auth/SKILL.md",
    "/Users/me/.codex/sessions/2026/rollout.jsonl", "/Users/me/.codex/token-usage.md", "/Users/me/proj/.env", "/Users/me/proj/settings.json", "/Users/me/.claude-old/settings.json", "relative/auth.json"]) {
    expect([path, secret(path)]).toEqual([path, false]);
  }
  // The skills Grok ships with, in its own home or an account's, hold no secret whatever a file there is called.
  expect(secret("/Users/me/.grok/bundled/skills/x/config.json")).toBe(false);
  expect(secret("/Users/me/.grok-work/bundled/skills/x/settings.json")).toBe(false);
  // Whose folder it is decides: Codex's own are its config and its sign-in, not Gemini's settings.
  expect(secret("/Users/me/.codex/config.toml", ["/Users/me/.codex"])).toBe(false);
  expect(secret("/Users/me/.codex/auth.json", ["/Users/me/.codex"])).toBe(false);
  expect(secret("/Users/me/.gemini/settings.json", ["/Users/me/.codex"])).toBe(true);
});

test("on Windows the same files, by either slash and any case; a command there is read whole", () => {
  const winHome = "C:\\Users\\me";
  const winOwn = ["C:\\Users\\me\\.gemini"];
  const folders = { open: () => false, read: () => false, real: () => null };
  expect(isAgentSecretPath("C:\\Users\\me\\.codex\\auth.json", winHome, "win32", [], winOwn)).toBe(true);
  expect(isAgentSecretPath("C:/Users/Me/.Claude/Settings.json", winHome, "win32", [], winOwn)).toBe(true);
  expect(isAgentSecretPath("C:\\Users\\me\\.gemini\\antigravity-cli\\settings.json", winHome, "win32", [], winOwn)).toBe(false);
  expect(isAgentSecretPath("C:\\Users\\me\\.gemini\\antigravity-cli\\builtin\\skills\\x\\SKILL.md", winHome, "win32", [], winOwn)).toBe(false);
  expect(isAgentSecretPath("C:\\Users\\me\\.gemini\\..\\.codex\\auth.json", winHome, "win32", [], winOwn)).toBe(true);
  const names = (command: string) => namesAgentSecret(command, winHome, "win32", [], winOwn, folders);
  expect(names("type %USERPROFILE%\\.codex\\auth.json")).toBe(true);
  expect(names("Get-Content $env:USERPROFILE\\.claude\\settings.json")).toBe(true);
  expect(names("dir C:\\Users\\me\\.gemini\\antigravity-cli\\builtin")).toBe(false);
  expect(names("type C:\\Users\\me\\.gemini\\antigravity-cli\\settings.json")).toBe(false);
  expect(names("dir %USERPROFILE%\\.claude\\skills")).toBe(false);
  expect(names("type %USERPROFILE%\\.gemini\\oauth_creds.json & dir %USERPROFILE%\\.gemini & type auth.json")).toBe(false);
  // Its shells' quoting is not read, so such a file's name beside another agent's folder counts.
  expect(names("dir %USERPROFILE%\\.claude\\skills & type auth.json")).toBe(true);
  expect(names("dir C:\\work & type auth.json")).toBe(false);
});

test("a command names a secret where its path into an agent's folder is one, or where it builds on the folder and writes the name", () => {
  const folders = { open: (abs: string) => abs.startsWith("/Users/me/.gemini/antigravity-cli/brain/s1"), read: (abs: string) => abs.startsWith("/Users/me/.claude/projects"), real: () => null };
  const names = (command: string) => namesAgentSecret(command, home, "darwin", dirs, own, folders);
  expect(names("npm test && cat .env settings.json auth.json")).toBe(false);
  expect(names("cat ~/.codex/auth.json,")).toBe(true);
  expect(names("cat ~/.codex/AGENTS.md ~/.grok-work/skills/x.md")).toBe(false);
  expect(names("cat $HOME/.grok-work/auth.json")).toBe(true);
  // Built on its own folder, nothing counts. On another's, a sign-in or settings file's name does.
  expect(names("cd ~/.gemini/antigravity-cli && cat settings.json config.toml oauth_creds.json")).toBe(false);
  expect(names("cd ~/.gemini/antigravity-cli/brain/s1 && cat ../../auth.json")).toBe(false);
  expect(names("cd ~/.codex && cat AGENTS.md")).toBe(false);
  expect(names("cd ~/.codex && cat config.toml")).toBe(true);
  // A path that climbs out of its own folder as written is judged where it lands.
  expect(names("cat ~/.gemini/../.codex/auth.json")).toBe(true);
  expect(names("cat ~/.codex/../.gemini/oauth_creds.json")).toBe(false);
  // The records it reads: no file there is a secret, a path built on them is built on another's folder.
  expect(names("cat ~/.claude/projects/-p/tokens.json")).toBe(false);
  expect(names("cd ~/.claude/projects && cat ../settings.json")).toBe(true);
  // A name written beside a built path is read off the list every such command goes by: a project has a `hooks.json` and an `.mcp.json` too.
  expect(names("cd ~/.claude/projects && cat /work/proj/hooks.json /work/proj/.mcp.json")).toBe(false);
  expect(names("cat ~/.claude/.mcp.json")).toBe(true);
});
