import { expect, test } from 'bun:test';
import { getDocumentContent, getManifestoHub, getManifestoTopic, getTermTargets } from './content.server';
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
