import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { GITHUB_BLOB_MAIN, GITHUB_RAW_MAIN } from './site';
import { DICT } from './i18n';
import {
  DOCS_NAV,
  GUIDES,
  MANIFESTO_TOPICS,
  type DocsPageKey,
  type Guide,
  type ManifestoTopic,
  type ParsedTerm,
  type TocEntry,
  docsPath,
  groupTerms,
  legacyTermAnchorId,
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

type Lang = 'zh' | 'en';

/**
 * CONTEXT.md and ROADMAP.md are written in Chinese (agents keep the glossary in it); the English
 * site reads their English editions, and falls back to the Chinese file where one is missing.
 */
const EDITIONS = {
  context: { zh: 'CONTEXT.md', en: 'CONTEXT.en.md' },
  roadmap: { zh: 'ROADMAP.md', en: 'ROADMAP.en.md' },
  behavior: { zh: 'docs/behavior.md', en: 'docs/behavior.en.md' }
} as const;

/** The file each guide page is published from, per language. */
export const GUIDE_SOURCES: Record<Guide, Record<Lang, string>> = {
  overview: { zh: 'docs/overview.zh.md', en: 'docs/overview.md' },
  gatekeeper: { zh: 'docs/gatekeeper.zh.md', en: 'docs/gatekeeper.md' },
  windows: { zh: 'docs/windows.zh.md', en: 'docs/windows.md' },
  routines: { zh: 'docs/routines.zh.md', en: 'docs/routines.md' },
  spend: { zh: 'docs/spend.zh.md', en: 'docs/spend.md' },
  remote: { zh: 'docs/remote-access.zh.md', en: 'docs/remote-access.md' }
};

/** The site page a guide under docs/ is published as, keyed by its repository path. */
const GUIDE_PAGES: Record<string, { lang: Lang; path: string }> = Object.fromEntries(
  GUIDES.flatMap((guide) =>
    (['zh', 'en'] as const).map((lang) => [GUIDE_SOURCES[guide][lang], { lang, path: docsPath(guide) }])
  )
);

/** Repository files that have a page on the site; a rendered link to one never goes to GitHub. */
export const PUBLISHED_SOURCES: readonly string[] = [
  ...Object.values(EDITIONS).flatMap((e) => [e.zh, e.en]),
  ...Object.keys(GUIDE_PAGES),
  'README.md',
  'README.zh.md'
];

/** Images from docs/assets/ that a published page shows; the site serves them at /docs-assets/. */
const ASSET_DIR = 'docs/assets/';

export type ManifestoIndexEntry = {
  topic: ManifestoTopic;
  terms: { name: string; id: string }[];
};

function createMarked(
  lang: Lang,
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
          const label = DICT[lang].docs.avoidLabel;
          return `<p class="avoid">${html.replace(/^<em>Avoid<\/em>\s*[：:]?\s*/, `<em>${label}</em>`)}</p>\n`;
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

type LinkTargets = {
  /** Term anchor → glossary page path. */
  terms: Record<string, string>;
  /** Anchor a term used to have → the one it has now. */
  aliases: Record<string, string>;
  /** Section id in docs/behavior*.md → the glossary page and anchor it is shown at. */
  behavior: Record<string, string>;
};

function contextHref(lang: Lang, hash: string | undefined, targets: LinkTargets): string {
  if (hash) {
    const raw = hash.startsWith('term-') ? hash : `term-${hash}`;
    const id = targets.aliases[raw] ?? raw;
    const dest = targets.terms[id];
    if (dest) return withBase(`/${lang}${dest}#${id}`);
    return withBase(`/${lang}/manifesto#${hash}`);
  }
  return withBase(`/${lang}/manifesto`);
}

/** Resolves a relative link in a file under `dir` to a repository path; other links are left alone. */
function repoRelative(href: string, dir: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  }
  return path.posix.normalize(dir ? path.posix.join(dir, href) : href);
}

/** The README section the site's home page carries as its download / run-from-source block. */
function sanitizeOptions(lang: Lang, targets: LinkTargets, dir = '', behaviorFragments = false): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'a', 'img',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'class', 'title'],
      img: ['src', 'alt', 'title', 'loading'],
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
      img: (_tagName, attribs) => {
        const resolved = repoRelative(attribs.src || '', dir);
        let src = attribs.src || '';
        if (resolved?.startsWith(ASSET_DIR)) src = withBase(`/docs-assets/${resolved.slice(ASSET_DIR.length)}`);
        else if (resolved) src = `${GITHUB_RAW_MAIN}/${resolved}`;
        return { tagName: 'img', attribs: { ...attribs, src, loading: 'lazy' } };
      },
      a: (_tagName, attribs) => {
        let href = attribs.href || '';
        const resolved = repoRelative(href, dir);
        if (resolved) href = resolved;
        const hashIdx = href.indexOf('#');
        const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
        const hash = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';

        // An inlined behavior section lost its source heading; its fragments now belong to
        // the canonical folded details, which may live on another glossary topic page.
        if (behaviorFragments && !pathPart && targets.behavior[hash]) {
          href = withBase(`/${lang}${targets.behavior[hash]}`);
        } else if (/(^|\/)ROADMAP(\.en)?\.md$/.test(pathPart)) {
          href = withBase(`/${lang}/roadmap`) + (hash ? `#${hash}` : '');
        } else if (/(^|\/)CONTEXT(\.en)?\.md$/.test(pathPart)) {
          href = contextHref(lang, hash || undefined, targets);
        } else if (/(^|\/)docs\/behavior(\.en)?\.md$/.test(pathPart)) {
          const dest = targets.behavior[hash];
          href = withBase(`/${lang}${dest ?? '/manifesto'}`);
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

/** A code block sits in a box that the page hangs its copy button on. */
function boxCodeBlocks(html: string): string {
  return html.replace(/<pre(\s[^>]*)?>/g, '<div class="codeblock"><pre$1>').replace(/<\/pre>/g, '</pre></div>');
}

function renderMarkdown(
  raw: string,
  lang: Lang,
  toc: TocEntry[],
  targets: LinkTargets,
  headingId?: (text: string, depth: number) => string | undefined,
  dir = '',
  behaviorFragments = false
): string {
  const rawHtml = createMarked(lang, toc, headingId).parse(raw) as string;
  return boxCodeBlocks(sanitizeHtml(rawHtml, sanitizeOptions(lang, targets, dir, behaviorFragments)));
}

function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+.+\n+/, '');
}

