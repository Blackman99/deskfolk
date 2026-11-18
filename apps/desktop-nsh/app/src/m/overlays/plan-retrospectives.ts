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

export { changedLines, type DiffLine } from '@real-bot/protocol';

/** The retrospectives a board shows, oldest first: running, done or failed — never one set aside. */
export function shownRetrospectives(list: readonly Retrospective[] | undefined): Retrospective[] {
	return [...(list ?? [])].sort((x, y) => x.created_at.localeCompare(y.created_at));
}
