import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changelogSection, configuredVersion, releaseBody, repoRoot } from "./release-notes.ts";

const CHANGELOG = `# Changelog

## Unreleased

（尚无）

## 0.2.0 — 2026-10-01

未签名的 macOS rc。

### Messenger

- 新的一条。

## 0.1.0-rc.2 — 2026-09-19

### Daemon

- 旧的一条。
`;

test("the section is the lines under its heading, without the heading", () => {
  expect(changelogSection(CHANGELOG, "0.2.0")).toBe(
    "未签名的 macOS rc。\n\n### Messenger\n\n- 新的一条。",
  );
});

test("a prerelease version matches its own section, not the one after it", () => {
  expect(changelogSection(CHANGELOG, "0.1.0-rc.2")).toBe("### Daemon\n\n- 旧的一条。");
});

test("a version with no section comes back empty, and so does the body", () => {
  expect(changelogSection(CHANGELOG, "9.9.9")).toBe("");
  expect(releaseBody(CHANGELOG, "9.9.9")).toBe("");
});

test("the body carries the section first and the unsigned note after it", () => {
  const body = releaseBody(CHANGELOG, "0.2.0");
  expect(body.startsWith("未签名的 macOS rc。")).toBe(true);
  expect(body).toContain("- 新的一条。");
  expect(body).toContain("Unsigned macOS snapshot");
  expect(body.indexOf("- 新的一条。")).toBeLessThan(body.indexOf("Unsigned macOS snapshot"));
});

/**
 * The release would go out with an empty card if these two ever drifted, and the workflow only
 * finds out at tag time — so the repo's own changelog and version are checked here.
 */
test("this repo's changelog has a section for the version being shipped", () => {
  const root = repoRoot();
  const version = configuredVersion(root);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  expect(changelogSection(changelog, version)).not.toBe("");
});
