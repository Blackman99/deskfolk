<script lang="ts">
	/** A Bot's change to your interface waiting on a card (ADR 0106): what it changes, a way to try it here, and once allowed, its Undo. */
	import type { Approval, InterfaceRevisionHead } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { interfaceController } from '../interface/controller.svelte.ts';
	import { parseInterfaceCard } from './interface-card.ts';

	interface Props {
		/** The card's text, as the daemon wrote it. */
		body: string;
		t: Copy;
		approval: Approval | null;
		api: MessengerApi | null;
		/** The newest changes (the snapshot's), to find the one this card let through. */
		recent: readonly InterfaceRevisionHead[];
	}

	let { body, t, approval, api, recent }: Props = $props();
	const c = $derived(t.ui.card);
	const chip = $derived(t.ui.chip);
	const card = $derived(parseInterfaceCard(body));
	const approvalId = $derived(approval?.id ?? null);
	const pending = $derived(approval?.status === 'pending');
	const trying = $derived(approvalId !== null && interfaceController.trying?.approvalId === approvalId);
	const canTry = $derived(pending && (card.patch !== null || card.restore !== null));

	let cannotTry = $state(false);
	let undone = $state(false);
	let undoFailed = $state(false);
	let busy = $state(false);

	const head = $derived(approvalId ? recent.find((row) => row.approval_id === approvalId) : undefined);

	async function tryHere(): Promise<void> {
		if (!approvalId) return;
		cannotTry = false;
		if (card.restore) {
			if (!api) {
				cannotTry = true;
				return;
			}
			try {
				const revision = await api.getInterfaceRevision(card.restore);
				interfaceController.tryProfile(approvalId, revision.after.profile);
			} catch {
				cannotTry = true;
			}
			return;
		}
		if (card.patch && !interfaceController.tryPatch(approvalId, card.patch)) cannotTry = true;
	}

	// Decided, or gone from the page: this window goes back to what it showed.
	$effect(() => {
		if (!pending && trying) interfaceController.stopTrying();
	});
	$effect(() => {
		const id = approvalId;
		return () => {
			if (id && interfaceController.trying?.approvalId === id) interfaceController.stopTrying();
		};
	});

	async function undo(): Promise<void> {
		if (!api || !head || busy) return;
		busy = true;
		try {
			await api.undoInterfaceRevision(head.id);
			undone = true;
		} catch {
			undoFailed = true;
		} finally {
			busy = false;
		}
	}
</script>

<div class="interface-card">
	<p class="interface-card-head">{c.head}</p>
	{#if card.reason}<p class="interface-card-reason">{card.reason}</p>{/if}
	{#if card.changes.length}
		<ul class="interface-card-changes">
			{#each card.changes as change, n (n)}<li>{change}</li>{/each}
		</ul>
	{/if}
	{#if canTry}
		<div class="interface-card-acts">
			{#if trying}
				<span class="interface-card-note">{c.trying}</span>
				<button type="button" class="interface-card-link" onclick={() => interfaceController.stopTrying()}>{c.stopTrying}</button>
			{:else}
				<button type="button" class="interface-card-link" onclick={() => void tryHere()}>{c.tryHere}</button>
			{/if}
			{#if cannotTry}<span class="interface-card-note">{c.cannotTry}</span>{/if}
		</div>
	{/if}
	{#if approval?.status === 'allowed_once'}
		{#if undone}
			<p class="interface-card-note">{chip.undone}</p>
		{:else if undoFailed}
			<p class="interface-card-note">{chip.cannotUndo}</p>
		{:else if head?.undoable}
			<div class="interface-card-acts">
				<button type="button" class="interface-card-link" data-floor="interface-undo" disabled={busy} onclick={() => void undo()}>{chip.undo}</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.interface-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		font-size: 13px;
	}

	.interface-card-head {
		margin: 0;
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.interface-card-reason,
	.interface-card-note {
		margin: 0;
		font-size: 12px;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.interface-card-changes {
		margin: 0;
		padding: 4px 6px 4px 22px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink);
	}

	.interface-card-changes li {
		overflow-wrap: anywhere;
	}

	.interface-card-acts {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-top: 2px;
	}

	.interface-card-link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.interface-card-link:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
