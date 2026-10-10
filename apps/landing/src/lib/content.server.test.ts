import { expect, test } from 'bun:test';
import {
  GUIDE_SOURCES,
  PUBLISHED_SOURCES,
  documentSource,
  getDocumentContent,
  getManifestoHub,
  getManifestoTopic,
  getSearchIndex,
  getTermAliases,
  getTermTargets,
  publishedAssets
} from './content.server';
import { GUIDES, MANIFESTO_TOPICS, termAnchorId } from './docs';
import { GITHUB_BLOB_MAIN } from './site';

test('manifesto hub lists every topic with its terms', () => {
  const hub = getManifestoHub('zh');
  expect(hub.preambleHtml).toContain('WIP');
  expect(hub.preambleHtml).not.toContain('id="language"');
  expect(hub.index.map((e) => e.topic)).toEqual([...MANIFESTO_TOPICS]);
  expect(hub.index.every((e) => e.terms.length > 0)).toBe(true);
  const people = hub.index.find((e) => e.topic === 'people');
  expect(people?.terms.some((t) => t.name === 'Bot' && t.id === 'term-bot')).toBe(true);
  // The Windows note in the preamble is a page of the site now.
  expect(hub.preambleHtml).toContain('href="/zh/windows"');
});

test('a topic page renders term headings and avoid lines', () => {
  const doc = getManifestoTopic('people', 'zh');
  expect(doc.contentHtml).toContain('id="term-bot"');
  expect(doc.contentHtml).toContain('id="term-user"');
  expect(doc.toc[0]).toEqual({ id: 'term-bot', text: 'Bot', level: 2 });
  expect(doc.contentHtml).toContain('<p class="avoid"><em>回避：</em>');
  expect(getManifestoTopic('people', 'en').contentHtml).toContain('<p class="avoid"><em>Avoid: </em>');
});

test('term targets send glossary hashes to the topic page', () => {
  const targets = getTermTargets();
  expect(targets[termAnchorId('Bot')]).toBe('/manifesto/people');
  expect(targets[termAnchorId('群（Group）')]).toBe('/manifesto/conversations');
  expect(targets[termAnchorId('Always allow')]).toBe('/manifesto/safety');
  expect(targets['term-handoff']).toBe('/manifesto/collaboration');
});

test('anchors from before the rename point at the ones terms have now', () => {
  const aliases = getTermAliases();
  expect(aliases['term-交接handoff']).toBe('term-handoff');
  expect(aliases['term-用户']).toBe('term-user');
  // Unchanged anchors need no alias.
  expect(aliases['term-bot']).toBeUndefined();
  const topic = getManifestoTopic('collaboration', 'en');
  expect(topic.aliases['term-交接handoff']).toBe('term-handoff');
  expect(topic.aliases['term-用户']).toBeUndefined();
});

test('a term folds in its behavior details instead of linking to GitHub', () => {
  for (const lang of ['zh', 'en'] as const) {
    const doc = getManifestoTopic('collaboration', lang);
    expect(doc.contentHtml).toContain('<details class="behavior" id="behavior-plan">');
    expect(doc.contentHtml).toContain('href="/' + lang + '/manifesto/collaboration#behavior-plan"');
    expect(doc.contentHtml).not.toContain('docs/behavior');
    // Details sit above the avoid line, and put nothing in the page's toc.
    const plan = doc.contentHtml.slice(doc.contentHtml.indexOf('id="term-plan"'));
    expect(plan.indexOf('class="behavior"')).toBeLessThan(plan.indexOf('class="avoid"'));
    expect(doc.toc.every((e) => e.id.startsWith('term-'))).toBe(true);
  }
  expect(getManifestoTopic('collaboration', 'zh').contentHtml).toContain('<summary>行为细节</summary>');
});

test('P4b terms share collaboration anchors and paired behavior without implementation in definitions', () => {
  for (const lang of ['zh', 'en'] as const) {
    const doc = getManifestoTopic('collaboration', lang);
    for (const key of ['work-item', 'desk-segment', 'attribution', 'group-lead']) {
      expect(doc.toc.some((entry) => entry.id === `term-${key}`)).toBe(true);
      expect(doc.contentHtml.split(`id="behavior-${key}"`).length - 1).toBe(1);
      expect(doc.contentHtml).not.toContain(`href="#${key}"`);
      expect(getTermTargets()[`term-${key}`]).toBe('/manifesto/collaboration');
    }
    expect(doc.contentHtml.split('id="behavior-turn"').length - 1).toBe(1);
    expect(doc.contentHtml).toContain(`href="/${lang}/manifesto/collaboration#behavior-work-item"`);
    expect(doc.contentHtml).toContain(`href="/${lang}/manifesto/collaboration#behavior-attribution"`);
    expect(doc.contentHtml).toContain(`href="/${lang}/manifesto/collaboration#behavior-desk-segment"`);
    const plan = doc.contentHtml.slice(doc.contentHtml.indexOf('id="term-plan"'));
    const definition = plan.slice(0, plan.indexOf('<details class="behavior"'));
    expect(definition).not.toContain('task_id');
    expect(doc.contentHtml).toContain('engine_level');
  }
});

