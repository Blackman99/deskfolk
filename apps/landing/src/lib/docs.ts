export type TocEntry = { id: string; text: string; level: number };

export const MANIFESTO_TOPICS = [
  'people',
  'conversations',
  'collaboration',
  'workspace',
  'runtime',
  'models',
  'safety'
] as const;

export type ManifestoTopic = (typeof MANIFESTO_TOPICS)[number];

/** Guides published from docs/, each at `/<lang>/<key>`, in sidebar order. */
export const GUIDES = ['gatekeeper', 'windows', 'routines', 'spend', 'remote'] as const;
export type Guide = (typeof GUIDES)[number];

export const DOCS_PAGE_KEYS = ['docs', ...GUIDES, 'manifesto', ...MANIFESTO_TOPICS, 'roadmap'] as const;
export type DocsPageKey = (typeof DOCS_PAGE_KEYS)[number];

export type DocsNavGroupId = 'start' | 'guides' | 'glossary' | 'direction';

export const DOCS_NAV: { group: DocsNavGroupId; pages: DocsPageKey[] }[] = [
  { group: 'start', pages: ['docs', 'gatekeeper', 'windows'] },
  { group: 'guides', pages: ['routines', 'spend', 'remote'] },
  { group: 'glossary', pages: ['manifesto', ...MANIFESTO_TOPICS] },
  { group: 'direction', pages: ['roadmap'] }
];

export function isGuide(value: string): value is Guide {
  return (GUIDES as readonly string[]).includes(value);
}

export function docsGroup(key: DocsPageKey): DocsNavGroupId {
  return DOCS_NAV.find((g) => g.pages.includes(key))!.group;
}

/**
 * The English glossary (CONTEXT.en.md) names the two terms CONTEXT.md writes in Chinese alone;
 * both editions key a term the same way through this.
 */
const ENGLISH_ONLY_KEYS: Record<string, string> = { user: '用户', 'setup wizard': '向导' };

/** English name in parentheses, otherwise the term as written. */
export function termKey(name: string): string {
  const m = name.match(/[（(]([^）)]+)[）)]\s*$/);
  const key = (m ? m[1] : name).trim();
  return ENGLISH_ONLY_KEYS[key.toLowerCase()] ?? key;
}

/**
 * Stable grouping for CONTEXT.md terms. Keys are `termKey()` results.
 * Adding a term to CONTEXT.md without listing it here fails docs.test.ts.
 */
export const TERM_GROUPS: Record<ManifestoTopic, readonly string[]> = {
  people: ['Bot', 'Roster', '用户', 'Profile', 'Archive'],
  conversations: ['Group', 'Direct', 'Session', 'Origin', 'Thread', 'Reaction', 'Judgement log'],
  collaboration: [
    'Handoff',
    'Delegation',
    'Participation',
    'Judgement',
    'Mention',
    'Pull-in',
    'Turn',
    'Redirect',
    'Fork',
    'Ask',
    'Stop',
    'Hold',
    'Control line',
    'Status question',
    'Plan',
    'Ticket',
    'Large job',
    'Sample',
    'Submission',
    'Review',
    'Review miss',
    'Capability ceiling',
    'External job',
    'Quality event',
    'Lesson',
    'Retrospective',
    'Work item',
    'Desk segment',
    'Attribution',
    'Group lead',
    'User quote',
    'Requirements ledger',
    'Scribe',
    'Line reading',
    'Organizer',
    'Organizer run log',
    'Check-back',
    'Supervisor',
    'Ball holder',
    'Closing check',
    'Acceptance check',
    'Check from your words'
  ],
  workspace: ['Workspace', 'Work dir', 'Artifact', 'Annotation', 'Attachment', 'Search', 'Mirror files'],
  runtime: [
    'Daemon',
    'App window',
    'Quit',
    'Launch at login',
    'Tray',
    'Local API',
    'Local token',
    'Interrupted',
    'Catch-up',
    'Terminal',
    'Remote screen',
    'Command stream',
    'Pane',
    'Layout',
    'Schema gate'
  ],
  models: [
    'Model endpoint',
    'Claude Agent',
    'Model',
    'Default model',
    'Model choice log',
    'MCP',
    '向导',
    'Routine',
    'Skill',
    'Project skill',
    'Memory',
    'Completion',
    'Context window',
    'Spend'
  ],
  safety: [
    'Approval',
    'Always allow',
    'Dangerous action',
    'Outside the workspace',
    'Workspace shell',
    'Unconstrained shell'
  ]
};

