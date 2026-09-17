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
  parseContextMarkdown,
  termAnchorId,
  termKey
} from './docs';

const CONTEXT_PATH = path.resolve(import.meta.dir, '../../../../CONTEXT.md');

test('parseContextMarkdown reads every glossary term from CONTEXT.md', () => {
  const raw = fs.readFileSync(CONTEXT_PATH, 'utf-8');
  const { preamble, terms } = parseContextMarkdown(raw);

  expect(preamble).toContain('# Real Bot');
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
});

test('docs paths and pager walk the sidebar order', () => {
  expect(docsPath('manifesto')).toBe('/manifesto');
  expect(docsPath('people')).toBe('/manifesto/people');
  expect(docsPath('roadmap')).toBe('/roadmap');

  const flat = DOCS_NAV.flatMap((g) => g.pages);
  expect(flat[0]).toBe('manifesto');
  expect(flat[flat.length - 1]).toBe('roadmap');
  expect(docsNeighbors('manifesto')).toEqual({ next: 'people' });
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
