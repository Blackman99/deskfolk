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

export const DOCS_PAGE_KEYS = ['manifesto', ...MANIFESTO_TOPICS, 'roadmap'] as const;
export type DocsPageKey = (typeof DOCS_PAGE_KEYS)[number];

export type DocsNavGroupId = 'language' | 'direction';

export const DOCS_NAV: { group: DocsNavGroupId; pages: DocsPageKey[] }[] = [
  { group: 'language', pages: ['manifesto', ...MANIFESTO_TOPICS] },
  { group: 'direction', pages: ['roadmap'] }
];

/** English name in parentheses, otherwise the term as written. */
export function termKey(name: string): string {
  const m = name.match(/[（(]([^）)]+)[）)]\s*$/);
  return (m ? m[1] : name).trim();
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
    'Participation',
    'Judgement',
    'Mention',
    'Pull-in',
    'Turn',
    'Redirect',
    'Fork',
    'Ask',
    'Stop'
  ],
  workspace: ['Workspace', 'Work dir', 'Artifact', 'Attachment', 'Search'],
  runtime: [
    'Daemon',
    'App window',
    'Quit',
    'Launch at login',
    'Tray',
    'Local API',
    'Local token',
    'Interrupted',
    'Catch-up'
  ],
  models: [
    'Model endpoint',
    'Model',
    'Model choice log',
    'MCP',
    '向导',
    'Routine',
    'Skill',
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

export function termAnchorId(name: string): string {
  return `term-${slugify(name) || 'entry'}`;
}

export function docsPath(key: DocsPageKey): string {
  if (key === 'manifesto') return '/manifesto';
  if (key === 'roadmap') return '/roadmap';
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
