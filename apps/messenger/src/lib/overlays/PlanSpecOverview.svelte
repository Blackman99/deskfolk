<script lang="ts">
	import type { TicketStatus } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';

	/**
	 * Where the job stands, at a glance, at the top of the spec: its tickets by state (each one opens
	 * the board on that column), how many of its checks passed, and how the written progress counts.
	 * The tickets' states come first: they and the written progress describe the same work, and the
	 * tickets are the ones to go by.
	 */
	interface Props {
		t: Copy;
		ticketStates: ReadonlyArray<{ status: TicketStatus; count: number }>;
		checks: { pass: number; total: number };
		progress: { done: number; open: number; blocked: number };
		onShowTickets?: (status: TicketStatus | 'all') => void;
	}

	let { t, ticketStates, checks, progress, onShowTickets }: Props = $props();

	const checksPct = $derived(checks.total > 0 ? Math.round((checks.pass / checks.total) * 100) : 0);
	const hasProgress = $derived(progress.done + progress.open + progress.blocked > 0);
</script>

<section class="plan-overview" aria-label={t.plan.spec.overview}>
	<h4 class="plan-overview-title">{t.plan.spec.overview}</h4>
	{#if ticketStates.length > 0}
		<div class="plan-spec-ticket-states">
			<div class="plan-spec-ticket-states-line">
				<span class="plan-spec-ticket-states-label">{t.plan.links.ticketStates}</span>
				{#each ticketStates as entry (entry.status)}
					{#if onShowTickets}
						<button type="button" class="plan-spec-ticket-state is-{entry.status}" onclick={() => onShowTickets(entry.status)}>
							<span>{t.plan.ticketStatus[entry.status]}</span>
							<span class="mono">{entry.count}</span>
						</button>
					{:else}
						<span class="plan-spec-ticket-state is-{entry.status}">
							<span>{t.plan.ticketStatus[entry.status]}</span>
							<span class="mono">{entry.count}</span>
						</span>
					{/if}
				{/each}
			</div>
			<p class="plan-spec-ticket-states-hint">{t.plan.links.progressHint}</p>
		</div>
	{/if}
	{#if checks.total > 0}
		<div class="plan-overview-row">
			<span class="plan-overview-label">{t.plan.checks.title}</span>
			<span class="plan-overview-meter" aria-hidden="true">
				<span class="plan-overview-meter-fill" class:is-all={checks.pass === checks.total} style:width="{checksPct}%"></span>
			</span>
			<span class="plan-overview-value mono">{checks.pass}/{checks.total}</span>
		</div>
	{/if}
	{#if hasProgress}
		<div class="plan-overview-row">
			<span class="plan-overview-label">{t.plan.spec.progress}</span>
			<span class="plan-overview-counts">
				<span class="plan-overview-count is-done">{t.plan.spec.done} <b class="mono">{progress.done}</b></span>
				<span class="plan-overview-count is-open">{t.plan.spec.open} <b class="mono">{progress.open}</b></span>
				{#if progress.blocked > 0}
					<span class="plan-overview-count is-blocked">{t.plan.spec.blocked} <b class="mono">{progress.blocked}</b></span>
				{/if}
			</span>
		</div>
	{/if}
</section>

<style>
	.plan-overview {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.plan-overview-title {
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
	}

	/* The tickets' own states, above the written progress that describes the same work. */
	.plan-spec-ticket-states {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.plan-spec-ticket-states-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.plan-spec-ticket-states-label,
	.plan-overview-label {
		flex: none;
		width: 3em;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}

	.plan-spec-ticket-states-hint {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted-light);
	}

	.plan-spec-ticket-state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font: inherit;
		font-size: 11px;
		line-height: 1.4;
		padding: 1px 8px;
	}

	button.plan-spec-ticket-state {
		cursor: pointer;
	}

	button.plan-spec-ticket-state:hover {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.plan-spec-ticket-state::before {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted-light);
	}

	.plan-spec-ticket-state.is-doing::before {
		background: var(--accent);
	}

	.plan-spec-ticket-state.is-review::before {
		background: var(--purple);
	}

	.plan-spec-ticket-state.is-done::before {
		background: var(--ok);
	}

	.plan-spec-ticket-state.is-parked::before {
		background: var(--muted);
	}

	.plan-overview-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
	}

	/* How many checks pass, as a bar: green once every one does. */
	.plan-overview-meter {
		flex: 1;
		height: 6px;
		min-width: 40px;
		overflow: hidden;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
	}

	.plan-overview-meter-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
	}

	.plan-overview-meter-fill.is-all {
		background: var(--ok);
	}

	.plan-overview-value {
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.plan-overview-counts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		min-width: 0;
		color: var(--ink-secondary);
	}

	.plan-overview-count b {
		margin-left: 2px;
		font-weight: 700;
		color: var(--ink);
	}

	.plan-overview-count.is-blocked,
	.plan-overview-count.is-blocked b {
		color: var(--danger-text);
	}
</style>
