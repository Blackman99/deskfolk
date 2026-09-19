/**
 * The body of a GitHub release: this version's CHANGELOG section in every language the repo
 * keeps, followed by the note about the build being unsigned.
 *
 * It used to be the note alone, pointing at CHANGELOG.md and ROADMAP.md. The app now renders the
 * release body in the About card when it finds an update, so the body has to carry what actually
 * changed — a pointer is no use to someone reading it inside the app.
 *
 * A release has one body and the app has two locales, so the body carries both and the card
 * picks. The languages are marked off with HTML comments: invisible wherever the body is
 * rendered as Markdown, so the release page just shows the sections stacked.
 *
 * `release.yml` runs this before `tauri-action` and hands the output to `releaseBody`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UNSIGNED_NOTE = `---

Unsigned macOS snapshot. This is not a supported signed installer.

Gatekeeper may block ad-hoc signed builds (\`signingIdentity: "-"\`). Prefer running from source:

\`\`\`
pnpm install
pnpm dev
\`\`\`

Windows and Linux are out of scope. See CHANGELOG.md and ROADMAP.md.`;

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
): string {
  const en = changelogSection(changelogEn, version);
  if (!en) return "";
  const zh = changelogZh ? changelogSection(changelogZh, version) : "";
  const parts = [`${langMarker("en")}\n\n${en}`];
  if (zh) parts.push(`${langMarker("zh")}\n\n${zh}`);
  parts.push(`${langMarker("common")}\n\n${UNSIGNED_NOTE}`);
  return `${parts.join("\n\n")}\n`;
}

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function configuredVersion(root: string = repoRoot()): string {
  const config = JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof config.version !== "string" || config.version.length === 0) {
    throw new Error("tauri.conf.json has no version");
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
  );
  if (!body) {
    // Releasing without rolling the changelog would ship an empty update card, so stop here
    // rather than publish one.
    console.error(`CHANGELOG.md has no "## ${version}" section — roll it before tagging.`);
    process.exit(1);
  }
  process.stdout.write(body);
}