/** A document's first line under its title links its other language; the site's own switch does that job. */
function stripLanguageLink(markdown: string): string {
  return markdown.replace(/^(#\s+.+\n+)\[[^\]\n]+\]\([^)\s]+\.md\)\s*\n+/, '$1');
}

/** The file a page reads for this language: its edition when there is one, else the Chinese source. */
export function editionSource(doc: keyof typeof EDITIONS, lang: Lang): string {
  const file = EDITIONS[doc][lang];
  return fs.existsSync(path.join(findRepoRoot(), file)) ? file : EDITIONS[doc].zh;
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

function loadContext(lang: Lang): { preamble: string; terms: ParsedTerm[] } {
  const raw = readRepoFile(editionSource('context', lang));
  if (!raw) return { preamble: '', terms: [] };
  return parseContextMarkdown(stripLanguageLink(raw));
}

const BEHAVIOR_LINK = /docs\/behavior(?:\.en)?\.md#([a-z0-9-]+)/;

/** The docs/behavior*.md section a term points to for its details, if any. */
function behaviorId(term: ParsedTerm): string | undefined {
  return term.markdown.match(BEHAVIOR_LINK)?.[1];
}

/** docs/behavior*.md split at its `<a id="…"></a>` + `## Term` headings: section id → body. */
function loadBehavior(lang: Lang): Map<string, string> {
  const raw = readRepoFile(editionSource('behavior', lang)) ?? '';
  const sections = new Map<string, string>();
  const heading = /<a id="([^"]+)"><\/a>\s*\n##\s[^\n]*\n/g;
  const marks = [...raw.matchAll(heading)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    sections.set(m[1], raw.slice(start, end).trim());
  });
  return sections;
}

