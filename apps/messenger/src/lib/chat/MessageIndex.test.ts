import { expect, test } from 'bun:test';
import { flushSync, tick } from 'svelte';
import { render } from '../test-render.ts';
import MessageIndex from './MessageIndex.svelte';
import { messageIndexMarks } from './message-index.ts';
import { aMessage } from '../test-fixtures.ts';

const marks = messageIndexMarks(['user', 'bot', 'ask', 'approval', 'system'].map((kind, i) => ({
  type: 'message' as const, message: aMessage({ id: `m${i}`, kind: kind as 'user', body: `preview ${i}` }),
})));
function mountIndex() {
  const jumps: string[] = [];
  const result = render(MessageIndex, {
    marks, activeId: 'm0', locale: 'en', label: 'Message index', emptyLabel: 'No text',
    sender: (mark) => mark.kind === 'user' ? 'You' : 'Alpha',
    onJump: (mark) => jumps.push(mark.id),
  });
  return { ...result, jumps };
}

test('focus previews a Bot message and clicking its floating preview jumps there', () => {
  const { host, close, jumps } = mountIndex();
  expect(host.querySelector('.message-index-card')).toBeNull();
  const entry = host.querySelector<HTMLButtonElement>('[data-index-id="m1"]')!;
  entry.focus();
  flushSync();
  const card = host.querySelector<HTMLButtonElement>('.message-index-card')!;
  expect(card.textContent).toContain('preview 1');
  expect(card.textContent).toContain('Alpha');
  card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  expect(jumps).toEqual(['m1']);
  expect(host.querySelector('.message-index-card')).toBeNull();
  close();
});

test('keyboard previews adjacent messages and Enter uses the focused anchor', () => {
  const { host, close, jumps } = mountIndex();
  const entry = host.querySelector<HTMLButtonElement>('[data-index-id="m0"]')!;
  entry.focus();
  entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  flushSync();
  expect(document.activeElement?.getAttribute('data-index-id')).toBe('m1');
  expect(jumps).toEqual([]);
  document.activeElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  expect(jumps).toEqual(['m1']);
  close();
});

test('brief pointer crossings never open the preview', async () => {
  const { host, close } = mountIndex();
  const entry = host.querySelector<HTMLButtonElement>('[data-index-id="m0"]')!;
  entry.dispatchEvent(new PointerEvent('pointerenter'));
  entry.dispatchEvent(new PointerEvent('pointerleave'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  await tick();
  expect(host.querySelector('.message-index-card')).toBeNull();
  close();
});
