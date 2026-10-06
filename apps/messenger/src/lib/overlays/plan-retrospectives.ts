import type { Retrospective, RetrospectiveChange } from '@real-bot/protocol';
import type { Copy } from '../copy.ts';

type RetroCopy = Copy['plan']['retrospective'];

/** What one change did, in a line: a new memory, a memory rewritten or deleted, a skill changed or made. */
export function changeTitle(change: RetrospectiveChange, c: RetroCopy): string {
	if (change.kind === 'memory') {
		if (change.op === 'forget') return c.change.memoryForget(change.label);
		return change.before ? c.change.memoryRewrite(change.label) : c.change.memoryNew(change.label);
	}
	return change.op === 'create' ? c.change.skillCreate(change.label) : c.change.skillEdit(change.label);
}

/** Why a change was not made, from the daemon's code (`RetrospectiveChange.reason`) to your language. */
export function reasonText(reason: string | undefined, c: RetroCopy): string {
	if (!reason) return c.reason.refused;
	const [code, ...rest] = reason.split(':');
	const n = Number(rest[0]);
	switch (code) {
		case 'off':
		case 'full':
		case 'over_cap':
		case 'unchanged':
		case 'missing':
		case 'project_skill':
		case 'name_taken':
		case 'project_name':
		case 'too_long':
		case 'required':
			return c.reason[code];
		case 'edit_missing':
			return c.reason.edit_missing(n);
		case 'edit_repeated':
			return c.reason.edit_repeated(n, Number(rest[1]));
		case 'edit_not_one_sentence':
			return c.reason.edit_not_one_sentence(n);
		case 'edit_unread':
			return c.reason.edit_unread(n);
		case 'drops':
			// The names keep any colon of their own: only the code is split off.
			return c.reason.drops(reason.slice('drops:'.length));
		default:
			return c.reason.refused;
	}
}

/** Why a retrospective did not run, from its note. */
export function failedText(note: string | null, c: RetroCopy): string {
	switch (note) {
		case 'call_failed':
		case 'truncated':
		case 'unreadable':
		case 'interrupted':
		case 'no_model':
			return c.failed[note];
		default:
			return c.failed.other;
	}
}

export type DiffLine = { kind: 'same' | 'del' | 'add' | 'gap'; text: string };

/**
 * A skill's body before and after, line by line: what was taken out, what was put in, and a gap
 * mark where unchanged lines were left out. A longest-common-subsequence over lines — a skill is a
 * few dozen of them, so the table stays small.
 */
export function changedLines(before: string, after: string): DiffLine[] {
	const a = before.split('\n');
	const b = after.split('\n');
	const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}
	const all: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			all.push({ kind: 'same', text: a[i]! });
			i += 1;
			j += 1;
		} else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
			all.push({ kind: 'del', text: a[i]! });
			i += 1;
		} else {
			all.push({ kind: 'add', text: b[j]! });
			j += 1;
		}
	}
	while (i < a.length) all.push({ kind: 'del', text: a[i++]! });
	while (j < b.length) all.push({ kind: 'add', text: b[j++]! });
	// Only what changed, with one gap mark for every run of unchanged lines between the changes.
	const out: DiffLine[] = [];
	for (const line of all) {
		if (line.kind !== 'same') out.push(line);
		else if (out.length > 0 && out[out.length - 1]!.kind !== 'gap') out.push({ kind: 'gap', text: '' });
	}
	while (out.length > 0 && out[out.length - 1]!.kind === 'gap') out.pop();
	return out;
}

/** The retrospectives a board shows, oldest first: running, done or failed — never one set aside. */
export function shownRetrospectives(list: readonly Retrospective[] | undefined): Retrospective[] {
	return [...(list ?? [])].sort((x, y) => x.created_at.localeCompare(y.created_at));
}
