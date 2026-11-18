import { expect, test } from "bun:test";
import { isAgentCredentialPath, touchesAgentCredentials } from "./credentials";

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
