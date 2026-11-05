import { describe, expect, test } from 'bun:test';
import { ALL_IDS, EXAMPLE_URL, NAMES, autoState, parseEndpoint } from './beats';

describe('autoState', () => {
  test('dangles before the first mark, then visits each socket in turn', () => {
    expect(autoState(0).target).toBeNull();
    expect(autoState(0.11).target).toBeNull();
    expect(autoState(0.12).target).toBe('claude');
    expect(autoState(0.32).target).toBe('codex');
    expect(autoState(0.5).target).toBe('deepseek');
    expect(autoState(0.66).target).toBe('ollama');
    expect(autoState(0.8).target).toBe('custom');
    expect(autoState(1).target).toBe('custom');
  });

  test('the address is typed between 0.8 and 0.9 and submitted at 0.92', () => {
    expect(autoState(0.79).typed).toBe(0);
    expect(autoState(0.85).typed).toBeGreaterThan(0);
    expect(autoState(0.85).typed).toBeLessThan(EXAMPLE_URL.length);
    expect(autoState(0.9).typed).toBe(EXAMPLE_URL.length);
    expect(autoState(0.91).submit).toBe(false);
    expect(autoState(0.92).submit).toBe(true);
  });

  test('the ladder climbs once at 0.6', () => {
    expect(autoState(0.59).rung).toBe(0);
    expect(autoState(0.6).rung).toBe(1);
  });
});

describe('parseEndpoint', () => {
  test('accepts http and https addresses and returns the host', () => {
    expect(parseEndpoint(EXAMPLE_URL)?.host).toBe('api.example.com');
    expect(parseEndpoint(' http://localhost:11434/v1 ')?.host).toBe('localhost:11434');
  });
  test('refuses everything else', () => {
    for (const bad of ['', 'api.example.com', 'ftp://x.com', 'javascript:alert(1)', 'https://']) {
      expect(parseEndpoint(bad)).toBeNull();
    }
  });
});

test('every socket has a name in both languages', () => {
  for (const id of ALL_IDS.filter((i) => i !== 'custom')) {
    expect(NAMES.zh[id]).toBeTruthy();
    expect(NAMES.en[id]).toBeTruthy();
  }
  expect(NAMES.zh.qwen).toBe('千问');
  expect(NAMES.en.mimo).toBe('Xiaomi MiMo');
});
