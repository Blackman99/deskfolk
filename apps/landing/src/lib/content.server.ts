import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { GITHUB_BLOB_MAIN } from './site';

export type TocEntry = { id: string; text: string; level: number };

/** Slug that keeps CJK characters so anchors read like the heading itself. */
function slugify(text: string): string {
  return text
    .trim()
    .replace(/[\s/]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .toLowerCase();
}

function createMarked(toc: TocEntry[]) {
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
        const id = unique(slugify(text) || `h-${depth}`);
        if (depth >= 2 && depth <= 3) toc.push({ id, text: text.trim(), level: depth });
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      paragraph({ tokens }) {
        const html = this.parser.parseInline(tokens);
        // Glossary entries in CONTEXT.md are paragraphs that open with a bold term and a colon.
        const first = tokens[0];
        const second = tokens[1];
        if (
          !inQuote &&
          first?.type === 'strong' &&
          second?.type === 'text' &&
          /^\s*[：:]/.test(String(second.raw ?? second.text ?? ''))
        ) {
          const term = 'text' in first ? String(first.text) : '';
          const id = unique(`term-${slugify(term) || 'entry'}`);
          toc.push({ id, text: term.trim(), level: 3 });
          return `<p id="${id}" class="term">${html}</p>\n`;
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

function sanitizeOptions(lang: 'zh' | 'en'): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'a',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'class', 'title'],
      code: ['class'],
      pre: ['class'],
      p: ['id', 'class'],
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

        // Rewrite internal markdown links
        if (href === 'ROADMAP.md' || href.endsWith('/ROADMAP.md')) {
          href = withBase(`/${lang}/roadmap`);
        } else if (href === 'CONTEXT.md' || href.endsWith('/CONTEXT.md')) {
          href = withBase(`/${lang}/manifesto`);
        } else if (href === 'README.md' || href === 'README.en.md' || href === 'README.zh.md') {
          href = withBase(`/${lang}`);
        } else if (href.endsWith('.md') || href.startsWith('docs/')) {
          const cleanPath = href.replace(/^\.\//, '');
          href = `${GITHUB_BLOB_MAIN}/${cleanPath}`;
        }

        const isExternal = href.startsWith('http://') || href.startsWith('https://');
        const finalAttribs: Record<string, string> = {
          ...attribs,
          href,
          class: 'text-cyan-400 hover:text-cyan-300 underline underline-offset-4 decoration-cyan-500/40'
        };

        if (isExternal) {
          finalAttribs.target = '_blank';
          finalAttribs.rel = 'noreferrer noopener';
        }

        return {
          tagName: 'a',
          attribs: finalAttribs
        };
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

export function getDocumentContent(docType: 'manifesto' | 'roadmap' | 'readme', lang: 'zh' | 'en' = 'zh'): { title: string; contentHtml: string; toc: TocEntry[] } {
  const repoRoot = findRepoRoot();
  let filename = 'CONTEXT.md';

  if (docType === 'manifesto') {
    filename = 'CONTEXT.md';
  } else if (docType === 'roadmap') {
    filename = 'ROADMAP.md';
  } else if (docType === 'readme') {
    filename = lang === 'en' ? 'README.md' : 'README.zh.md';
  }

  const targetPath = path.join(repoRoot, filename);
  if (!fs.existsSync(targetPath)) {
    return {
      title: filename,
      contentHtml: `<p>Document ${filename} not found.</p>`,
      toc: []
    };
  }

  const raw = fs.readFileSync(targetPath, 'utf-8');
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename;

  const toc: TocEntry[] = [];
  const rawHtml = createMarked(toc).parse(raw) as string;
  const contentHtml = sanitizeHtml(rawHtml, sanitizeOptions(lang));

  return { title, contentHtml, toc };
}
