<script lang="ts">
	import type { InterfaceWindowReport } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import SettingsCard from './SettingsCard.svelte';

	/** What each kind of window found after applying the profile, so a rule that matches nothing shows. */
	type Props = { runtime: MessengerRuntime; t: Copy; revisionId: string | null };

	let { runtime, t, revisionId }: Props = $props();
	const c = $derived(t.ui.report);
	const SETTLE_MS = 2000;

	let reports = $state<InterfaceWindowReport[]>([]);

	// Read now, and again once the windows have had time to apply a new revision and report.
	$effect(() => {
		void revisionId;
		const api = runtime.client;
		if (!api) return;
		let live = true;
		const load = () =>
			void api.getInterface().then(
				(state) => {
					if (live) reports = state.reports ?? [];
				},
				() => {}
			);
		load();
		const timer = setTimeout(load, SETTLE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	});

	const floorName = (floor: string) => (t.ui.floors as Record<string, string>)[floor] ?? floor;
</script>

<SettingsCard class="interface-reports">
	<h3 class="interface-card-title">{t.ui.sections.report}</h3>
	{#if reports.length === 0}
		<p class="interface-empty">{c.none}</p>
	{:else}
		<ul class="report-list">
			{#each reports as report (report.surface)}
				<li class="report-row" data-surface={report.surface}>
					<div class="report-line">
						<strong>{c.surfaces[report.surface]}</strong>
						<span class="report-state" class:is-off={!report.applied}>{report.applied ? c.applied : c.notApplied}</span>
					</div>
					{#if report.unmatched.length > 0}
						<div class="report-detail">
							<span>{c.unmatched}</span>
							<code>{report.unmatched.join('  ')}</code>
						</div>
					{/if}
					{#if report.dropped > 0}
						<div class="report-detail"><span>{c.dropped.replace('{n}', String(report.dropped))}</span></div>
					{/if}
					{#if report.bad_tokens.length > 0}
						<div class="report-detail">
							<span>{c.badTokens}</span>
							<code>{report.bad_tokens.join('  ')}</code>
						</div>
					{/if}
					{#if report.floor_failed.length > 0}
						<div class="report-detail">
							<span>{c.floor}{report.floor_failed.map((failure) => floorName(failure.floor)).join('、')}</span>
						</div>
					{/if}
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

	.report-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.report-row {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px 0;
		border-top: 1px solid var(--line-subtle);
		font-size: var(--text-small);
		color: var(--ink);
	}

	.report-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.report-state {
		font-size: var(--text-caption);
		color: var(--ok-text);
	}

	.report-state.is-off {
		color: var(--warn-text);
	}

	.report-detail {
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: var(--text-caption);
		color: var(--ink-secondary);
	}

	.report-detail code {
		font-family: var(--mono);
		overflow-wrap: anywhere;
	}
</style>