const GROUP_BY_KEY = new Map<string, ManifestoTopic>();
for (const topic of MANIFESTO_TOPICS) {
  for (const key of TERM_GROUPS[topic]) {
    GROUP_BY_KEY.set(key.toLowerCase(), topic);
  }
}

export function isManifestoTopic(value: string): value is ManifestoTopic {
  return (MANIFESTO_TOPICS as readonly string[]).includes(value);
}

export function assignTermGroup(name: string): ManifestoTopic {
  const key = termKey(name);
  const topic = GROUP_BY_KEY.get(key.toLowerCase());
  if (!topic) {
    throw new Error(`CONTEXT.md term "${name}" (key "${key}") is not in TERM_GROUPS`);
  }
  return topic;
}

export type ParsedTerm = {
  name: string;
  key: string;
  markdown: string;
};

export type ParsedContext = {
  preamble: string;
  terms: ParsedTerm[];
};

const TERM_START = /^\*\*(.+?)\*\*[：:]/;

export function parseContextMarkdown(raw: string): ParsedContext {
  const languageIdx = raw.search(/^## /m);
  const preamble = (languageIdx >= 0 ? raw.slice(0, languageIdx) : raw).trim();
  const rest = languageIdx >= 0 ? raw.slice(languageIdx).replace(/^##[^\n]*\n+/, '') : '';

  const chunks: string[] = [];
  let current = '';
  for (const line of rest.split('\n')) {
    if (TERM_START.test(line) && current.trim()) {
      chunks.push(current.trim());
      current = `${line}\n`;
    } else {
      current += `${line}\n`;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const terms: ParsedTerm[] = [];
  for (const chunk of chunks) {
    const match = chunk.match(TERM_START);
    if (!match) continue;
    const name = match[1].trim();
    terms.push({ name, key: termKey(name), markdown: chunk });
  }
  return { preamble, terms };
}

export function groupTerms<T extends { name: string; key: string }>(
  terms: T[]
): Record<ManifestoTopic, T[]> {
  const grouped = Object.fromEntries(MANIFESTO_TOPICS.map((topic) => [topic, [] as T[]])) as Record<
    ManifestoTopic,
    T[]
  >;
  const byKey = new Map<string, T>();
  for (const term of terms) {
    assignTermGroup(term.name);
    byKey.set(term.key.toLowerCase(), term);
  }
  for (const topic of MANIFESTO_TOPICS) {
    for (const key of TERM_GROUPS[topic]) {
      const term = byKey.get(key.toLowerCase());
      if (term) grouped[topic].push(term);
    }
  }
  return grouped;
}

/** Slug that keeps CJK characters so anchors read like the heading itself. */
export function slugify(text: string): string {
  return text
    .trim()
    .replace(/[\s/]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .toLowerCase();
}

/** The English name a term key stands for: the key itself, or the name of a Chinese-only key. */
function englishName(key: string): string {
  const entry = Object.entries(ENGLISH_ONLY_KEYS).find(([, zh]) => zh === key);
  return entry ? entry[0] : key;
}

/**
 * A term's anchor, from its English name so both editions share it and a link reads plainly
 * (`#term-handoff`, `#term-user`).
 */
export function termAnchorId(name: string): string {
  return `term-${slugify(englishName(termKey(name))) || 'entry'}`;
}

/** The anchor a term had before anchors were keyed by English name (`#term-交接handoff`). */
export function legacyTermAnchorId(name: string): string {
  return `term-${slugify(name) || 'entry'}`;
}

/** A location hash as text; a malformed escape is kept as written. */
export function decodeHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Where a glossary hash lands: a bare, prefixed or pre-rename term anchor → the anchor it has now
 * and the topic page it is on.
 */
export function resolveTermHash(
  hash: string,
  targets: Record<string, string>,
  aliases: Record<string, string>
): { id: string; path: string } | null {
  const raw = decodeHash(hash);
  if (!raw) return null;
  const prefixed = raw.startsWith('term-') ? raw : `term-${raw}`;
  const id = aliases[prefixed] ?? prefixed;
  return targets[id] ? { id, path: targets[id] } : null;
}

export function docsPath(key: DocsPageKey): string {
  if (key === 'docs') return '/docs';
  if (key === 'manifesto') return '/manifesto';
  if (key === 'roadmap') return '/roadmap';
  if (isGuide(key)) return `/${key}`;
  return `/manifesto/${key}`;
}

export function docsNeighbors(key: DocsPageKey): { prev?: DocsPageKey; next?: DocsPageKey } {
  const flat = DOCS_NAV.flatMap((g) => g.pages);
  const i = flat.indexOf(key);
  return {
    prev: i > 0 ? flat[i - 1] : undefined,
    next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : undefined
  };
}
