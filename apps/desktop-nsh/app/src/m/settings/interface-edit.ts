import type { InterfacePatch, InterfaceResponse } from '@real-bot/protocol';
import { ApiError } from '../api.ts';
import type { MessengerRuntime } from '../runtime.svelte.ts';
import { showToast } from '../toast.svelte.ts';

/** One sitting of Settings › 界面: its saves to the stylesheet fold into one change in the history. */
export function newSitting(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${Date.now()}`;
}

export type EditResult = { ok: true; state: InterfaceResponse } | { ok: false; status: number; message: string };

/** Sends a change to the profile; says why not instead of throwing. */
export async function editInterface(
	runtime: MessengerRuntime,
	patch: InterfacePatch,
	extra: { if_revision?: string | null; edit_session?: string } = {}
): Promise<EditResult> {
	const api = runtime.client;
	if (!api) return { ok: false, status: 0, message: '' };
	try {
		return { ok: true, state: await api.patchInterface({ patch, ...extra }) };
	} catch (error) {
		if (error instanceof ApiError) return { ok: false, status: error.status, message: error.message };
		return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
	}
}

/** A change made from a switch or a button, where a failure is a toast. */
export async function editInterfaceOrToast(runtime: MessengerRuntime, patch: InterfacePatch): Promise<boolean> {
	const result = await editInterface(runtime, patch);
	if (!result.ok && result.message) showToast(result.message, { tone: 'error' });
	return result.ok;
}
