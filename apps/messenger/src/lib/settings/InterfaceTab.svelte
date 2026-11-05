<script lang="ts" module>
	export type InterfaceSection = 'behaviour' | 'tokens' | 'css' | 'copy' | 'history';
</script>

<script lang="ts">
	import type { InterfaceBehaviour } from '@real-bot/protocol';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { interfaceController, escapeKeyLabel } from '../interface/controller.svelte.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import Switch from '../Switch.svelte';
	import InterfaceBehaviourCard from './InterfaceBehaviourCard.svelte';
	import InterfaceCopyCard from './InterfaceCopyCard.svelte';
	import InterfaceCssCard from './InterfaceCssCard.svelte';
	import InterfaceHistoryCard, { revisionWhen, revisionWho } from './InterfaceHistoryCard.svelte';
	import InterfaceReportsCard from './InterfaceReportsCard.svelte';
	import InterfaceTokensCard from './InterfaceTokensCard.svelte';
	import { editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import SettingsSectionList from './SettingsSectionList.svelte';
	import SettingsSectionTabs from './SettingsSectionTabs.svelte';

	/**
	 * Settings › 界面 (ADR 0106): the profile every window reads, as a Bot or you change it. This
	 * page is the one place that shows all of it, and the way back from any of it. Its parts are
	 * tabs on a wide window and a list on a phone (as Models), so none of them sits below the
	 * others; the switch for the whole of it stays over them.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		snapshot: Snapshot;
		locale: 'zh' | 'en';
		/** No workbench: the desktop-only rows are left out. */
		phone?: boolean;
		/** What the dialog says over any page: pending credentials, a failed save, setup not done. */
		notices?: Snippet;
	};

	let { runtime, t, snapshot, locale, phone = false, notices }: Props = $props();
	const iface = $derived(snapshot.interface);
	const c = $derived(t.ui);

	const narrow = new MediaQuery('(max-width: 720px)');
	const sections: InterfaceSection[] = ['behaviour', 'tokens', 'css', 'copy', 'history'];
	let picked = $state<InterfaceSection>('behaviour');
	/** On a phone, a part's page is open over the list of them. */
	let opened = $state(false);
	const listing = $derived(narrow.current && !opened);
	let scroller = $state<HTMLElement>();

	let confirmingReset = $state(false);

	const pausedBy = $derived(interfaceController.pausedBy);
	const pausedWhy = $derived.by(() => {
		if (pausedBy === 'url') return c.pausedByUrl;
		if (pausedBy === 'key') return c.pausedByKey.replace('{key}', escapeKeyLabel());
		if (pausedBy === 'floor') {
			const floor = interfaceController.floorFailed[0]?.floor ?? '';
			return c.pausedByFloor.replace('{floor}', (c.floors as Record<string, string>)[floor] ?? floor);
		}
		return '';
	});

	const label = (of: InterfaceSection) => c.sections[of];

	const tokenCount = $derived(iface ? Object.keys(iface.profile.tokens.light).length + Object.keys(iface.profile.tokens.dark).length : 0);
	const wordCount = $derived(iface ? Object.keys(iface.profile.copy[locale] ?? {}).length : 0);

	/** The choices on the behaviour page set to something of yours. */
	function behaviourChanged(behaviour: InterfaceBehaviour): number {
		return Object.values(behaviour).filter((value) => {
			if (value === null || value === undefined || value === false) return false;
			if (typeof value === 'object') return Object.values(value).some((inner) => inner !== null && inner !== undefined);
			return true;
		}).length;
	}

	function count(of: InterfaceSection): number {
		return of === 'tokens' ? tokenCount : of === 'copy' ? wordCount : 0;
	}

	const changed = (n: number) => c.summary.changed.replace('{n}', String(n));

	/** What a part holds, under its name on the phone's list. */
	function summary(of: InterfaceSection): string {
		if (!iface) return '';
		if (of === 'behaviour') {
			const n = behaviourChanged(iface.profile.behaviour);
			return n === 0 ? c.summary.allDefault : changed(n);
		}
		if (of === 'tokens') return tokenCount === 0 ? c.tokens.empty : changed(tokenCount);
		if (of === 'css') return iface.profile.css.length === 0 ? c.css.empty : c.css.length.replace('{n}', String(iface.profile.css.length));
		if (of === 'copy') return wordCount === 0 ? c.copyWords.empty : changed(wordCount);
		const latest = iface.recent[0];
		if (!latest) return c.history.empty;
		return [revisionWho(latest, snapshot.bots, c.history), c.history.ops[latest.op], revisionWhen(latest.created_at, locale)].join(' · ');
	}

	function open(next: InterfaceSection): void {
		picked = next;
		opened = true;
		confirmingReset = false;
		if (scroller) scroller.scrollTop = 0;
	}

	/** The open part's name for the page head on a phone; null on the list, and on a wide window. */
	export function sectionTitle(): string | null {
		return narrow.current && opened ? label(picked) : null;
	}

	/** Back on a phone from a part's page goes to the list of them. */
	export function backFromSection(): boolean {
		if (!narrow.current || !opened) return false;
		opened = false;
		return true;
	}

	async function resetAll(): Promise<void> {
		confirmingReset = false;
		await editInterfaceOrToast(runtime, { reset: ['tokens', 'behaviour', 'css', 'copy'] });
	}
</script>

