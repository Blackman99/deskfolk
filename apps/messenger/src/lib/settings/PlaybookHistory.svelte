<script lang="ts">
	import type { Playbook, PlaybookRevision } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp } from '../chat/chat-view.ts';
	import type { Playbooks } from './playbooks.svelte.ts';

	/**
	 * One engine's history beside the map on a wide window, in the picked step's place (ADR 0085):
	 * every change, newest first, never rewritten. Read again when the engine changes; picking a
	 * step, or ✕, goes back to the step.
	 */
	interface Props {
		playbooks: Playbooks;
		playbook: Playbook;
		name: string;
		onclose: () => void;
		t: Copy;
	}

	let { playbooks, playbook, name, onclose, t }: Props = $props();
	const c = $derived(t.playbooks);

	let rows = $state<PlaybookRevision[] | null>(null);
	$effect(() => {
		const id = playbook.id;
		void playbook.revision;
		void playbooks.revisions(id).then((read) => {
			if (playbook.id === id) rows = read;
		});
	});
</script>

<section class="playbook-history-card" aria-label={c.historyOf(name)} data-playbook-history-of={playbook.id}>
	<div class="playbook-history-head">
		<h3 class="playbook-history-title">{c.historyOf(name)}</h3>
		<button type="button" class="playbook-history-close" title={t.common.close} aria-label={t.common.close} data-playbook-history-close onclick={onclose}>
			<Icon name="x" size={12} />
		</button>
	</div>
	{#if rows}
		<ol class="playbook-history" data-playbook-history>
			{#each rows as row (row.id)}
				<li>
					<span class="playbook-history-op">{c.historyOp[row.op]}</span>
					<span>{c.historyBy(row.actor)}</span>
					<span class="playbook-history-at mono">{formatFullTimestamp(row.created_at)}</span>
					<span class="playbook-history-rev">{c.revision(row.revision)}</span>
				</li>
			{:else}
				<li class="playbook-history-empty">{c.historyEmpty}</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.playbook-history-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.playbook-history-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.playbook-history-title {
		margin: 0;
		min-width: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.playbook-history-close {
		display: grid;
		place-items: center;
		flex: none;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.playbook-history-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.playbook-history-close:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.playbook-history {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 12px;
	}

	.playbook-history li {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		padding-top: 6px;
		border-top: 1px solid var(--line-subtle);
	}

	.playbook-history li:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.playbook-history-op {
		font-weight: 600;
	}

	.playbook-history-at,
	.playbook-history-rev,
	.playbook-history-empty {
		color: var(--muted);
	}
</style>
