<script lang="ts">
	import type { InterfaceTokens } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import IconButton from '../IconButton.svelte';
	import Button from '../Button.svelte';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { editInterface, editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';

	/** Design tokens you set, by look; a form adds one, a row's button puts it back to the app's own. */
	type Props = { runtime: MessengerRuntime; t: Copy; tokens: InterfaceTokens };

	let { runtime, t, tokens }: Props = $props();
	const c = $derived(t.ui.tokens);

	type Look = 'light' | 'dark' | 'both';
	const LOOKS: Look[] = ['light', 'dark', 'both'];

	const entries = $derived(
		(['light', 'dark'] as const).flatMap((side) =>
			Object.entries(tokens[side])
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, value]) => ({ side, name, value }))
		)
	);

	let name = $state('');
	let value = $state('');
	let look = $state<Look>('both');
	let problem = $state<string | null>(null);
	let busy = $state(false);

	const lookLabel = (side: Look) => (side === 'light' ? c.light : side === 'dark' ? c.dark : c.both);
	const showsColour = (text: string) => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', text);

	function remove(side: 'light' | 'dark', token: string): void {
		void editInterfaceOrToast(runtime, { tokens: { [side]: { [token]: null } } });
	}

	async function add(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busy || !name.trim() || !value.trim()) return;
		busy = true;
		problem = null;
		const result = await editInterface(runtime, { tokens: { [look]: { [name.trim()]: value.trim() } } });
		busy = false;
		if (result.ok) {
			name = '';
			value = '';
		} else problem = result.message;
	}
</script>

<SettingsCard class="interface-tokens">
	<h3 class="interface-card-title">{t.ui.sections.tokens}</h3>
	{#if entries.length === 0}
		<p class="interface-empty">{c.empty}</p>
	{:else}
		<ul class="token-list">
			{#each entries as entry (`${entry.side}:${entry.name}`)}
				<li class="token-row" data-token={entry.name} data-side={entry.side}>
					{#if showsColour(entry.value)}
						<span class="token-swatch" style:background={entry.value} aria-hidden="true"></span>
					{:else}
						<span class="token-swatch is-none" aria-hidden="true"></span>
					{/if}
					<code class="token-name">{entry.name}</code>
					<span class="token-side">{lookLabel(entry.side)}</span>
					<code class="token-value">{entry.value}</code>
					<IconButton icon="x" size="sm" label="{c.remove} {entry.name}" onclick={() => remove(entry.side, entry.name)} />
				</li>
			{/each}
		</ul>
	{/if}

	<form class="token-form" onsubmit={add}>
		<span class="token-form-title">{c.add}</span>
		<div class="token-fields">
			<input class="token-input" type="text" placeholder="--accent" aria-label={c.name} bind:value={name} autocomplete="off" spellcheck="false" />
			<input class="token-input" type="text" placeholder={c.value} aria-label={c.value} bind:value autocomplete="off" spellcheck="false" />
			<div class="segmented-control" role="group" aria-label={c.add}>
				{#each LOOKS as option (option)}
					<button type="button" class="segmented-btn" class:is-active={look === option} onclick={() => (look = option)}>
						<span>{lookLabel(option)}</span>
					</button>
				{/each}
			</div>
			<Button type="submit" size="sm" variant="secondary" disabled={busy || !name.trim() || !value.trim()}>{c.add}</Button>
		</div>
		{#if problem}<p class="field-error" role="alert">{problem}</p>{/if}
	</form>
</SettingsCard>

<style>
	.interface-card-title {
		margin: 0;
		font-size: var(--text-body);
		font-weight: 650;
		color: var(--ink);
	}

	.interface-empty {
		margin: 0;
		font-size: var(--text-small);
		color: var(--muted);
	}

	.token-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.token-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		border-top: 1px solid var(--line-subtle);
		min-width: 0;
	}

	.token-swatch {
		flex: none;
		width: 16px;
		height: 16px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
	}

	.token-swatch.is-none {
		border-style: dashed;
		background: transparent;
	}

	.token-name,
	.token-value {
		font: var(--text-caption) / 1.5 var(--mono);
		color: var(--ink);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.token-name {
		flex: 0 1 auto;
	}

	.token-value {
		flex: 1;
		color: var(--ink-secondary);
	}

	.token-side {
		flex: none;
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: var(--text-micro);
		line-height: 16px;
	}

	.token-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line-subtle);
	}

	.token-form-title {
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.token-fields {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.token-input {
		flex: 1 1 140px;
		min-width: 0;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: var(--text-small) / 1 var(--mono);
	}

	.token-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.field-error {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--danger-text);
	}

	@media (max-width: 540px) {
		.token-row {
			flex-wrap: wrap;
		}

		.token-value {
			flex-basis: 100%;
			order: 5;
		}
	}

	/* The same pill switcher as Settings › General's theme and language. */
	.segmented-control {
		display: inline-flex;
		align-items: center;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		padding: 3px;
		gap: 2px;
	}

	.segmented-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
		-webkit-user-select: none;
		white-space: nowrap;
	}

	.segmented-btn:hover:not(.is-active) {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.segmented-btn.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	@media (max-width: 540px) {
		.segmented-control {
			width: 100%;
			display: flex;
		}

		.segmented-btn {
			flex: 1;
			justify-content: center;
		}
	}
</style>