test('partial P4c delegation has paired canonical details without implying submission or supervision', () => {
  for (const lang of ['zh', 'en'] as const) {
    const doc = getManifestoTopic('collaboration', lang);
    expect(doc.toc.some((entry) => entry.id === 'term-delegation')).toBe(true);
    expect(doc.contentHtml.split('id="behavior-delegation"').length - 1).toBe(1);
    expect(getTermTargets()['term-delegation']).toBe('/manifesto/collaboration');
    expect(doc.contentHtml).toContain('delegation_wait');
    expect(doc.contentHtml).toContain('implicitSubmission.implemented=false');
    const direct = getManifestoTopic('conversations', lang).contentHtml;
    expect(direct.split('id="behavior-direct"').length - 1).toBe(1);
  }
});

test('folded glossary fragments resolve and legacy organizer URLs retain their destination', () => {
  for (const lang of ['zh', 'en'] as const) {
    const pages = MANIFESTO_TOPICS.map((topic) => {
      const html = getManifestoTopic(topic, lang).contentHtml;
      return { topic, html, ids: new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])) };
    });
    for (const { html, ids } of pages) {
      const missing = [...html.matchAll(/href="#([^"]+)"/g)]
        .map((match) => decodeURIComponent(match[1]))
        .filter((id) => !ids.has(id));
      expect(missing).toEqual([]);
      for (const [, topic, hash] of html.matchAll(new RegExp(`href="/${lang}/manifesto/([a-z-]+)#([^"]+)"`, 'g'))) {
        expect(pages.find((page) => page.topic === topic)?.ids.has(decodeURIComponent(hash))).toBe(true);
      }
    }
    const collaboration = getManifestoTopic('collaboration', lang).contentHtml;
    expect(collaboration).toContain('id="organizer"');
    expect(collaboration).toContain('id="behavior-organizer"');
    expect(collaboration).toContain('id="term-organizer"');
  }
});

test('roadmap still has a heading toc', () => {
  const doc = getDocumentContent('roadmap', 'zh');
  expect(doc.title).toBe('Roadmap');
  expect(doc.toc.length).toBeGreaterThan(1);
  expect(doc.toc.some((e) => e.level === 2)).toBe(true);
  expect(doc.contentHtml).toContain('href=');
});

test('every guide renders in both languages from its own source', () => {
  for (const guide of GUIDES) {
    for (const lang of ['zh', 'en'] as const) {
      expect(documentSource(guide, lang)).toBe(GUIDE_SOURCES[guide][lang]);
      const doc = getDocumentContent(guide, lang);
      expect(doc.contentHtml).not.toContain('not found');
      // The other-language line is the site's language switch now.
      expect(doc.contentHtml).not.toContain(lang === 'en' ? '简体中文' : '>English<');
    }
  }
});

test('the remote-access guide renders per language, with its links resolved from docs/', () => {
  const zh = getDocumentContent('remote', 'zh');
  const en = getDocumentContent('remote', 'en');
  expect(zh.title).toBe('远程访问（实验性）');
  expect(en.title).toBe('Remote access (experimental)');
  expect(en.toc.some((e) => e.text === '3. Pair a phone')).toBe(true);
  // Unpublished sibling docs, parent-directory files and anchors point at the repository on GitHub.
  expect(en.contentHtml).toContain('href="https://github.com/Blackman99/deskfolk/blob/main/docs/deploy-remote.md#web-push-proxy"');
  expect(en.contentHtml).toContain('href="https://github.com/Blackman99/deskfolk/blob/main/deploy/remote/Caddyfile"');
  expect(en.contentHtml).not.toContain('href="deploy-remote.md');
  // The README is the site's home page.
  expect(zh.contentHtml).toMatch(/href="[^"]*\/zh"/);
  // Code blocks sit in a box the page hangs a copy button on.
  expect(en.contentHtml).toContain('<div class="codeblock"><pre>');
});

test('the Gatekeeper guide shows its screenshot from the site and links to the install section', () => {
  const zh = getDocumentContent('gatekeeper', 'zh');
  expect(zh.contentHtml).toContain('src="/docs-assets/gatekeeper-2step.png"');
  expect(zh.contentHtml).toContain(`href="/zh/overview#${encodeURIComponent('获取')}"`);
  expect(getDocumentContent('gatekeeper', 'en').contentHtml).toContain('href="/en/overview#get-it"');
  expect(publishedAssets()).toEqual(['gatekeeper-2step.png']);
});