{#snippet icon(of: InterfaceSection, size: number)}
	<Icon name={of === 'behaviour' ? 'pointer' : of === 'tokens' ? 'tag' : of === 'css' ? 'code' : of === 'copy' ? 'type' : 'history'} size={size >= 18 ? 20 : 16} />
{/snippet}

{#snippet paused()}
	{#if pausedBy}
		<div class="interface-paused" role="status">
			<div>
				<strong>{c.pausedHere}</strong>
				<span>{pausedWhy}</span>
			</div>
			{#if pausedBy !== 'url'}
				<Button size="sm" variant="secondary" data-floor="interface-pause" onclick={() => interfaceController.resume()}>{c.resumeHere}</Button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet enabledSwitch()}
	<span class="interface-floor" data-floor="interface-pause">
		<Switch class="relative inline-flex items-center cursor-pointer select-none" for="interface-enabled-toggle" labelledby="interface-enabled-label">
			<input
				id="interface-enabled-toggle"
				type="checkbox"
				checked={iface?.profile.enabled ?? true}
				onchange={(event) => void editInterfaceOrToast(runtime, { enabled: (event.currentTarget as HTMLInputElement).checked })}
			/>
		</Switch>
	</span>
{/snippet}

{#snippet intro()}
	<div class="interface-intro">
		<p class="interface-sub">{c.subtitle}</p>
		<p class="interface-sub">{c.askHint}</p>
	</div>
{/snippet}

<div class="interface-tab">
	{#if !iface}
		<div class="interface-scroll">
			<p class="interface-note">{c.unavailable}</p>
		</div>
	{:else}
		{#if !narrow.current}
			<!-- The switch for the whole of it, and why this window shows the default, stay over every part. -->
			<div class="interface-top">
				{@render paused()}
				<div class="interface-switch">
					<div class="interface-switch-text">
						<span class="interface-switch-title" id="interface-enabled-label">{c.enabled}</span>
						<span class="interface-switch-hint">{c.enabledHint}</span>
					</div>
					{@render enabledSwitch()}
				</div>
			</div>
			<SettingsSectionTabs id="interface" {sections} active={picked} {label} {count} {icon} ariaLabel={c.tab} onpick={open} />
		{/if}

		<div class="interface-scroll" bind:this={scroller}>
			{@render notices?.()}
			{#if listing}
				{@render paused()}
				<SettingsCard class="interface-enabled">
					<SettingsRow title={c.enabled} titleId="interface-enabled-label" desc={c.enabledHint}>
						{@render enabledSwitch()}
					</SettingsRow>
				</SettingsCard>
				{@render intro()}
				<SettingsSectionList {sections} {label} {summary} {icon} ariaLabel={c.tab} onpick={open} />
			{:else}
				<div
					class="interface-panel"
					class:is-subpage={narrow.current}
					id="interface-panel"
					role={narrow.current ? undefined : 'tabpanel'}
					aria-labelledby={narrow.current ? undefined : `interface-tab-${picked}`}
					data-interface-panel={picked}
				>
					{#if picked === 'behaviour'}
						{#if !narrow.current}{@render intro()}{/if}
						<InterfaceBehaviourCard {runtime} {t} behaviour={iface.profile.behaviour} {phone} />
					{:else if picked === 'tokens'}
						<InterfaceTokensCard {runtime} {t} tokens={iface.profile.tokens} />
					{:else if picked === 'css'}
						<InterfaceCssCard {runtime} {t} {iface} {locale} />
					{:else if picked === 'copy'}
						<InterfaceCopyCard {runtime} {t} words={iface.profile.copy} {locale} />
					{:else}
						<InterfaceHistoryCard {runtime} {t} recent={iface.recent} bots={snapshot.bots} {locale} />
						<InterfaceReportsCard {runtime} {t} revisionId={iface.revision_id} />

						<div class="interface-reset">
							{#if confirmingReset}
								<p class="interface-sub">{c.resetAllConfirm}</p>
								<div class="interface-reset-actions">
									<Button size="sm" variant="danger" onclick={() => void resetAll()}>{c.resetAll}</Button>
									<Button size="sm" variant="ghost" onclick={() => (confirmingReset = false)}>{c.cancel}</Button>
								</div>
							{:else}
								<Button size="sm" variant="danger-soft" onclick={() => (confirmingReset = true)}>{c.resetAll}</Button>
							{/if}
						</div>

						<p class="interface-foot">{c.escapeHint.replace('{key}', escapeKeyLabel())}</p>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* The dialog's body leaves the scrolling to this page, so the switch and the tabs stay put over it. */
	.interface-tab {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.interface-top {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 24px 10px;
		background: var(--pane);
	}

	.interface-switch {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.interface-switch-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.interface-switch-title {
		font-size: 13px;
		font-weight: 500;
		line-height: 1.3;
		color: var(--ink);
	}

	.interface-switch-hint {
		font-size: 12px;
		line-height: 1.35;
		color: var(--muted);
	}

	.interface-scroll {
		flex: 1;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.interface-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.interface-intro {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.interface-sub,
	.interface-note,
	.interface-foot {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.5;
		color: var(--muted);
	}

	.interface-foot {
		font-size: var(--text-caption);
	}

	.interface-paused {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-radius: var(--radius-lg);
		border: 1px solid var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-size: var(--text-small);
	}

	.interface-paused > div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.interface-floor {
		display: inline-flex;
	}

	.interface-reset {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}

	.interface-reset-actions {
		display: flex;
		gap: 8px;
	}

	@media (max-width: 720px) {
		.interface-scroll {
			padding: 20px 16px max(28px, env(safe-area-inset-bottom));
			gap: 16px;
			overscroll-behavior: contain;
			scrollbar-width: none;
		}

		.interface-scroll::-webkit-scrollbar {
			display: none;
		}

		/* A part opened from the list comes in from the side, as the other inner pages do. */
		.interface-panel.is-subpage {
			gap: 16px;
			animation: interface-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}
	}

	@keyframes interface-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
