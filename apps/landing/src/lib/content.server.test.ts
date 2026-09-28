import { expect, test } from 'bun:test';
import { documentSource, getDocumentContent, getManifestoHub, getManifestoTopic, getTermTargets } from './content.server';
import { MANIFESTO_TOPICS, termAnchorId } from './docs';

test('manifesto hub lists every topic with its terms', () => {
  const hub = getManifestoHub('zh');
  expect(hub.preambleHtml).toContain('WIP');
  expect(hub.preambleHtml).not.toContain('id="language"');
  expect(hub.index.map((e) => e.topic)).toEqual([...MANIFESTO_TOPICS]);
  expect(hub.index.every((e) => e.terms.length > 0)).toBe(true);
  const people = hub.index.find((e) => e.topic === 'people');
  expect(people?.terms.some((t) => t.name === 'Bot' && t.id === 'term-bot')).toBe(true);
});

test('a topic page renders term headings and avoid lines', () => {
  const doc = getManifestoTopic('people', 'zh');
  expect(doc.contentHtml).toContain('id="term-bot"');
  expect(doc.contentHtml).toContain('id="term-用户"');
  expect(doc.toc[0]).toEqual({ id: 'term-bot', text: 'Bot', level: 2 });
  expect(doc.contentHtml).toContain('class="avoid"');
});

test('term targets send glossary hashes to the topic page', () => {
  const targets = getTermTargets();
  expect(targets[termAnchorId('Bot')]).toBe('/manifesto/people');
  expect(targets[termAnchorId('群（Group）')]).toBe('/manifesto/conversations');
  expect(targets[termAnchorId('Always allow')]).toBe('/manifesto/safety');
});

test('roadmap still has a heading toc', () => {
  const doc = getDocumentContent('roadmap', 'zh');
  expect(doc.title).toBe('Roadmap');
  expect(doc.toc.length).toBeGreaterThan(1);
  expect(doc.toc.some((e) => e.level === 2)).toBe(true);
  expect(doc.contentHtml).toContain('href=');
});

test('the remote-access guide renders per language, with its links resolved from docs/', () => {
  const zh = getDocumentContent('remote', 'zh');
  const en = getDocumentContent('remote', 'en');
  expect(zh.title).toBe('远程访问（实验性）');
  expect(en.title).toBe('Remote access (experimental)');
  expect(en.toc.some((e) => e.text === '3. Pair a phone')).toBe(true);
  // The other-language line is the site's language switch now.
  expect(en.contentHtml).not.toContain('简体中文');
  expect(zh.contentHtml).not.toContain('>English<');
  // Sibling docs, parent-directory files and anchors point at the repository on GitHub.
  expect(en.contentHtml).toContain('href="https://github.com/Blackman99/deskfolk/blob/main/docs/deploy-remote.md#web-push-proxy"');
  expect(en.contentHtml).toContain('href="https://github.com/Blackman99/deskfolk/blob/main/deploy/remote/Caddyfile"');
  expect(en.contentHtml).not.toContain('href="deploy-remote.md');
  // The README is the site's home page.
  expect(zh.contentHtml).toMatch(/href="[^"]*\/zh"/);
});

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]/;
/** What a reader sees: the ids and links keep the Chinese glossary's names on purpose. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ');

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
  }
  const people = getManifestoTopic('people', 'en');
  expect(people.toc.find((e) => e.id === 'term-用户')?.text).toBe('User');
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
