/**
 * What the About card draws from a release body.
 *
 * The body is this version's CHANGELOG section, written for a release page: `###` headings,
 * long bullets, the odd fenced command. The card is a box a few lines tall inside a settings
 * modal, so it takes the headings and the bullets and leaves the prose and the fences where
 * they are. Markdown is not rendered here on purpose — the chat renderer turns anything that
 * looks like a workspace path into an artifact link, and a changelog is full of those.
 */

export type ReleaseNoteGroup = {
  /** The `###` line the bullets sit under, or null for bullets that arrive before one. */
  heading: string | null;
  items: string[];
};

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;

/** `**bold**`, `` `code` `` and `[text](url)` read as noise in a plain list, so they come off. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function releaseNoteGroups(body: string | null | undefined): ReleaseNoteGroup[] {
  if (!body) return [];
  const groups: ReleaseNoteGroup[] = [];
  let fenced = false;

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = HEADING.exec(line.trim());
    if (heading) {
      groups.push({ heading: plainText(heading[1]!) || null, items: [] });
      continue;
    }

    const bullet = BULLET.exec(line.trim());
    if (bullet) {
      const item = plainText(bullet[1]!);
      if (!item) continue;
      if (groups.length === 0) groups.push({ heading: null, items: [] });
      groups[groups.length - 1]!.items.push(item);
      continue;
    }

    // A wrapped bullet: indented, with a bullet already open above it.
    const open = groups[groups.length - 1];
    if (open && open.items.length > 0 && /^\s+\S/.test(line)) {
      const tail = plainText(line);
      if (tail) open.items[open.items.length - 1] += ` ${tail}`;
    }
  }

  return groups.filter((group) => group.items.length > 0);
}
