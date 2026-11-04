<script lang="ts">
	import { interfaceController, escapeKeyLabel } from '../interface/controller.svelte.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import Button from '../Button.svelte';
	import Switch from '../Switch.svelte';
	import InterfaceBehaviourCard from './InterfaceBehaviourCard.svelte';
	import InterfaceCopyCard from './InterfaceCopyCard.svelte';
	import InterfaceCssCard from './InterfaceCssCard.svelte';
	import InterfaceHistoryCard from './InterfaceHistoryCard.svelte';
	import InterfaceReportsCard from './InterfaceReportsCard.svelte';
	import InterfaceTokensCard from './InterfaceTokensCard.svelte';
	import { editInterfaceOrToast } from './interface-edit.ts';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsRow from './SettingsRow.svelte';

	/**
	 * Settings › 界面 (ADR 0106): the profile every window reads, as a Bot or you change it. This
	 * page is the one place that shows all of it, and the way back from any of it.
	 */
	type Props = { runtime: MessengerRuntime; t: Copy; snapshot: Snapshot; locale: 'zh' | 'en'; phone?: boolean };

	let { runtime, t, snapshot, locale, phone = false }: Props = $props();
	const iface = $derived(snapshot.interface);
	const c = $derived(t.ui);

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

	async function resetAll(): Promise<void> {
		confirmingReset = false;
		await editInterfaceOrToast(runtime, { reset: ['tokens', 'behaviour', 'css', 'copy'] });
	}
</script>

<div class="interface-tab">
	{#if !iface}
		<p class="interface-note">{c.unavailable}</p>
	{:else}
		<header class="interface-head">
			<h3 class="interface-title">{c.title}</h3>
			<p class="interface-sub">{c.subtitle}</p>
			<p class="interface-sub">{c.askHint}</p>
		</header>

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

		<SettingsCard class="interface-enabled">
			<SettingsRow title={c.enabled} titleId="interface-enabled-label" desc={c.enabledHint}>
				<span class="interface-floor" data-floor="interface-pause">
					<Switch class="relative inline-flex items-center cursor-pointer select-none" for="interface-enabled-toggle" labelledby="interface-enabled-label">
						<input
							id="interface-enabled-toggle"
							type="checkbox"
							checked={iface.profile.enabled}
							onchange={(event) => void editInterfaceOrToast(runtime, { enabled: (event.currentTarget as HTMLInputElement).checked })}
						/>
					</Switch>
				</span>
			</SettingsRow>
		</SettingsCard>

		<InterfaceBehaviourCard {runtime} {t} behaviour={iface.profile.behaviour} {phone} />
		<InterfaceTokensCard {runtime} {t} tokens={iface.profile.tokens} />
		<InterfaceCssCard {runtime} {t} {iface} {locale} />
		<InterfaceCopyCard {runtime} {t} words={iface.profile.copy} {locale} />
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

<style>
	.interface-tab {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.interface-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.interface-title {
		margin: 0;
		font-size: var(--text-heading);
		font-weight: 650;
		color: var(--ink);
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
</style>
