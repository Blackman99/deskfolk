import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { GITHUB_BLOB_MAIN } from './site';
import {
  MANIFESTO_TOPICS,
  type ManifestoTopic,
  type ParsedTerm,
  type TocEntry,
  docsPath,
  groupTerms,
  parseContextMarkdown,
  slugify,
  termAnchorId
} from './docs';

export type { TocEntry };

export type DocsDocument = {
  title: string;
  contentHtml: string;
  toc: TocEntry[];
};

export type ManifestoIndexEntry = {
  topic: ManifestoTopic;
  terms: { name: string; id: string }[];
};

function createMarked(
  toc: TocEntry[],
  headingId?: (text: string, depth: number) => string | undefined
) {
  const seen = new Map<string, number>();
  const unique = (base: string): string => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };
  let inQuote = false;
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({
    renderer: {
      blockquote({ tokens }) {
        inQuote = true;
        const body = this.parser.parse(tokens);
        inQuote = false;
        return `<blockquote>\n${body}</blockquote>\n`;
      },
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const text = tokens.map((tk) => ('text' in tk ? String(tk.text) : '')).join('');
        const preferred = headingId?.(text.trim(), depth);
        const id = unique(preferred || slugify(text) || `h-${depth}`);
        if (depth >= 2 && depth <= 3) toc.push({ id, text: text.trim(), level: depth });
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      paragraph({ tokens }) {
        const html = this.parser.parseInline(tokens);
        const first = tokens[0];
        const firstText = first && 'text' in first ? String(first.text) : '';
        if (!inQuote && first?.type === 'em' && firstText === 'Avoid') {
          return `<p class="avoid">${html}</p>\n`;
        }
        return `<p>${html}</p>\n`;
      }
    }
  });
  return marked;
}

function withBase(pathname: string): string {
  const base = process.env.BASE_PATH ?? '';
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${normalized}`;
}

function contextHref(lang: 'zh' | 'en', hash?: string, termTargets?: Record<string, string>): string {
  if (hash) {
    const id = hash.startsWith('term-') ? hash : `term-${hash}`;
    const dest = termTargets?.[hash] ?? termTargets?.[id];
    if (dest) return withBase(`/${lang}${dest}#${id}`);
    return withBase(`/${lang}/manifesto#${hash}`);
  }
  return withBase(`/${lang}/manifesto`);
}

/** The site page a guide under docs/ is published as, keyed by its repository path. */
const GUIDE_PAGES: Record<string, { lang: 'zh' | 'en'; path: string }> = {
  'docs/remote-access.md': { lang: 'en', path: '/remote' },
  'docs/remote-access.zh.md': { lang: 'zh', path: '/remote' }
};

/** Resolves a relative link in a file under `dir` to a repository path; other links are left alone. */
function repoRelative(href: string, dir: string): string | null {
  if (!dir || !href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  }
  return path.posix.normalize(path.posix.join(dir, href));
}

function sanitizeOptions(
  lang: 'zh' | 'en',
  termTargets?: Record<string, string>,
  dir = ''
): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'a',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'class', 'title'],
      code: ['class'],
      pre: ['class'],
      p: ['id', 'class'],
      section: ['id', 'class'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      ol: ['start'],
      th: ['align'],
      td: ['align']
    },
    transformTags: {
      a: (_tagName, attribs) => {
        let href = attribs.href || '';
        const resolved = repoRelative(href, dir);
        if (resolved) href = resolved;
        const hashIdx = href.indexOf('#');
        const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
        const hash = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';

        if (pathPart === 'ROADMAP.md' || pathPart.endsWith('/ROADMAP.md')) {
          href = withBase(`/${lang}/roadmap`) + (hash ? `#${hash}` : '');
        } else if (pathPart === 'CONTEXT.md' || pathPart.endsWith('/CONTEXT.md')) {
          href = contextHref(lang, hash || undefined, termTargets);
        } else if (
          pathPart === 'README.md' ||
          pathPart === 'README.en.md' ||
          pathPart === 'README.zh.md'
        ) {
          href = withBase(`/${lang}`);
        } else if (GUIDE_PAGES[pathPart]) {
          const guide = GUIDE_PAGES[pathPart];
          href = withBase(`/${guide.lang}${guide.path}`) + (hash ? `#${hash}` : '');
        } else if (resolved || pathPart.endsWith('.md') || pathPart.startsWith('docs/')) {
          const cleanPath = href.replace(/^\.\//, '');
          href = `${GITHUB_BLOB_MAIN}/${cleanPath}`;
        }

        const isExternal = href.startsWith('http://') || href.startsWith('https://');
        const finalAttribs: Record<string, string> = { ...attribs, href };
        delete finalAttribs.class;

        if (isExternal) {
          finalAttribs.target = '_blank';
          finalAttribs.rel = 'noreferrer noopener';
        }

        return { tagName: 'a', attribs: finalAttribs };
      }
    }
  };
}