function behaviorAnchorId(id: string): string {
  return `behavior-${id}`;
}

function linkTargets(): LinkTargets {
  const { terms } = loadContext('zh');
  const grouped = groupTerms(terms);
  const targets: LinkTargets = { terms: {}, aliases: {}, behavior: {} };
  for (const topic of MANIFESTO_TOPICS) {
    for (const term of grouped[topic]) {
      const id = termAnchorId(term.name);
      targets.terms[id] = docsPath(topic);
      const legacy = legacyTermAnchorId(term.name);
      if (legacy !== id) targets.aliases[legacy] = id;
      const behavior = behaviorId(term);
      if (behavior) targets.behavior[behavior] = `${docsPath(topic)}#${behaviorAnchorId(behavior)}`;
    }
  }
  return targets;
}

/** Term anchor → the glossary page it lives on. */
export function getTermTargets(): Record<string, string> {
  return linkTargets().terms;
}

/** Anchors terms had before they were keyed by English name → the anchors they have now. */
export function getTermAliases(): Record<string, string> {
  return linkTargets().aliases;
}

function termToMarkdown(term: ParsedTerm): string {
  const body = term.markdown
    .replace(/^\*\*.+?\*\*[：:]\s*/, '')
    .replace(/([^\n])\n(_Avoid_[：:])/g, '$1\n\n$2');
  return `## ${term.name}\n\n${body}`;
}

export function getManifestoHub(lang: Lang): {
  preambleHtml: string;
  toc: TocEntry[];
  index: ManifestoIndexEntry[];
  termTargets: Record<string, string>;
  termAliases: Record<string, string>;
} {
  const { preamble, terms } = loadContext(lang);
  const targets = linkTargets();
  const toc: TocEntry[] = [];
  const preambleHtml = preamble
    ? renderMarkdown(stripLeadingH1(preamble), lang, toc, targets)
    : '<p>CONTEXT.md not found.</p>';
  const grouped = groupTerms(terms);
  const index: ManifestoIndexEntry[] = MANIFESTO_TOPICS.map((topic) => ({
    topic,
    terms: grouped[topic].map((term) => ({ name: term.name, id: termAnchorId(term.name) }))
  }));
  return { preambleHtml, toc, index, termTargets: targets.terms, termAliases: targets.aliases };
}

/** A term's behavior details, folded under its body and above its avoid line. */
function withBehavior(termHtml: string, id: string, bodyHtml: string, lang: Lang): string {
  // Keep shared pre-P4b organizer URLs alongside its canonical term/details anchors.
  const legacyAnchor = id === 'organizer' ? '<span id="organizer" aria-hidden="true"></span>' : '';
  const details =
    legacyAnchor + `<details class="behavior" id="${behaviorAnchorId(id)}">` +
    `<summary>${DICT[lang].docs.behaviorSummary}</summary>\n${bodyHtml}</details>\n`;
  const avoidAt = termHtml.lastIndexOf('<p class="avoid">');
  return avoidAt >= 0 ? termHtml.slice(0, avoidAt) + details + termHtml.slice(avoidAt) : termHtml + details;
}

export function getManifestoTopic(topic: ManifestoTopic, lang: Lang): DocsDocument & { aliases: Record<string, string> } {
  const { terms } = loadContext(lang);
  const grouped = groupTerms(terms);
  const targets = linkTargets();
  const behavior = loadBehavior(lang);
  const toc: TocEntry[] = [];
  const parts = grouped[topic].map((term) => {
    const id = termAnchorId(term.name);
    const html = renderMarkdown(termToMarkdown(term), lang, toc, targets, (text) =>
      text === term.name ? id : undefined
    );
    const detailsId = behaviorId(term);
    const details = detailsId ? behavior.get(detailsId) : undefined;
    if (!detailsId || !details) return html;
    const bodyHtml = renderMarkdown(details, lang, [], targets, undefined, 'docs', true);
    return withBehavior(html, detailsId, bodyHtml, lang);
  });
  const ids = new Set(toc.map((e) => e.id));
  const aliases = Object.fromEntries(Object.entries(targets.aliases).filter(([, id]) => ids.has(id)));
  return {
    title: topic,
    contentHtml: parts.join('\n') || '<p>No terms in this topic.</p>',
    toc,
    aliases
  };
}

