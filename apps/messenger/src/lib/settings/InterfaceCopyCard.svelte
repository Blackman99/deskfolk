<script lang="ts">
	import type { InterfaceProfile } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import Button from '../Button.svelte';
	import { editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';

	/** The app's words you (or a Bot) changed in the language shown; a Bot adds them, here you put one back. */
	type Props = { runtime: MessengerRuntime; t: Copy; words: InterfaceProfile['copy']; locale: 'zh' | 'en' };

	let { runtime, t, words, locale }: Props = $props();
	const c = $derived(t.ui.copyWords);
	const entries = $derived(Object.entries(words[locale] ?? {}).sort(([a], [b]) => a.localeCompare(b)));

	function putBack(key: string): void {
		void editInterfaceOrToast(runtime, { copy: { [locale]: { [key]: null } } });
	}
</script>

<SettingsCard class="interface-copy">
	<h3 class="interface-card-title">{t.ui.sections.copy}</h3>
	{#if entries.length === 0}
		<p class="interface-empty">{c.empty}</p>
	{:else}
		<ul class="copy-list">
			{#each entries as [key, text] (key)}
				<li class="copy-row" data-copy-key={key}>
					<div class="copy-body">
						<code class="copy-key">{key}</code>
						<span class="copy-text">{text}</span>
					</div>
					<Button size="sm" variant="ghost" onclick={() => putBack(key)}>{c.remove}</Button>
				</li>
			{/each}
		</ul>
	{/if}
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

	.copy-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.copy-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-top: 1px solid var(--line-subtle);
	}

	.copy-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.copy-key {
		font: var(--text-caption) / 1.5 var(--mono);
		color: var(--muted);
	}

	.copy-text {
		font-size: var(--text-small);
		color: var(--ink);
		overflow-wrap: anywhere;
	}
</style>