function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'CONTEXT.md')) && fs.existsSync(path.join(dir, 'ROADMAP.md'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(startDir, '../..');
}

function readRepoFile(filename: string): string | null {
  const targetPath = path.join(findRepoRoot(), filename);
  if (!fs.existsSync(targetPath)) return null;
  return fs.readFileSync(targetPath, 'utf-8');
}

function renderMarkdown(
  raw: string,
  lang: 'zh' | 'en',
  toc: TocEntry[],
  termTargets?: Record<string, string>,
  headingId?: (text: string, depth: number) => string | undefined,
  dir = ''
): string {
  const rawHtml = createMarked(toc, headingId).parse(raw) as string;
  return sanitizeHtml(rawHtml, sanitizeOptions(lang, termTargets, dir));
}

function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+.+\n+/, '');
}

/** Version of the desktop app as declared in tauri.conf.json (the release tag source of truth). */
export function getAppVersion(): string {
  const conf = path.join(findRepoRoot(), 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(conf, 'utf-8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadContext(): { preamble: string; terms: ParsedTerm[] } {
  const raw = readRepoFile('CONTEXT.md');
  if (!raw) return { preamble: '', terms: [] };
  return parseContextMarkdown(raw);
}

export function getTermTargets(): Record<string, string> {
  const { terms } = loadContext();
  const grouped = groupTerms(terms);
  const map: Record<string, string> = {};
  for (const topic of MANIFESTO_TOPICS) {
    for (const term of grouped[topic]) {
      map[termAnchorId(term.name)] = docsPath(topic);
    }
  }
  return map;
}

function termToMarkdown(term: ParsedTerm): string {
  const body = term.markdown
    .replace(/^\*\*.+?\*\*[：:]\s*/, '')
    .replace(/([^\n])\n(_Avoid_[：:])/g, '$1\n\n$2');
  return `## ${term.name}\n\n${body}`;
}

export function getManifestoHub(lang: 'zh' | 'en'): {
  preambleHtml: string;
  toc: TocEntry[];
  index: ManifestoIndexEntry[];
  termTargets: Record<string, string>;
} {
  const { preamble, terms } = loadContext();
  const termTargets = getTermTargets();
  const toc: TocEntry[] = [];
  const preambleHtml = preamble
    ? renderMarkdown(stripLeadingH1(preamble), lang, toc, termTargets)
    : '<p>CONTEXT.md not found.</p>';
  const grouped = groupTerms(terms);
  const index: ManifestoIndexEntry[] = MANIFESTO_TOPICS.map((topic) => ({
    topic,
    terms: grouped[topic].map((term) => ({ name: term.name, id: termAnchorId(term.name) }))
  }));
  return { preambleHtml, toc, index, termTargets };
}

export function getManifestoTopic(topic: ManifestoTopic, lang: 'zh' | 'en'): DocsDocument {
  const { terms } = loadContext();
  const grouped = groupTerms(terms);
  const termTargets = getTermTargets();
  const toc: TocEntry[] = [];
  const parts = grouped[topic].map((term) =>
    renderMarkdown(termToMarkdown(term), lang, toc, termTargets, (text) =>
      text === term.name ? termAnchorId(term.name) : undefined
    )
  );
  return {
    title: topic,
    contentHtml: parts.join('\n') || '<p>No terms in this topic.</p>',
    toc
  };
}

/** Repository path of a document page's source, per language. */
export function documentSource(docType: 'roadmap' | 'readme' | 'remote', lang: 'zh' | 'en'): string {
  if (docType === 'roadmap') return 'ROADMAP.md';
  if (docType === 'remote') return lang === 'en' ? 'docs/remote-access.md' : 'docs/remote-access.zh.md';
  return lang === 'en' ? 'README.md' : 'README.zh.md';
}

export function getDocumentContent(
  docType: 'manifesto' | 'roadmap' | 'readme' | 'remote',
  lang: 'zh' | 'en' = 'zh'
): DocsDocument {
  if (docType === 'manifesto') {
    const hub = getManifestoHub(lang);
    return { title: 'CONTEXT.md', contentHtml: hub.preambleHtml, toc: hub.toc };
  }

  const filename = documentSource(docType, lang);
  const source = readRepoFile(filename);
  // A guide's first line links its other language; the site's own switch does that job.
  const raw = source?.replace(/^(#\s+.+\n+)\[[^\]\n]+\]\([^)\s]+\.md\)\s*\n+/, '$1') ?? null;
  if (!raw) {
    return {
      title: filename,
      contentHtml: `<p>Document ${filename} not found.</p>`,
      toc: []
    };
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename;
  const toc: TocEntry[] = [];
  const dir = path.posix.dirname(filename);
  const contentHtml = renderMarkdown(raw, lang, toc, getTermTargets(), undefined, dir === '.' ? '' : dir);
  return { title, contentHtml, toc };
}
