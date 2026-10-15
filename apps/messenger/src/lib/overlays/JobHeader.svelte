<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Bot, Hold, PlanStatus, SessionSummary } from '@real-bot/protocol';
	import type { Snippet } from 'svelte';
	import type { Copy } from '../copy.ts';
	import { holdLabel } from '../sidebar/holds-list.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import StopMenu from '../chat/StopMenu.svelte';
	import { planStopItems, type StopChoice } from '../chat/stop-menu.ts';
	import TraceJobSwitcher from './TraceJobSwitcher.svelte';
	import { countedTicketCount, openTicketCount, parkedTicketCount, planTitle, totalTicketCount } from './plan-board.ts';
	import { lastChangeLabel } from './plan-requirements.ts';
	import type { JobState } from './job-state.svelte.ts';

	/**
	 * A job's title row: the job switcher (a line's own board has its heading instead), how the job
	 * stands, when it last moved, your stops over it, and the stop menu and the close button. What
	 * sits between the titles and those buttons is the parent's.
	 */
	interface Props {
		job: JobState;
		/** A line of yours filed under no job, drawn as a flow of its own (ADR 0083). */
		line: string | null;
		t: Copy;
		/** Where the job's own conversation is, said as the trace's cards say it; null when it has none. */
		place: string | null;
		bots: readonly Bot[];
		sessions: readonly SessionSummary[];
		deletedLabel: string;
		switcherOpen: boolean;
		onSelectJob: (id: string) => void;
		/** Your stops in force; null where the daemon has none, and the board then offers no stop. */
		holds?: readonly Hold[] | null;
		/** A choice from the board's stop menu: this job, or every Bot. Resolves to a refusal to show, or nothing. */
		onStop?: (choice: StopChoice) => Promise<unknown> | void;
		/** Resolves to a refusal to show, or nothing. */
		onLift?: (hold: Hold) => Promise<unknown> | void;
		/** The daemon is out of reach: the stop menu and the lifts show but cannot be pressed. */
		controlsDisabled?: boolean;
		/** Absent in a pane: a pane is closed by its own tab, not by a button inside the content. */
		onClose?: () => void;
		middle?: Snippet;
		/** What the row says of the job beside its stop menu. */
		end?: Snippet;
	}

	let {
		job,
		line,
		t,
		place,
		bots,
		sessions,
		deletedLabel,
		switcherOpen = $bindable(),
		onSelectJob,
		holds = null,
		onStop,
		onLift,
		controlsDisabled = false,
		onClose,
		middle,
		end
	}: Props = $props();

	/** So the board's Escape listener can put focus back on the trigger once it closes the switcher. */
	let jobSwitcher = $state<TraceJobSwitcher>();
	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));

	const planStatus = $derived<PlanStatus>(job.detail?.status ?? (job.trace?.closed_at ? 'done' : 'active'));
	/** 「上次变化 X 前」 ages while the board is open, so the clock it reads ticks now and then. */
	let nowMs = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (nowMs = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	const changeLine = $derived(job.detail ? lastChangeLabel(job.detail, nowMs, t.plan) : null);
	const heading = $derived(
		line ? `${t.traceSteps.lineTitle} · ${job.trace?.title ?? ''}` : job.trace ? `${t.trace.title} · ${planTitle(job.detail ?? job.trace)}` : t.trace.title
	);
	/**
	 * What keeps the job parked on the board: its own parking, and any stop over it that waits to be
	 * lifted — on a Bot's work in it, on the conversation it belongs to, on everything. A stop for now
	 * there is not shown: your next line is the end of it (ADR 0081). Read from the live list, so a
	 * stop made anywhere shows at once.
	 */
	const boardHolds = $derived.by(() => {
		if (!holds || !job.currentId) return [];
		const home = job.detail?.session_id ?? job.trace?.session_id ?? null;
		return holds.filter(
			(hold) =>
				(hold.scope === 'plan' || !hold.lift_on_next_user_message) &&
				(hold.scope === 'global' ||
					(hold.scope === 'plan' && hold.scope_id === job.currentId) ||
					(hold.scope === 'bot_plan' && hold.scope_id?.endsWith(`:${job.currentId}`)) ||
					(hold.scope === 'session' && home !== null && hold.scope_id === home))
		);
	});
	const stopItems = $derived(
		holds && job.currentId && onStop ? planStopItems({ taskId: job.currentId, title: job.trace ? planTitle(job.detail ?? job.trace) : null, holds, t: t.control }) : []
	);

	/** The stop whose lift was refused, said on its chip until you try again. */
	let liftFailed = $state<string | null>(null);

	async function liftFromBoard(hold: Hold): Promise<void> {
		if (!onLift) return;
		liftFailed = null;
		try {
			if (await onLift(hold)) liftFailed = hold.id;
		} catch {
			liftFailed = hold.id;
		}
	}

	function holdText(hold: Hold): string {
		return holdLabel(hold, { bots: botsById, sessions: sessionsById, roster: { deleted: deletedLabel, archived: deletedLabel }, t: t.control });
	}

	export function focusSwitcher(): void {
		jobSwitcher?.focusTrigger();
	}
</script>

<div class="trace-top">
	<header class="trace-header">
		<div class="trace-titles">
			{#if line}
				<!-- One line's own board: nothing to switch to. -->
				<h2 class="trace-line-title" title={job.trace?.title}>{heading}</h2>
			{:else}
				<TraceJobSwitcher
					bind:this={jobSwitcher}
					jobs={job.jobs}
					currentId={job.currentId}
					{heading}
					{t}
					bind:open={switcherOpen}
					{onSelectJob}
				/>
			{/if}
			{#if job.trace && !line}
				<span class="trace-meta">
					<span class="plan-status is-{planStatus}">{t.plan.status[planStatus]}</span>
					{#if job.detail?.dormant_since}
						<span class="plan-status is-dormant" title={t.plan.dormantHint}>{t.plan.dormant}</span>
					{/if}
					{#if job.detail?.kind} · {job.detail.kind}{/if}
					{#if job.detail && totalTicketCount(job.detail.ticket_counts) > 0}
						 · {t.plan.ticketCounts(openTicketCount(job.detail.ticket_counts), countedTicketCount(job.detail.ticket_counts), parkedTicketCount(job.detail.ticket_counts))}
					{/if}
					{#if place} · {place}{/if}
					 · <span class="mono">{job.trace.dir}</span>
				</span>
				{#if changeLine}
					<span class="trace-change" title={job.detail?.last_change ? formatFullTimestamp(job.detail.last_change.at) : undefined}>{changeLine}</span>
				{/if}
				{#if boardHolds.length > 0}
					<ul class="trace-holds" aria-label={t.control.holdsTitle}>
						{#each boardHolds as hold (hold.id)}
							<li class="trace-hold">
								<Icon name="pause" size={12} />
								<span class="trace-hold-label">{holdText(hold)}</span>
								{#if liftFailed === hold.id}
									<span class="trace-hold-error" role="status">{t.control.failed}</span>
								{:else}
									<span class="trace-hold-time mono">{formatMessageTime(hold.created_at)}</span>
								{/if}
								{#if onLift}
									<button type="button" class="trace-hold-lift" disabled={controlsDisabled} onclick={() => void liftFromBoard(hold)}>{t.control.lift}</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
		{@render middle?.()}
		<div class="trace-header-end">
			{@render end?.()}
			{#if stopItems.length > 0 && onStop}
				<StopMenu items={stopItems} {t} placement="below" size="sm" label={t.control.stop} disabled={controlsDisabled} onPick={(item) => onStop(item.choice)} />
			{/if}
			{#if onClose}
			<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
				<Icon name="x" />
			</button>
			{/if}
		</div>
	</header>
</div>

<style>
	/*
	 * The title row — and on a narrow host the tabs under it — above the picture, and nothing else:
	 * the spec lives beside the board or in a tab now, not in a block that pushed the board down.
	 * The block clips nothing, so the plan picker drops out over the board instead of being cut off.
	 * It is the pane's colour, as a conversation's header is: in a workbench pane the active tab
	 * joins whatever is right under it, and a darker title row left that tab a lighter chip
	 * floating over it. The line below still sets the title apart from the board.
	 */
	.trace-top {
		position: relative;
		z-index: 10;
		flex: none;
		display: flex;
		flex-direction: column;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
	}

	.trace-header-end {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.plan-status {
		display: inline-block;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		white-space: nowrap;
		vertical-align: 1px;
	}

	.plan-status.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-status.is-done {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	/* Set aside, not a status of its own: quieter than any, a dashed outline with no fill. */
	.plan-status.is-dormant {
		border-style: dashed;
		border-color: var(--line-hover);
		background: transparent;
		color: var(--muted);
	}

	/* The switch a narrow job puts in the row takes a row of its own under the title. */
	.trace-header {
		flex-wrap: wrap;
		row-gap: 10px;
	}

	.trace-header {
		flex: none;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 14px 10px;
		user-select: none;
	}

	/* The title takes what is left: on a narrow host it never pushes the stop and close buttons onto a row of their own. */
	/* A line's own board has no switcher: its heading is the line, clipped to one row. */
	.trace-line-title {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.trace-titles {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-meta {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* When the job last moved and what moved: freshness, not status, so as quiet as the meta line. */
	.trace-change {
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Your stops over this job, under its title: grey, since stopping was your call, not a fault. */
	.trace-holds {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		margin: 4px 0 0;
		padding: 0;
		list-style: none;
	}

	.trace-hold {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
		min-height: 22px;
		padding: 0 4px 0 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
	}

	.trace-hold-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The label gives way on a narrow board; the time, a refusal and the lift keep their line. */
	.trace-hold-time,
	.trace-hold-error,
	.trace-hold-lift {
		flex-shrink: 0;
		white-space: nowrap;
	}

	.trace-hold-time {
		color: var(--muted);
	}

	.trace-hold-error {
		color: var(--danger-text);
	}

	.trace-hold-lift {
		padding: 1px 7px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
	}

	.trace-hold-lift:hover:not(:disabled) {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.trace-hold-lift:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
