<script lang="ts">
	import { tick } from 'svelte';
	import type { PlaybookRevision } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp } from '../chat/chat-view.ts';
	import { playbookName, type Playbooks } from './playbooks.svelte.ts';

	/**
	 * Which engine Roles shows (ADR 0085): the three built in, then yours, the default starred. For
	 * the one shown: make it the default, make a new one from it, rename or remove one of yours, and
	 * read its history — every change, never rewritten.
	 */
	interface Props {
		playbooks: Playbooks;
		shown: string;
		onshow: (id: string) => void;
		onmakedefault: (id: string) => void;
		t: Copy;
	}

	let { playbooks, shown, onshow, onmakedefault, t }: Props = $props();
	const c = $derived(t.playbooks);
	const current = $derived(playbooks.find(shown));
	const isDefault = $derived(playbooks.defaultId === shown);

	let naming = $state<'new' | 'rename' | null>(null);
	let name = $state('');
	let removing = $state(false);
	let history = $state<PlaybookRevision[] | null>(null);
	let nameInput = $state<HTMLInputElement>();

	async function startNaming(kind: 'new' | 'rename'): Promise<void> {
		naming = kind;
		removing = false;
		name = kind === 'rename' ? (current?.name ?? '') : '';
		await tick();
		nameInput?.focus();
	}

	async function submitName(): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed || !naming) return;
		if (naming === 'new') {
			const made = await playbooks.create(shown, trimmed);
			if (made) onshow(made.id);
		} else {
			await playbooks.rename(shown, trimmed);
		}
		naming = null;
	}

	async function remove(): Promise<void> {
		removing = false;
		await playbooks.remove(shown);
		onshow(playbooks.defaultId);
	}

	async function toggleHistory(): Promise<void> {
		if (history) {
			history = null;
			return;
		}
		history = await playbooks.revisions(shown);
	}

	// Another engine shown: its own history, its own name.
	$effect(() => {
		void shown;
		history = null;
		naming = null;
		removing = false;
	});
</script>

<div class="playbook-header" data-playbook-header>
	<div class="playbook-chips" role="tablist" aria-label={c.title}>
		{#each playbooks.items as item (item.id)}
			<button
				type="button"
				role="tab"
				class="playbook-chip"
				class:is-shown={item.id === shown}
				aria-selected={item.id === shown}
				data-playbook-chip={item.id}
				onclick={() => onshow(item.id)}
			>
				{#if item.id === playbooks.defaultId}<span class="playbook-chip-star" aria-label={c.isDefault} title={c.isDefault}>★</span>{/if}
				{playbookName(item, c.builtin)}
			</button>
		{/each}
	</div>

	{#if current}
		{#if current.builtin && c.builtinHint[current.id]}
			<p class="playbook-header-hint">{c.builtinHint[current.id]}</p>
		{/if}
		<div class="playbook-actions">
			{#if isDefault}
				<span class="playbook-default">{c.isDefault}</span>
			{:else}
				<button type="button" class="playbook-action" data-playbook-action="default" onclick={() => onmakedefault(shown)}>{c.makeDefault}</button>
			{/if}
			<button type="button" class="playbook-action" data-playbook-action="new" onclick={() => void startNaming('new')}>{c.newFrom}</button>
			{#if !current.builtin}
				<button type="button" class="playbook-action" data-playbook-action="rename" onclick={() => void startNaming('rename')}>{c.rename}</button>
				{#if !isDefault}
					<button type="button" class="playbook-action is-danger" data-playbook-action="remove" onclick={() => { removing = true; naming = null; }}>{c.remove}</button>
				{/if}
			{/if}
			<button type="button" class="playbook-action" aria-expanded={history !== null} data-playbook-action="history" onclick={() => void toggleHistory()}>
				{c.history}{#if current.revision > 0} · {c.revision(current.revision)}{/if}
			</button>
		</div>
		{#if naming}
			<form class="playbook-name" onsubmit={(event) => { event.preventDefault(); void submitName(); }}>
				<input bind:this={nameInput} bind:value={name} maxlength="40" placeholder={c.newName} aria-label={c.newName} data-playbook-name />
				<button type="submit" class="playbook-action is-primary" disabled={!name.trim() || playbooks.saving}>{naming === 'new' ? c.create : c.rename}</button>
				<button type="button" class="playbook-action" onclick={() => (naming = null)}>{c.cancel}</button>
			</form>
		{/if}
		{#if removing}
			<div class="playbook-confirm" role="alertdialog" aria-label={c.remove}>
				<span>{c.removeConfirm(playbookName(current, c.builtin))}</span>
				<button type="button" class="playbook-action is-danger" data-playbook-confirm-remove onclick={() => void remove()}>{c.remove}</button>
				<button type="button" class="playbook-action" onclick={() => (removing = false)}>{c.cancel}</button>
			</div>
		{/if}
		{#if history}
			<ol class="playbook-history" data-playbook-history>
				{#each history as row (row.id)}
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
	{/if}
	{#if playbooks.error && !current}
		<p class="field-error" role="alert">{playbooks.error === 'conflict' ? c.conflict : c.failed}</p>
	{/if}
</div>

<style>
	.playbook-header {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.playbook-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.playbook-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: inherit;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.playbook-chip:hover {
		background: var(--line-subtle);
	}

	.playbook-chip.is-shown {
		border-color: var(--accent);
		background: var(--accent-soft, var(--chip));
		color: var(--accent);
		font-weight: 600;
	}

	.playbook-chip-star {
		color: var(--brand, var(--accent));
		font-size: 11px;
	}

	.playbook-header-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.playbook-actions,
	.playbook-name,
	.playbook-confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		font-size: 12px;
	}

	.playbook-action {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.playbook-action:hover:not(:disabled) {
		text-decoration: underline;
	}

	.playbook-action:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.playbook-action.is-danger {
		color: var(--danger, var(--warn));
	}

	.playbook-action.is-primary {
		font-weight: 600;
	}

	.playbook-default {
		color: var(--muted);
	}

	.playbook-name input {
		flex: 1;
		min-width: 140px;
		max-width: 260px;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg, var(--pane));
		color: inherit;
		font: inherit;
	}

	.playbook-history {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		list-style: none;
		font-size: 12px;
	}

	.playbook-history li {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
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
