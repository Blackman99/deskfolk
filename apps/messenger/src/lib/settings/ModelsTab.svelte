<script lang="ts" module>
	export type ModelsSection = 'endpoints' | 'ladder' | 'reader';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { isReaderClaudeModel } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import ModelLadderCard from './ModelLadderCard.svelte';
	import ReaderModelCard from './ReaderModelCard.svelte';
	import SpeechCard from './SpeechCard.svelte';
	import { ModelLadder } from './model-ladder.svelte.ts';

	/**
	 * Settings › Models in three sections: the endpoints, the model ladder (ADR 0054) and the model
	 * that reads lines (ADR 0055). A wide window shows them as tabs over one page. A phone lists them
	 * with what each is set to and opens one as a page of its own, one level deeper.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		snapshot: Snapshot;
		/** The endpoint list, wired by the dialog to its editor. */
		endpoints: Snippet;
		/** What the dialog says over any page: pending credentials, a failed save, setup not done. */
		notices?: Snippet;
	};

	let { runtime, t, snapshot, endpoints, notices }: Props = $props();

	const phone = new MediaQuery('(max-width: 720px)');
	const providers = $derived(snapshot.providers);

	const ladder = new ModelLadder(() => runtime.client);
	// Again when the endpoints change: a rung whose model is no longer listed is gone from it.
	$effect(() => {
		void providers.map((provider) => `${provider.id}:${provider.models.join(',')}`).join('|');
		void ladder.load();
	});

	/** With no endpoint there is nothing to order or to read with, so the endpoints are all there is. */
	const sections = $derived<ModelsSection[]>(
		providers.length === 0 ? ['endpoints'] : ladder.available ? ['endpoints', 'ladder', 'reader'] : ['endpoints', 'reader']
	);
	let picked = $state<ModelsSection>('endpoints');
	const section = $derived(sections.includes(picked) ? picked : 'endpoints');
	/** On a phone, a section's page is open over the list of them. */
	let opened = $state(false);
	const listing = $derived(phone.current && sections.length > 1 && !opened);
	let scroller = $state<HTMLElement>();

	function label(of: ModelsSection): string {
		return of === 'endpoints' ? t.settings.modelsSectionEndpoints : of === 'ladder' ? t.modelLadder.title : t.readerModel.title;
	}

	const defaultProvider = $derived(providers.find((provider) => provider.id === snapshot.settings.default_provider_id) ?? null);
	const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;

	/** What a section is set to, under its name on the phone's list. */
	function summary(of: ModelsSection): string {
		if (of === 'endpoints') {
			return providers.length === 0
				? t.settings.providerEmpty
				: t.settings.modelsEndpointsSummary(providers.length, defaultProvider?.name ?? null);
		}
		if (of === 'ladder') {
			return ladder.rungs.length === 0 ? t.modelLadder.unset : ladder.rungs.map((rung) => rung.model).join(' → ');
		}
		const chosen = snapshot.settings.reader_model ?? null;
		if (!chosen) return t.readerModel.followDefault(snapshot.settings.endpoint_default_model);
		if (isReaderClaudeModel(chosen)) return t.readerModel.claudeModel(chosen.model);
		return providers.length > 1 ? `${chosen.model} · ${providerName(chosen.provider_id)}` : chosen.model;
	}

	function count(of: ModelsSection): number {
		return of === 'endpoints' ? providers.length : of === 'ladder' ? ladder.rungs.length : 0;
	}

	function open(next: ModelsSection): void {
		picked = next;
		opened = true;
		if (scroller) scroller.scrollTop = 0;
	}

	/** The open section's name for the page head on a phone; null on the list, and on a wide window. */
	export function sectionTitle(): string | null {
		return phone.current && sections.length > 1 && opened ? label(section) : null;
	}

	/** Back on a phone from a section's page goes to the list of sections. */
	export function backFromSection(): boolean {
		if (!phone.current || sections.length < 2 || !opened) return false;
		opened = false;
		return true;
	}
</script>

