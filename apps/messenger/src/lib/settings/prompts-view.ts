import type { DiffLine, Locale, PromptGroup, PromptLocaleState, PromptRevision, PromptSummary } from '@real-bot/protocol';
import type { Copy } from '../copy.ts';

type PromptsCopy = Copy['prompts'];

/** What the editor shows: the text you edit, what it changes from the default, or every change so far. */
export type PromptView = 'text' | 'compare' | 'history';

/** One built-in prompt to open settings at: its editor, at the change a card let through when known. */
export type PromptTarget = { id: string; locale: Locale; revisionId: string | null };

/** The prompt a `prompt-edit` card is about, from its approval's `id:locale` target (prompt-tools.ts). */
export function promptCardTarget(target: string | null | undefined): { id: string; locale: Locale } | null {
	if (!target) return null;
	const at = target.lastIndexOf(':');
	const locale = target.slice(at + 1);
	if (at <= 0 || (locale !== 'zh' && locale !== 'en')) return null;
	return { id: target.slice(0, at), locale };
}

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

/** A prompt's mark in a list: who edited it, or the conflict; a default carries none. */
export function promptChip(item: PromptSummary, botNames: ReadonlyMap<string, string>, c: PromptsCopy): ReturnType<typeof stateChip> {
	const state = overallState(item);
	const shown = item.locales.find((locale) => locale.state === state) ?? item.locales[0]!;
	return stateChip(shown, shown.last_bot_id ? (botNames.get(shown.last_bot_id) ?? null) : null, c);
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

/** A line of a diff, and when it is one of a changed pair, the part of it that changed. */
export type MarkedLine = DiffLine & { mark?: { start: number; end: number } };

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Lines taken out and put in at one place are paired in order, and each pair marks only what differs
 * between them, past their shared start and before their shared end: a space added to a paragraph is
 * otherwise two lines that look the same. A pair with nothing in common is left whole, unless all
 * that changed is blank (a space on an empty line), which is marked so it shows.
 */
export function markChanges(lines: readonly DiffLine[]): MarkedLine[] {
	const out: MarkedLine[] = lines.map((line) => ({ ...line }));
	let at = 0;
	while (at < out.length) {
		let end = at;
		while (end < out.length && (out[end]!.kind === 'del' || out[end]!.kind === 'add')) end += 1;
		const run = out.slice(at, end);
		const dels = run.filter((line) => line.kind === 'del');
		const adds = run.filter((line) => line.kind === 'add');
		for (let k = 0; k < Math.min(dels.length, adds.length); k += 1) {
			const a = dels[k]!.text;
			const b = adds[k]!.text;
			let start = 0;
			while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
			// Never between the two halves of one character.
			if (start > 0 && isHigh(a.charCodeAt(start - 1))) start -= 1;
			let tail = 0;
			while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
			if (tail > 0 && isLow(a.charCodeAt(a.length - tail))) tail -= 1;
			const blank = !a.slice(start, a.length - tail).trim() && !b.slice(start, b.length - tail).trim();
			if (start + tail === 0 && !blank) continue;
			dels[k]!.mark = { start, end: a.length - tail };
			adds[k]!.mark = { start, end: b.length - tail };
		}
		at = Math.max(end, at + 1);
	}
	return out;
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
