import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changelogSection,
  configuredVersion,
  langMarker,
  RELEASE_BODY_LIMIT,
  releaseBody,
  repoRoot,
} from "./release-notes.ts";

const ENGLISH = `# Changelog

## 0.2.0 — 2026-10-01

Unsigned macOS rc.

### Messenger

- a new one.
`;

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
  expect(releaseBody(CHANGELOG, null, "9.9.9")).toBe("");
});

const CHANGELOG_ZH = `# 更新日志

## 0.2.0 — 2026-10-01

未签名的 macOS rc。

### Messenger

- 新的一条。
`;

test("the body carries the section first and the unsigned note after it", () => {
  const body = releaseBody(CHANGELOG, null, "0.2.0");
  expect(body.startsWith(langMarker("en"))).toBe(true);
  expect(body).toContain("- 新的一条。");
  expect(body).toContain("Unsigned macOS snapshot");
  expect(body.indexOf("- 新的一条。")).toBeLessThan(body.indexOf("Unsigned macOS snapshot"));
});

/** One release, one body, two locales: the card picks, so the body has to carry both. */
test("the body carries each language behind its own marker", () => {
  const body = releaseBody(ENGLISH, CHANGELOG_ZH, "0.2.0");
  expect(body).toContain(`${langMarker("en")}\n\nUnsigned macOS rc.`);
  expect(body).toContain("- a new one.");
  expect(body).toContain(`${langMarker("zh")}\n\n未签名的 macOS rc。`);
  expect(body).toContain("- 新的一条。");
  expect(body.indexOf(langMarker("en"))).toBeLessThan(body.indexOf(langMarker("zh")));
  expect(body.indexOf(langMarker("zh"))).toBeLessThan(body.indexOf(langMarker("common")));
  expect(body).toContain("Unsigned macOS snapshot");
});

/** A missing translation is not worth blocking a release over; that locale falls back in the card. */
test("a changelog with no translation still ships, with only the english marker", () => {
  const body = releaseBody(ENGLISH, CHANGELOG_ZH, "0.9.9");
  expect(body).toBe("");

  const partial = releaseBody(ENGLISH, "# 更新日志\n", "0.2.0");
  expect(partial).toContain(langMarker("en"));
  expect(partial).not.toContain(langMarker("zh"));
  expect(partial).toContain(langMarker("common"));
});

/** The English section decides whether there is a release at all. */
test("a version missing from the english changelog comes back empty even when translated", () => {
  expect(releaseBody("# Changelog\n", CHANGELOG_ZH, "0.2.0")).toBe("");
});

/** GitHub turns a longer body away, so a long cycle gives up its oldest entries instead. */
test("a body over GitHub's limit drops the oldest entries of the longer language and counts them", () => {
  const entry = (n: number) => `- entry ${n} ${"x".repeat(990)}`;
  const long = `# Changelog\n\n## 0.2.0 — 2026-10-01\n\nUnsigned macOS rc.\n\n${Array.from({ length: 140 }, (_, i) => entry(i)).join("\n\n")}\n`;
  const body = releaseBody(long, CHANGELOG_ZH, "0.2.0");
  expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
  expect(body).toContain("- entry 0 ");
  expect(body).not.toContain("- entry 139 ");
  const kept = body.match(/- entry \d+ /g)!.length;
  expect(body).toContain(`- …and ${140 - kept} more, in CHANGELOG.md.`);
  expect(body).toContain("- 新的一条。");
  expect(body).not.toContain("另有");
  expect(body).toContain("Unsigned macOS snapshot");
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
  const body = releaseBody(changelog, readFileSync(join(root, "CHANGELOG.zh.md"), "utf8"), version);
  expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
});
