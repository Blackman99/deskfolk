<script lang="ts">
	import SettingsCard from './SettingsCard.svelte';
	import SettingsCardHeader from './SettingsCardHeader.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import Select from '../Select.svelte';
	import type { SelectOption } from '../select-options.ts';
	import type { Copy } from '../copy.ts';
	import {
		OPEN_KINDS,
		OPEN_PLACEMENT_GROUPS,
		isOpenPlacement,
		type OpenKind
	} from '../workbench/open-placement.ts';
	import { openPlacements } from '../workbench/open-placement-store.svelte.ts';

	/**
	 * Settings › Behavior: where each kind of window opens on the workbench when it is not open yet.
	 * A row per kind, its choices under the four ways a window can arrive. Kept on this machine, like
	 * the layout it shapes; a change applies to the next window opened.
	 */
	type Props = { t: Copy };

	let { t }: Props = $props();

	const options = $derived<SelectOption[]>(
		OPEN_PLACEMENT_GROUPS.flatMap(({ group, placements }) =>
			placements.map((placement) => ({
				value: placement,
				label: t.openPlacement.placements[placement],
				group: t.openPlacement.groups[group]
			}))
		)
	);

	function choose(kind: OpenKind, value: string): void {
		if (isOpenPlacement(value)) openPlacements.set(kind, value);
	}
</script>

<SettingsCard class="settings-card-open-placement">
	<SettingsCardHeader title={t.openPlacement.title} subtitle={t.openPlacement.subtitle}>
		{#snippet icon()}
			<div class="open-placement-icon" aria-hidden="true">
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="3" y="4" width="18" height="16" rx="2"></rect>
					<line x1="12" y1="4" x2="12" y2="20"></line>
					<line x1="12" y1="12" x2="21" y2="12"></line>
				</svg>
			</div>
		{/snippet}
		{#snippet end()}
			<button
				type="button"
				class="btn-xs open-placement-reset"
				disabled={!openPlacements.changed}
				onclick={() => openPlacements.reset()}
			>
				{t.openPlacement.reset}
			</button>
		{/snippet}
	</SettingsCardHeader>

	<div class="open-placement-rows">
		{#each OPEN_KINDS as kind (kind)}
			<SettingsRow
				title={t.openPlacement.kinds[kind].name}
				titleId="open-placement-{kind}"
				desc={t.openPlacement.kinds[kind].hint}
			>
				{#snippet titleAfter()}
					{#if !openPlacements.isDefault(kind)}
						<span class="open-placement-changed">{t.openPlacement.changed}</span>
					{/if}
				{/snippet}
				<Select
					value={openPlacements.get(kind)}
					{options}
					size="sm"
					ariaLabel={t.openPlacement.kinds[kind].name}
					onchange={(value) => choose(kind, value)}
				/>
			</SettingsRow>
		{/each}
	</div>
	<p class="open-placement-note">{t.openPlacement.floatMemory}</p>
	<p class="open-placement-note">{t.openPlacement.notListed}</p>
</SettingsCard>

<style>
	.open-placement-icon {
		width: 30px;
		height: 30px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}

	.open-placement-rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line-subtle);
		margin-top: 4px;
	}

	/* Beside the name, no taller than it, so a changed row is as tall as the rest. */
	.open-placement-changed {
		flex: none;
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 11px;
		font-weight: 600;
		line-height: 15px;
	}

	.open-placement-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
