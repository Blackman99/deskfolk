import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { GITHUB_BLOB_MAIN } from './site';

const marked = new Marked({ gfm: true, breaks: true });

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

export function getDocumentContent(docType: 'manifesto' | 'roadmap' | 'readme', lang: 'zh' | 'en' = 'zh'): { title: string; contentHtml: string } {
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
      contentHtml: `<p>Document ${filename} not found.</p>`
    };
  }

  const raw = fs.readFileSync(targetPath, 'utf-8');
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename;

  const rawHtml = marked.parse(raw) as string;
  const contentHtml = sanitizeHtml(rawHtml, sanitizeOptions(lang));

  return { title, contentHtml };
}