/** Repository path of a document page's source, per language. */
export function documentSource(docType: 'roadmap' | 'readme' | Guide, lang: Lang): string {
  if (docType === 'roadmap') return editionSource('roadmap', lang);
  if (docType === 'readme') return lang === 'en' ? 'README.md' : 'README.zh.md';
  return GUIDE_SOURCES[docType][lang];
}

export function getDocumentContent(docType: 'roadmap' | 'readme' | Guide, lang: Lang = 'zh'): DocsDocument {
  const filename = documentSource(docType, lang);
  const source = readRepoFile(filename);
  const raw = source === null ? null : stripLanguageLink(source);
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
  const contentHtml = renderMarkdown(raw, lang, toc, linkTargets(), undefined, dir === '.' ? '' : dir);
  return { title, contentHtml, toc };
}

/** Images under docs/assets/ that published pages show. */
export function publishedAssets(): string[] {
  const files = new Set<string>();
  for (const source of PUBLISHED_SOURCES) {
    const raw = readRepoFile(source);
    if (!raw) continue;
    const dir = path.posix.dirname(source);
    for (const m of raw.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const resolved = repoRelative(m[1], dir === '.' ? '' : dir);
      if (resolved?.startsWith(ASSET_DIR)) files.add(resolved.slice(ASSET_DIR.length));
    }
  }
  return [...files].sort();
}

export function readAsset(file: string): Buffer | null {
  if (file.includes('/') || file.includes('\\') || file.startsWith('.')) return null;
  const target = path.join(findRepoRoot(), ASSET_DIR, file);
  return fs.existsSync(target) ? fs.readFileSync(target) : null;
}

export type SearchEntry = {
  /** Page title. */
  page: string;
  /** Section heading, or the page title for the text above the first heading. */
  title: string;
  /** Path after the language segment, with the section's anchor. */
  href: string;
  text: string;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function plainText(html: string): string {
  return html
    .replace(/<summary>[\s\S]*?<\/summary>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
}

/** A rendered page cut at its h2 / h3 headings. */
function sections(html: string, page: string, pathname: string): SearchEntry[] {
  const out: SearchEntry[] = [];
  const heading = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g;
  let last = { title: page, id: '', start: 0 };
  const push = (end: number) => {
    const text = plainText(html.slice(last.start, end));
    if (text || last.id) out.push({ page, title: last.title, href: last.id ? `${pathname}#${last.id}` : pathname, text });
  };
  for (const m of html.matchAll(heading)) {
    push(m.index ?? 0);
    last = { title: plainText(m[3]), id: m[2], start: (m.index ?? 0) + m[0].length };
  }
  push(html.length);
  return out;
}

/** Everything the docs search looks through, per language: one entry per section. */
export function getSearchIndex(lang: Lang): SearchEntry[] {
  const titles = DICT[lang].docs.pages;
  const entries: SearchEntry[] = [];
  for (const key of DOCS_NAV.flatMap((g) => g.pages) as DocsPageKey[]) {
    const pathname = docsPath(key);
    const title = titles[key].title;
    if (key === 'docs') continue;
    if (key === 'manifesto') {
      entries.push(...sections(getManifestoHub(lang).preambleHtml, title, pathname));
    } else if ((MANIFESTO_TOPICS as readonly string[]).includes(key)) {
      entries.push(...sections(getManifestoTopic(key as ManifestoTopic, lang).contentHtml, title, pathname));
    } else {
      const doc = getDocumentContent(key as 'roadmap' | Guide, lang);
      entries.push(...sections(doc.contentHtml.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, ''), title, pathname));
    }
  }
  return entries;
}
