import { afterEach, expect, test } from 'bun:test';
import { closeFullscreenPreview, holdFullscreenPreview } from './fullscreen-preview.ts';

const releases: Array<() => void> = [];
afterEach(() => { while (releases.length) releases.pop()!(); });

test('Back consumes the newest full-screen preview once', () => {
  const closed: string[] = [];
  releases.push(holdFullscreenPreview(() => closed.push('first')));
  releases.push(holdFullscreenPreview(() => closed.push('second')));
  expect(closeFullscreenPreview()).toBe(true);
  expect(closed).toEqual(['second']);
  expect(closeFullscreenPreview()).toBe(true);
  expect(closed).toEqual(['second', 'first']);
  expect(closeFullscreenPreview()).toBe(false);
});

test('leaving full screen releases only that preview, and cleanup is idempotent', () => {
  const closed: string[] = [];
  const first = holdFullscreenPreview(() => closed.push('first'));
  const second = holdFullscreenPreview(() => closed.push('second'));
  releases.push(first, second);
  first(); first();
  expect(closeFullscreenPreview()).toBe(true);
  second();
  expect(closeFullscreenPreview()).toBe(false);
  expect(closed).toEqual(['second']);
});
