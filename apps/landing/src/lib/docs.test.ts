import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOCS_NAV,
  MANIFESTO_TOPICS,
  TERM_GROUPS,
  assignTermGroup,
  docsNeighbors,
  docsPath,
  groupTerms,
  legacyTermAnchorId,
  parseContextMarkdown,
  resolveTermHash,
  termAnchorId,
  termKey
} from './docs';

const CONTEXT_PATH = path.resolve(import.meta.dir, '../../../../CONTEXT.md');
const CONTEXT_EN_PATH = path.resolve(import.meta.dir, '../../../../CONTEXT.en.md');

test('parseContextMarkdown reads every glossary term from CONTEXT.md', () => {
  const raw = fs.readFileSync(CONTEXT_PATH, 'utf-8');
  const { preamble, terms } = parseContextMarkdown(raw);

  expect(preamble).toContain('# Deskfolk');
  expect(preamble).toContain('WIP');
  expect(terms.length).toBeGreaterThan(40);

  const names = terms.map((t) => t.name);
  expect(names[0]).toBe('Bot');
  expect(names).toContain('用户');
  expect(names).toContain('向导');
  expect(names).toContain('判断日志（Judgement log）');
  expect(new Set(names).size).toBe(names.length);
});

test('every CONTEXT.md term is assigned to exactly one manifesto topic', () => {
  const raw = fs.readFileSync(CONTEXT_PATH, 'utf-8');
  const { terms } = parseContextMarkdown(raw);
  const seen = new Map<string, string>();

  for (const term of terms) {
    const topic = assignTermGroup(term.name);
    expect(MANIFESTO_TOPICS).toContain(topic);
    const id = termAnchorId(term.name);
    expect(seen.has(id)).toBe(false);
    seen.set(id, term.name);
  }

  const assignedKeys = new Set(terms.map((t) => t.key.toLowerCase()));
  for (const topic of MANIFESTO_TOPICS) {
    for (const key of TERM_GROUPS[topic]) {
      expect(assignedKeys.has(key.toLowerCase())).toBe(true);
    }
  }
});

test('termKey prefers the English parenthetical', () => {
  expect(termKey('名册（Roster）')).toBe('Roster');
  expect(termKey('窗口（App window）')).toBe('App window');
  expect(termKey('用户')).toBe('用户');
  expect(termKey('Always allow')).toBe('Always allow');
  // The English edition's names for the two terms CONTEXT.md writes in Chinese alone.
  expect(termKey('User')).toBe('用户');
  expect(termKey('Setup wizard')).toBe('向导');
});

test('CONTEXT.en.md has the same terms as CONTEXT.md, in the same order, in English', () => {
  const zh = parseContextMarkdown(fs.readFileSync(CONTEXT_PATH, 'utf-8'));
  const en = parseContextMarkdown(fs.readFileSync(CONTEXT_EN_PATH, 'utf-8'));
  // A term added to or dropped from one edition has to be added to or dropped from the other.
  expect(en.terms.map((t) => t.key)).toEqual(zh.terms.map((t) => t.key));
  for (const term of en.terms) expect(MANIFESTO_TOPICS).toContain(assignTermGroup(term.name));
  expect(en.preamble).toContain('# Deskfolk');
  expect(en.preamble).toContain('WIP');
  // Nothing left in Chinese past the title's link back to the Chinese edition.
  const body = fs.readFileSync(CONTEXT_EN_PATH, 'utf-8').replace(/^#.*\n+\[[^\]]+\]\(CONTEXT\.md\)\n/, '');
  expect(body.match(/[\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+/g)).toBeNull();
});

test('term anchors come from the English name, the same in both editions', () => {
  expect(termAnchorId('交接（Handoff）')).toBe('term-handoff');
  expect(termAnchorId('Handoff')).toBe('term-handoff');
  expect(termAnchorId('判断日志（Judgement log）')).toBe('term-judgement-log');
  expect(termAnchorId('用户')).toBe('term-user');
  expect(termAnchorId('User')).toBe('term-user');
  expect(termAnchorId('向导')).toBe('term-setup-wizard');
  expect(termAnchorId('Setup wizard')).toBe('term-setup-wizard');
  expect(termAnchorId('Always allow')).toBe('term-always-allow');
  // What links from before the rename carry.
  expect(legacyTermAnchorId('交接（Handoff）')).toBe('term-交接handoff');
  expect(legacyTermAnchorId('Bot')).toBe('term-bot');
});

test('a glossary hash resolves bare, prefixed and pre-rename anchors', () => {
  const targets = { 'term-handoff': '/manifesto/collaboration' };
  const aliases = { 'term-交接handoff': 'term-handoff' };
  const hit = { id: 'term-handoff', path: '/manifesto/collaboration' };
  expect(resolveTermHash('#term-handoff', targets, aliases)).toEqual(hit);
  expect(resolveTermHash('#handoff', targets, aliases)).toEqual(hit);
  expect(resolveTermHash(`#${encodeURIComponent('term-交接handoff')}`, targets, aliases)).toEqual(hit);
  expect(resolveTermHash('#people', targets, aliases)).toBeNull();
  expect(resolveTermHash('', targets, aliases)).toBeNull();
  expect(resolveTermHash('#term-%E4', targets, aliases)).toBeNull();
});

test('docs paths and pager walk the sidebar order', () => {
  expect(docsPath('docs')).toBe('/docs');
  expect(docsPath('gatekeeper')).toBe('/gatekeeper');
  expect(docsPath('manifesto')).toBe('/manifesto');
  expect(docsPath('people')).toBe('/manifesto/people');
  expect(docsPath('roadmap')).toBe('/roadmap');
  expect(docsPath('remote')).toBe('/remote');

  const flat = DOCS_NAV.flatMap((g) => g.pages);
  expect(flat[0]).toBe('docs');
  expect(flat[flat.length - 1]).toBe('roadmap');
  expect(new Set(flat).size).toBe(flat.length);
  expect(docsNeighbors('docs')).toEqual({ next: 'overview' });
  expect(docsNeighbors('gatekeeper')).toEqual({ prev: 'overview', next: 'windows' });
  expect(docsNeighbors('remote')).toEqual({ prev: 'spend', next: 'manifesto' });
  expect(docsNeighbors('manifesto')).toEqual({ prev: 'remote', next: 'people' });
  expect(docsNeighbors('roadmap')).toEqual({ prev: 'safety' });
  expect(docsNeighbors('conversations')).toEqual({ prev: 'people', next: 'collaboration' });
});

test('groupTerms follows TERM_GROUPS order, not source order', () => {
  const raw = fs.readFileSync(CONTEXT_PATH, 'utf-8');
  const { terms } = parseContextMarkdown(raw);
  const grouped = groupTerms(terms);
  expect(grouped.people.map((t) => t.key)).toEqual([...TERM_GROUPS.people]);
  expect(grouped.safety.map((t) => t.key)).toEqual([...TERM_GROUPS.safety]);
});
