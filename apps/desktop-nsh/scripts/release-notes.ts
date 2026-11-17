/**
 * The body of a GitHub release: this version's CHANGELOG section in every language the repo
 * keeps, followed by a note on how the builds are signed.
 *
 * It used to be the note alone, pointing at CHANGELOG.md and ROADMAP.md. The app now renders the
 * release body in the About card when it finds an update, so the body has to carry what actually
 * changed — a pointer is no use to someone reading it inside the app.
 *
 * A release has one body and the app has two locales, so the body carries both and the card
 * picks. The languages are marked off with HTML comments: invisible wherever the body is
 * rendered as Markdown, so the release page just shows the sections stacked.
 *
 * `release.yml` runs this in its publish job and creates the release with the output as its body.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Said only when release.yml really notarizes: it sets `MACOS_NOTARIZED=true` when the repository
 * has the Developer ID certificate and all three notary secrets, and a notarization that fails
 * fails the packaging job, so no un-notarized `.dmg` ships under this note.
 *
 * Since 0.5.0 the app is the native one (ADR 0107): on the Mac on NSH's own floor of macOS 14, and
 * on Windows from an installer that is still unsigned, and on Linux (x86_64) as a deb and an
 * AppImage. The note says what ships where, because someone on another platform (Linux on ARM,
 * say) finds no package and should know why.
 */
const NOTARIZED_NOTE = `---

The macOS \`.dmg\` builds are signed with Developer ID and notarized by Apple: they open with a double-click. The app is the native one (no web view); on the Mac it needs macOS 14 or later.

The Windows installer is not signed yet: SmartScreen warns about an unknown publisher (More info → Run anyway). It installs over an earlier Deskfolk, conversations and settings included.

Linux (x86_64) gets a \`.deb\` and an \`.AppImage\`. There is no package for other platforms. See CHANGELOG.md and ROADMAP.md.`;

const UNSIGNED_NOTE = `---

Unsigned macOS snapshot. This is not a supported signed installer.

These builds are signed ad hoc (\`package.ts --sign adhoc\`, no Developer ID), so Gatekeeper may block them. Prefer running from source:

\`\`\`
pnpm install
pnpm --filter @real-bot/desktop-nsh dev
\`\`\`

The Windows installer is not signed either. Linux (x86_64) gets a \`.deb\` and an \`.AppImage\`. There is no package for other platforms. See CHANGELOG.md and ROADMAP.md.`;

/**
 * The lines under `## <version>`, up to the next `## `. The heading itself stays out: the release
 * page already carries the version in its title.
 */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && line.slice(3).trim().split(/\s+/)[0] === version,
  );
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return section;
}

/**
 * A code span, a fenced block, or an `@name` GitHub would link. Code comes first so an `@` inside
 * one is matched as part of the code and left alone; a word character or `/` before the `@` (an
 * address, a URL path) keeps it from being a mention, and so does a non-alphanumeric after it
 * (`@-mentions`, a lone `@`). The name runs on through `.`, `-` and `/` so `@37.79s` or
 * `@scope/pkg` is wrapped whole, but not onto a sentence's closing punctuation.
 */
const CODE_OR_MENTION =
  /^[ \t]*```[\s\S]*?^[ \t]*```|(`+).*?\1|(?<![\w`/])@[A-Za-z0-9](?:[\w./-]*\w)?/gm;

/**
 * Changelog prose that quotes a chat line — `"the API is ready, @frontend"` — reads to GitHub as
 * a mention: the account by that name is notified and listed as the release's contributor. Inside
 * a code span it is just text, on the release page and in the About card alike.
 */
export function escapeMentions(markdown: string): string {
  return markdown.replace(CODE_OR_MENTION, (match) => (match.startsWith("@") ? `\`${match}\`` : match));
}

/** Locale tag for a body section. `common` is the part every locale gets. */
export function langMarker(lang: string): string {
  return `<!-- lang:${lang} -->`;
}

/**
 * The English section is what decides whether there is a release at all — a version missing from
 * CHANGELOG.md is a changelog nobody rolled. A missing translation just means that locale falls
 * back to English in the card, which is better than blocking the release over it.
 */
export function releaseBody(
  changelogEn: string,
  changelogZh: string | null,
  version: string,
  notarized = false,
): string {
  const en = escapeMentions(changelogSection(changelogEn, version));
  if (!en) return "";
  const zh = changelogZh ? escapeMentions(changelogSection(changelogZh, version)) : "";
  const sections: Section[] = [{ lang: "en", text: en, dropped: 0 }];
  if (zh) sections.push({ lang: "zh", text: zh, dropped: 0 });
  const note = notarized ? NOTARIZED_NOTE : UNSIGNED_NOTE;
  let body = assemble(sections, note);
  // A long cycle can outgrow what GitHub accepts. Give up the oldest entries — the bottom of a
  // section — of whichever language is longest, and say how many are only in the changelog.
  while (body.length > RELEASE_BODY_LIMIT) {
    const longest = sections.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const cut = longest.text.lastIndexOf("\n- ");
    if (cut <= 0) break;
    longest.text = longest.text.slice(0, cut).trimEnd();
    longest.dropped += 1;
    body = assemble(sections, note);
  }
  return body;
}

/** GitHub refuses a release whose body is longer than this. */
export const RELEASE_BODY_LIMIT = 125_000;

type Section = { lang: "en" | "zh"; text: string; dropped: number };

const MORE: Record<Section["lang"], (count: number) => string> = {
  en: (count) => `- …and ${count} more, in CHANGELOG.md.`,
  zh: (count) => `- ……另有 ${count} 条，见 CHANGELOG.zh.md。`,
};

function assemble(sections: Section[], note: string): string {
  const parts = sections.map(({ lang, text, dropped }) =>
    `${langMarker(lang)}\n\n${text}${dropped ? `\n\n${MORE[lang](dropped)}` : ""}`,
  );
  parts.push(`${langMarker("common")}\n\n${note}`);
  return `${parts.join("\n\n")}\n`;
}

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** The release's version, from the app's own `package.json` (the one place it is kept). */
export function configuredVersion(root: string = repoRoot()): string {
  const config = JSON.parse(
    readFileSync(join(root, "apps/desktop-nsh/package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof config.version !== "string" || config.version.length === 0) {
    throw new Error("apps/desktop-nsh/package.json has no version");
  }
  return config.version;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

if (import.meta.main) {
  const root = repoRoot();
  const version = configuredVersion(root);
  const body = releaseBody(
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    readIfPresent(join(root, "CHANGELOG.zh.md")),
    version,
    process.env.MACOS_NOTARIZED === "true",
  );
  if (!body) {
    // Releasing without rolling the changelog would ship an empty update card, so stop here
    // rather than publish one.
    console.error(`CHANGELOG.md has no "## ${version}" section — roll it before tagging.`);
    process.exit(1);
  }
  process.stdout.write(body);
}
