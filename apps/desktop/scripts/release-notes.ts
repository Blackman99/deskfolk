/**
 * The body of a GitHub release: this version's CHANGELOG section, followed by the note about the
 * build being unsigned.
 *
 * It used to be the note alone, pointing at CHANGELOG.md and ROADMAP.md. The app now renders the
 * release body in the About card when it finds an update, so the body has to carry what actually
 * changed — a pointer is no use to someone reading it inside the app.
 *
 * `release.yml` runs this before `tauri-action` and hands the output to `releaseBody`.
 */
import { readFileSync } from "node:fs";
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

export function releaseBody(changelog: string, version: string): string {
  const section = changelogSection(changelog, version);
  return section ? `${section}\n\n${UNSIGNED_NOTE}\n` : "";
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

if (import.meta.main) {
  const root = repoRoot();
  const version = configuredVersion(root);
  const body = releaseBody(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  if (!body) {
    // Releasing without rolling the changelog would ship an empty update card, so stop here
    // rather than publish one.
    console.error(`CHANGELOG.md has no "## ${version}" section — roll it before tagging.`);
    process.exit(1);
  }
  process.stdout.write(body);
}
