<script lang="ts">
	import type { PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { holdBack } from '../chat/message-text-pages.ts';
	import RoutingTab from './RoutingTab.svelte';

	/**
	 * Roles (分工, ADR 0082) as a page of its own (ADR 0083): the map of the app's own calls with the
	 * picked one's model and prompts, opened from Tools or by a card about a call's prompt — a tab on
	 * a wide window, a page in place of the list on a phone. It reads the built-in prompts itself, as
	 * Settings does, again whenever one changes.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** A tab is closed by its tab; a page has Back, which steps out of a call's page first. */
		host?: 'pane' | 'page';
		onBack?: () => void;
	}

	let { runtime, t, host = 'pane', onBack }: Props = $props();

	let items = $state<PromptSummary[]>([]);
	let failed = $state(false);
	$effect(() => {
		const api = runtime.client;
		void runtime.promptsRevision;
		if (!api || runtime.connection !== 'connected') return;
		void api.listPrompts().then(
			(rows) => {
				if (runtime.client !== api) return;
				items = rows;
				failed = false;
			},
			() => {
				if (runtime.client === api) failed = true;
			}
		);
	});

	let roles = $state<RoutingTab>();
	const title = $derived(roles?.sectionTitle() ?? t.routing.tab);

	/** Back steps out of the prompt editor, then a call's page, then the page itself. */
	function back(): void {
		if (roles?.backFromEditor() || roles?.backFromSection()) return;
		onBack?.();
	}

	// The phone's own Back takes the same steps: while a call's page or the editor is open, it steps
	// out of that rather than leaving the page, which is in the URL (the shell's list-page layer).
	$effect(() => {
		if (host !== 'page' || !roles?.deep()) return;
		return holdBack(() => back());
	});
</script>

<div class="roles-page" class:is-page={host === 'page'} data-roles-page>
	{#if host === 'page'}
		<div class="roles-page-head">
			<button type="button" class="roles-page-back" title={t.common.back} aria-label={t.common.back} onclick={back}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="15 18 9 12 15 6"></polyline>
				</svg>
			</button>
			<h2 class="roles-page-title">{title}</h2>
			<div class="roles-page-spacer" aria-hidden="true"></div>
		</div>
	{/if}
	<RoutingTab
		bind:this={roles}
		{runtime}
		{t}
		snapshot={runtime.snapshot}
		{items}
		loadFailed={failed}
		openTab={() => runtime.openPromptSettings(null)}
	/>
</div>

<style>
	.roles-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--pane);
	}

	.roles-page-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 52px;
		padding: max(6px, env(safe-area-inset-top, 0px)) 12px 6px 8px;
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}

	.roles-page-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	.roles-page-title {
		flex: 1;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		font-size: 16px;
		font-weight: 600;
		text-align: center;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.roles-page-spacer {
		width: 38px;
		flex-shrink: 0;
	}
</style>
