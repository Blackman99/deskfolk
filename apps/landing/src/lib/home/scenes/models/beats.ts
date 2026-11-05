import type { Lang } from '$lib/i18n';
import { clamp } from '../../motion';

/**
 * The models scene's facts and its scripted run: which sockets exist and what they are called,
 * where the plug is at each point of the scroll, and how an endpoint address is checked. Plain
 * functions, tested next to this file.
 */

export const AGENT_IDS = ['claude', 'codex', 'grok', 'opencode', 'antigravity', 'zcode'] as const;
export const ENDPOINT_IDS = ['anthropic', 'deepseek', 'qwen', 'mimo', 'openrouter', 'ollama'] as const;

export type SocketId = (typeof AGENT_IDS)[number] | (typeof ENDPOINT_IDS)[number] | 'custom';

/** Every socket in reading order: the local agents, the endpoints, then the custom one. */
export const ALL_IDS: SocketId[] = [...AGENT_IDS, ...ENDPOINT_IDS, 'custom'];

export function isAgent(id: SocketId): boolean {
  return (AGENT_IDS as readonly string[]).includes(id);
}

const SAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  zcode: 'ZCode',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  ollama: 'Ollama'
};

/** Product names stay the same in both languages except Qwen and MiMo. */
export const NAMES: Record<Lang, Record<string, string>> = {
  zh: { ...SAME, qwen: '千问', mimo: '小米 MiMo' },
  en: { ...SAME, qwen: 'Qwen', mimo: 'Xiaomi MiMo' }
};

export const EXAMPLE_URL = 'https://api.example.com/v1';

/** The scripted run is driven from these scroll marks. */
export const MARKS = { claude: 0.12, codex: 0.32, deepseek: 0.5, ladder: 0.6, ollama: 0.66, custom: 0.8, typed: 0.9, submit: 0.92 };

export type Auto = {
  /** The socket the plug is at, or null while it dangles. */
  target: SocketId | null;
  /** How many characters of the example address are typed. */
  typed: number;
  /** The Custom form has been submitted. */
  submit: boolean;
  /** The ladder marker's rung. */
  rung: 0 | 1;
};

export function autoState(p: number): Auto {
  let target: SocketId | null = null;
  if (p >= MARKS.custom) target = 'custom';
  else if (p >= MARKS.ollama) target = 'ollama';
  else if (p >= MARKS.deepseek) target = 'deepseek';
  else if (p >= MARKS.codex) target = 'codex';
  else if (p >= MARKS.claude) target = 'claude';
  const k = clamp((p - MARKS.custom) / (MARKS.typed - MARKS.custom));
  return {
    target,
    typed: Math.round(k * EXAMPLE_URL.length),
    submit: p >= MARKS.submit,
    rung: p >= MARKS.ladder ? 1 : 0
  };
}

/** The address as the form reads it: http(s) only, with a host. Null when it is not one. */
export function parseEndpoint(raw: string): { host: string } | null {
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return { host: u.host };
  } catch {
    return null;
  }
}
