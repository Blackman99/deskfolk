import type { Locale, PromptGroup, PromptLocaleState, PromptRevision, PromptSummary } from '@real-bot/protocol';
import type { Copy } from '../copy.ts';

type PromptsCopy = Copy['prompts'];

/** What the editor shows: the text you edit, what it changes from the default, or every change so far. */
export type PromptView = 'text' | 'compare' | 'history';

/** The order the settings tab lists them in: the tool descriptions last, since there are fifty of them. */
export const PROMPT_GROUPS: readonly PromptGroup[] = ['turn', 'agent', 'call', 'tool'];

/**
 * The prompts that match a search (id, title or summary, either language), and only the edited ones
 * when asked, by group in the tab's order; each group keeps the registry's order.
 */
export function groupPrompts(items: readonly PromptSummary[], query: string, onlyEdited = false): Array<{ group: PromptGroup; items: PromptSummary[] }> {
	const q = query.trim().toLowerCase();
	const hits = items.filter(
		(item) =>
			(!onlyEdited || overallState(item) !== 'default') &&
			(!q || [item.id, item.title.zh, item.title.en, item.summary.zh, item.summary.en].some((text) => text.toLowerCase().includes(q)))
	);
	return PROMPT_GROUPS.map((group) => ({ group, items: hits.filter((item) => item.group === group) })).filter((row) => row.items.length > 0);
}

/** One prompt's state across its languages: a conflict in any, else an edit in any, else the default. */
export function overallState(item: PromptSummary): PromptLocaleState['state'] {
	if (item.locales.some((locale) => locale.state === 'conflict')) return 'conflict';
	if (item.locales.some((locale) => locale.state === 'edited')) return 'edited';
	return 'default';
}

/** Answers that did not read, over its languages: since your edit, or in the last 7 days on a default. */
export function failuresOf(item: Pick<PromptSummary, 'locales'>): number {
	return item.locales.reduce((sum, state) => sum + (state.parse_failures ? (state.parse_failures.since_edit ?? state.parse_failures.last_7_days) : 0), 0);
}

/** How many prompts are edited, and whether any has a newer default it did not merge with, for the tab. */
export function editedCount(items: readonly PromptSummary[]): { edited: number; conflict: boolean } {
	return {
		edited: items.filter((item) => overallState(item) !== 'default').length,
		conflict: items.some((item) => overallState(item) === 'conflict'),
	};
}

/** Who made a change, in words: you, a named Bot, or the app merging a newer default. */
export function changedBy(actor: PromptRevision['actor'] | null, botName: string | null, c: PromptsCopy): string {
	if (actor === 'app') return c.app;
	if (actor === 'bot') return botName ?? c.aBot;
	return c.you;
}

/** The chip on a row or a language: default, edited by whom, or a newer default in conflict. */
export function stateChip(state: PromptLocaleState, botName: string | null, c: PromptsCopy): { tone: 'default' | 'edited' | 'conflict'; label: string } {
	if (state.state === 'conflict') return { tone: 'conflict', label: c.state.conflict };
	if (state.state === 'edited') return { tone: 'edited', label: `${c.state.edited} · ${c.editedBy(changedBy(state.last_actor, botName, c))}` };
	return { tone: 'default', label: c.state.default };
}

/** The language shown first: the app's when the prompt has it, else its only one. */
export function firstLocale(item: Pick<PromptSummary, 'locales'>, ui: Locale): Locale {
	return item.locales.some((state) => state.locale === ui) ? ui : item.locales[0]!.locale;
}

/**
 * What a refused save means, in words. The daemon answers 422 with the first problem's code and every
 * problem as `code[:detail]; …` in the message (prompts/book.ts).
 */
export function promptErrorText(error: unknown, c: PromptsCopy): string {
	const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
	const message = error instanceof Error ? error.message : '';
	const lines = message
		.split('; ')
		.map((part) => {
			const at = part.indexOf(':');
			const name = at === -1 ? part : part.slice(0, at);
			const detail = at === -1 ? '' : part.slice(at + 1);
			return { name, detail };
		})
		.filter((part) => part.name.startsWith('prompt_') || part.name === 'changed_since');
	const first = lines[0] ?? { name: code, detail: '' };
	const errors = c.errors as Record<string, string | ((detail: string) => string)>;
	const entry = errors[first.name] ?? errors[code];
	if (typeof entry === 'function') return entry(first.detail);
	if (typeof entry === 'string') return entry;
	return c.errors.other;
}

export type PromptCardHunk = { title: string; lines: Array<{ kind: 'del' | 'add'; text: string }> };

/**
 * The approval card's body (prompt-tools.ts `promptEditSummary`): a head line, a reason line, then
 * each change as `@@ …` with its `- ` / `+ ` lines, and possibly a closing "… more" line.
 */
export function parsePromptCard(body: string): { head: string; reason: string; reach: string | null; hunks: PromptCardHunk[]; more: string | null } {
	const lines = body.split('\n');
	const head = lines[0] ?? '';
	const reason = lines[1] ?? '';
	const hunks: PromptCardHunk[] = [];
	let reach: string | null = null;
	let more: string | null = null;
	for (const line of lines.slice(2)) {
		// Who the change reaches, said before the first change; a card from before it says nothing here.
		if (!hunks.length && (line.startsWith('影响：') || line.startsWith('Reach: '))) reach = line;
		else if (line.startsWith('@@ ')) hunks.push({ title: line.slice(3), lines: [] });
		else if (line.startsWith('- ') && hunks.length) hunks.at(-1)!.lines.push({ kind: 'del', text: line.slice(2) });
		else if (line.startsWith('+ ') && hunks.length) hunks.at(-1)!.lines.push({ kind: 'add', text: line.slice(2) });
		else if (line.startsWith('…')) more = line;
	}
	return { head, reason, reach, hunks, more };
}
