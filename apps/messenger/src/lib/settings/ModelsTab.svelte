<script lang="ts" module>
	export type ModelsSection = 'endpoints' | 'ladder' | 'reader' | 'organizer' | 'speech';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { isReaderClaudeModel } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import ModelLadderCard from './ModelLadderCard.svelte';
	import OrganizerModelCard from './OrganizerModelCard.svelte';
	import ReaderModelCard from './ReaderModelCard.svelte';
	import SettingsSectionList from './SettingsSectionList.svelte';
	import SettingsSectionTabs from './SettingsSectionTabs.svelte';
	import SpeechCard, { speechMissing } from './SpeechCard.svelte';
	import { ModelLadder } from './model-ladder.svelte.ts';

	/**
	 * Settings › Models in five sections: the endpoints, the model ladder (ADR 0054), the model that
	 * reads lines (ADR 0055), the model that organizes the board (ADR 0075) and the speech
	 * recognition behind the message box's microphone (ADR 0073). A wide window shows them as tabs
	 * over one page. A phone lists them with what each is set to and opens one as a page of its own,
	 * one level deeper.
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

	/**
	 * With no endpoint there is nothing to order, to read or to organize with. Speech recognition is
	 * there either way: it has a service and key of its own, not an endpoint.
	 */
	const sections = $derived<ModelsSection[]>(
		providers.length === 0
			? ['endpoints', 'speech']
			: ladder.available
				? ['endpoints', 'ladder', 'reader', 'organizer', 'speech']
				: ['endpoints', 'reader', 'organizer', 'speech']
	);
	let picked = $state<ModelsSection>('endpoints');
	const section = $derived(sections.includes(picked) ? picked : 'endpoints');
	/** On a phone, a section's page is open over the list of them. */
	let opened = $state(false);
	const listing = $derived(phone.current && sections.length > 1 && !opened);
	let scroller = $state<HTMLElement>();

	function label(of: ModelsSection): string {
		if (of === 'endpoints') return t.settings.modelsSectionEndpoints;
		if (of === 'ladder') return t.modelLadder.title;
		if (of === 'reader') return t.readerModel.title;
		return of === 'organizer' ? t.organizerModel.title : t.speech.title;
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
		if (of === 'speech') {
			const speech = snapshot.settings.speech ?? null;
			if (!speech) return t.speech.unset;
			if (!speech.enabled) return t.speech.offShort;
			return speechMissing(speech, t.speech) ?? [t.speech.presets[speech.preset], speech.model].filter(Boolean).join(' · ');
		}
		if (of === 'organizer') {
			const organizing = snapshot.settings.organizer_model ?? null;
			if (!organizing) return t.organizerModel.followDefault(snapshot.settings.endpoint_default_model);
			return providers.length > 1 ? `${organizing.model} · ${providerName(organizing.provider_id)}` : organizing.model;
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
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if of === 'endpoints'}
			<path d="M12 22v-5"></path>
			<path d="M9 8V2"></path>
			<path d="M15 8V2"></path>
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path>
		{:else if of === 'ladder'}
			<line x1="6" y1="20" x2="6" y2="15"></line>
			<line x1="12" y1="20" x2="12" y2="10"></line>
			<line x1="18" y1="20" x2="18" y2="4"></line>
		{:else if of === 'reader'}
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
			<line x1="8" y1="8" x2="16" y2="8"></line>
			<line x1="8" y1="12" x2="13" y2="12"></line>
		{:else if of === 'organizer'}
			<rect x="3" y="3" width="7" height="9" rx="1"></rect>
			<rect x="14" y="3" width="7" height="5" rx="1"></rect>
			<rect x="14" y="12" width="7" height="9" rx="1"></rect>
			<rect x="3" y="16" width="7" height="5" rx="1"></rect>
		{:else}
			<rect x="9" y="2" width="6" height="12" rx="3"></rect>
			<path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
			<line x1="12" y1="18" x2="12" y2="22"></line>
		{/if}
	</svg>
{/snippet}

<div class="models-tab">
	{#if !phone.current && sections.length > 1}
		<SettingsSectionTabs id="models" {sections} active={section} {label} {count} {icon} ariaLabel={t.settings.tabModels} onpick={open} />
	{/if}

	<div class="models-scroll" bind:this={scroller}>
		{@render notices?.()}
		{#if listing}
			<SettingsSectionList {sections} {label} {summary} {icon} ariaLabel={t.settings.tabModels} onpick={open} />
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
				{:else if section === 'ladder'}
					<p class="muted models-intro">{t.modelLadder.hint}</p>
					<ModelLadderCard {ladder} {providers} claudeCode={runtime.client ? () => runtime.client!.claudeCode() : null} {t} />
				{:else if section === 'reader'}
					<p class="muted models-intro">{t.readerModel.hint}</p>
					<ReaderModelCard
						{providers}
						chosen={snapshot.settings.reader_model ?? null}
						defaultModel={snapshot.settings.endpoint_default_model}
						patch={(patch) => runtime.patchSettings(patch)}
						claudeCode={runtime.client ? () => runtime.client!.claudeCode() : null}
						{t}
					/>
				{:else if section === 'organizer'}
					<p class="muted models-intro">{t.organizerModel.hint}</p>
					<OrganizerModelCard
						{providers}
						chosen={snapshot.settings.organizer_model ?? null}
						defaultModel={snapshot.settings.endpoint_default_model}
						patch={(patch) => runtime.patchSettings(patch)}
						{t}
					/>
				{:else}
					<p class="muted models-intro">{t.speech.hint}</p>
					<SpeechCard speech={snapshot.settings.speech ?? null} {providers} patch={(patch) => runtime.patchSpeech(patch)} {t} />
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
