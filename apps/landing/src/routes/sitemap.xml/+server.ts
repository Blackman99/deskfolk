import { DOCS_NAV, docsPath } from '$lib/docs';
import { SITE_URL } from '$lib/site';

export const prerender = true;

const PAGES = ['', ...DOCS_NAV.flatMap((g) => g.pages.map(docsPath))];
const LANGS: { code: 'zh' | 'en'; hreflang: string }[] = [
  { code: 'zh', hreflang: 'zh-CN' },
  { code: 'en', hreflang: 'en' }
];

function alternates(suffix: string): string {
  const links = LANGS.map(
    (l) => `    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${SITE_URL}/${l.code}${suffix}" />`
  );
  links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/" />`);
  return links.join('\n');
}

export function GET() {
  const urls = PAGES.flatMap((suffix) =>
    LANGS.map(
      (l) => `  <url>
    <loc>${SITE_URL}/${l.code}${suffix}</loc>
${alternates(suffix)}
    <changefreq>weekly</changefreq>
    <priority>${suffix === '' ? '1.0' : '0.6'}</priority>
  </url>`
    )
  );

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${SITE_URL}/</loc>
${alternates('')}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${urls.join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}