{#snippet icon(of: ModelsSection, size: number)}
	<svg class="models-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if of === 'endpoints'}
			<path d="M12 22v-5"></path>
			<path d="M9 8V2"></path>
			<path d="M15 8V2"></path>
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path>
		{:else if of === 'ladder'}
			<line x1="6" y1="20" x2="6" y2="15"></line>
			<line x1="12" y1="20" x2="12" y2="10"></line>
			<line x1="18" y1="20" x2="18" y2="4"></line>
		{:else}
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
			<line x1="8" y1="8" x2="16" y2="8"></line>
			<line x1="8" y1="12" x2="13" y2="12"></line>
		{/if}
	</svg>
{/snippet}

<div class="models-tab">
	{#if !phone.current && sections.length > 1}
		<div class="models-tabs" role="tablist" aria-label={t.settings.tabModels}>
			{#each sections as of (of)}
				<button
					type="button"
					role="tab"
					id={`models-tab-${of}`}
					aria-controls="models-panel"
					aria-selected={section === of}
					class="models-tab-btn"
					class:is-active={section === of}
					data-models-section={of}
					onclick={() => open(of)}
				>
					{@render icon(of, 15)}
					<span>{label(of)}</span>
					{#if count(of) > 0}
						<span class="models-tab-count">{count(of)}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}

	<div class="models-scroll" bind:this={scroller}>
		{@render notices?.()}
		{#if listing}
			<nav class="models-index" aria-label={t.settings.tabModels}>
				{#each sections as of (of)}
					<button type="button" class="models-index-row" data-models-section={of} onclick={() => open(of)}>
						{@render icon(of, 19)}
						<span class="models-index-text">
							<span class="models-index-name">{label(of)}</span>
							<span class="models-index-summary">{summary(of)}</span>
						</span>
						<span class="models-index-chevron" aria-hidden="true"></span>
					</button>
				{/each}
			</nav>
		{:else}
			<div
				class="models-panel"
				class:is-subpage={phone.current && sections.length > 1}
				id="models-panel"
				role={!phone.current && sections.length > 1 ? 'tabpanel' : undefined}
				aria-labelledby={!phone.current && sections.length > 1 ? `models-tab-${section}` : undefined}
				data-models-panel={section}
			>
				{#if section === 'endpoints'}
					{@render endpoints()}
					<!-- Speech needs no chat endpoint of its own: it has its own service and key (ADR 0073). -->
					<SpeechCard speech={snapshot.settings.speech ?? null} {providers} patch={(patch) => runtime.patchSpeech(patch)} {t} />
				{:else if section === 'ladder'}
					<p class="muted models-intro">{t.modelLadder.hint}</p>
					<ModelLadderCard {ladder} {providers} {t} />
				{:else}
					<p class="muted models-intro">{t.readerModel.hint}</p>
					<ReaderModelCard
						{providers}
						chosen={snapshot.settings.reader_model ?? null}
						defaultModel={snapshot.settings.endpoint_default_model}
						patch={(patch) => runtime.patchSettings(patch)}
						claudeCode={runtime.client ? () => runtime.client!.claudeCode() : null}
						{t}
					/>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	/* The dialog's body leaves the scrolling to this page, so the tabs stay put over it. */
	.models-tab {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.models-tabs {
		flex: none;
		display: flex;
		align-items: stretch;
		gap: 6px;
		padding: 0 16px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
	}

	.models-tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 44px;
		padding: 10px 8px 8px;
		margin-bottom: -1px;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: transparent;
		color: var(--ink-secondary);
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition-property: color, border-color;
	}

	.models-tab-btn:hover {
		color: var(--ink);
	}

	.models-tab-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.models-tab-btn.is-active {
		color: var(--accent);
		font-weight: 600;
		border-bottom-color: var(--accent);
	}

	.models-tab-btn :global(.models-icon) {
		flex: none;
		color: var(--muted);
	}

	.models-tab-btn.is-active :global(.models-icon) {
		color: var(--accent);
	}

	.models-tab-count {
		min-width: 18px;
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.models-tab-btn.is-active .models-tab-count {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.models-scroll {
		flex: 1;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.models-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.models-intro {
		margin: 0;
		line-height: 1.6;
	}

	@media (max-width: 720px) {
		.models-scroll {
			padding: 20px 16px max(28px, env(safe-area-inset-bottom));
			gap: 16px;
			overscroll-behavior: contain;
			scrollbar-width: none;
		}

		.models-scroll::-webkit-scrollbar {
			display: none;
		}

		/* The rows read as the settings list one level up: one rounded group, a hairline between rows. */
		.models-index {
			display: flex;
			flex-direction: column;
			border-radius: var(--radius-lg);
			overflow: hidden;
			background: var(--pane);
		}

		.models-index-row {
			position: relative;
			display: flex;
			align-items: center;
			gap: 12px;
			width: 100%;
			min-height: 64px;
			padding: 10px 14px;
			border: 0;
			border-radius: 0;
			background: var(--pane);
			color: var(--ink);
			text-align: left;
			cursor: pointer;
			transition-property: background-color;
		}

		.models-index-row + .models-index-row::before {
			content: '';
			position: absolute;
			left: 45px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line);
		}

		.models-index-row:active {
			background: var(--row-hover);
		}

		.models-index-row :global(.models-icon) {
			flex: none;
			color: var(--muted);
		}

		.models-index-text {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 3px;
		}

		.models-index-name {
			font-size: 15px;
			font-weight: 500;
			line-height: 1.3;
		}

		.models-index-summary {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 13px;
			line-height: 1.35;
			color: var(--muted);
		}

		.models-index-chevron {
			flex: none;
			width: 8px;
			height: 8px;
			margin: 0 3px 0 5px;
			border-top: 1.8px solid var(--muted);
			border-right: 1.8px solid var(--muted);
			transform: rotate(45deg);
		}

		.models-intro {
			font-size: 14px;
		}

		/* A section opened from the list comes in from the side, as the other inner pages do. */
		.models-panel.is-subpage {
			gap: 16px;
			animation: models-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}
	}

	@keyframes models-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