test('no rendered page sends a link to GitHub for a file the site publishes', () => {
  const pages: { name: string; html: string }[] = [];
  for (const lang of ['zh', 'en'] as const) {
    pages.push({ name: `${lang} hub`, html: getManifestoHub(lang).preambleHtml });
    for (const topic of MANIFESTO_TOPICS) {
      pages.push({ name: `${lang} ${topic}`, html: getManifestoTopic(topic, lang).contentHtml });
    }
    for (const doc of ['roadmap', ...GUIDES] as const) {
      pages.push({ name: `${lang} ${doc}`, html: getDocumentContent(doc, lang).contentHtml });
    }
  }
  const published = new Set(PUBLISHED_SOURCES);
  const leaks: string[] = [];
  for (const { name, html } of pages) {
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (!href.startsWith(`${GITHUB_BLOB_MAIN}/`)) continue;
      const file = href.slice(GITHUB_BLOB_MAIN.length + 1).split('#')[0];
      if (published.has(file)) leaks.push(`${name}: ${href}`);
    }
  }
  expect(leaks).toEqual([]);
});

test('the search index has a section per term and per guide heading', () => {
  const zh = getSearchIndex('zh');
  const handoff = zh.find((e) => e.href === '/manifesto/collaboration#term-handoff');
  expect(handoff?.title).toBe('交接（Handoff）');
  expect(handoff?.page).toBe('协作');
  expect(handoff?.text).not.toContain('<');
  expect(zh.some((e) => e.href.startsWith('/gatekeeper#') && e.text.includes('xattr'))).toBe(true);
  expect(zh.some((e) => e.href.startsWith('/windows'))).toBe(true);
  // Behavior details are searchable under their term.
  expect(zh.find((e) => e.href === '/manifesto/collaboration#term-plan')?.text).toContain('task_id');
  const en = getSearchIndex('en');
  expect(en.find((e) => e.href === '/manifesto/people#term-user')?.title).toBe('User');
  expect(new Set(en.map((e) => e.href)).size).toBe(en.length);
});

const CJK = /[㐀-鿿　-〿！-～]/;
/**
 * What a reader sees of the entries themselves; the folded behavior details quote a few literal
 * strings the daemon writes in Chinese (`附件：path`).
 */
const text = (html: string) =>
  html.replace(/<details class="behavior"[\s\S]*?<\/details>/g, ' ').replace(/<[^>]*>/g, ' ');

test('the English manifesto reads CONTEXT.en.md, with the Chinese pages\' anchors', () => {
  const hub = getManifestoHub('en');
  expect(hub.preambleHtml).toContain('WIP');
  expect(text(hub.preambleHtml)).not.toMatch(CJK);
  expect(hub.index.flatMap((e) => e.terms.map((t) => t.name)).join(' ')).not.toMatch(CJK);
  const zhIds = getManifestoHub('zh').index.map((e) => e.terms.map((t) => t.id));
  expect(hub.index.map((e) => e.terms.map((t) => t.id))).toEqual(zhIds);

  for (const topic of MANIFESTO_TOPICS) {
    const en = getManifestoTopic(topic, 'en');
    const zh = getManifestoTopic(topic, 'zh');
    expect(text(en.contentHtml)).not.toMatch(CJK);
    // Same entries under the same ids, so the language switch keeps a term's #hash.
    expect(en.toc.map((e) => e.id)).toEqual(zh.toc.map((e) => e.id));
    // And the ids are plain ASCII, so a shared link reads as it looks.
    expect(en.toc.every((e) => /^term-[a-z0-9-]+$/.test(e.id))).toBe(true);
  }
  const people = getManifestoTopic('people', 'en');
  expect(people.toc.find((e) => e.id === 'term-user')?.text).toBe('User');
  expect(people.contentHtml).toContain('class="avoid"');
});

test('the English roadmap reads ROADMAP.en.md', () => {
  expect(documentSource('roadmap', 'en')).toBe('ROADMAP.en.md');
  expect(documentSource('roadmap', 'zh')).toBe('ROADMAP.md');
  const en = getDocumentContent('roadmap', 'en');
  const zh = getDocumentContent('roadmap', 'zh');
  expect(en.title).toBe('Roadmap');
  expect(text(en.contentHtml)).not.toMatch(CJK);
  expect(en.toc.map((e) => e.level)).toEqual(zh.toc.map((e) => e.level));
  // The other-language line is the site's language switch.
  expect(zh.contentHtml).not.toContain('>English<');
});
