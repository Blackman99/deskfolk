<script lang="ts">
	import type { PlanStatus, SessionTaskSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { isOutside } from '../click-outside.ts';
	import { countedTicketCount, isOneShot, openTicketCount, parkedTicketCount, planTitle, totalTicketCount } from './plan-board.ts';

	interface Props {
		jobs: readonly SessionTaskSummary[];
		currentId: string | null;
		heading: string;
		t: Copy;
		/** Bindable so the board's single Escape listener can close this from outside. */
		open?: boolean;
		onSelectJob: (id: string) => void;
	}

	let { jobs, currentId, heading, t, open = $bindable(false), onSelectJob }: Props = $props();

	let titleMenuEl = $state<HTMLDivElement | null>(null);
	let titleTriggerEl = $state<HTMLButtonElement | null>(null);

	/**
	 * The jobs that were one question and its answer fold into a row of their own, so the jobs that
	 * were work stay in view. The one on screen never folds: it is where you are.
	 */
	const folded = $derived(jobs.filter((job) => job.id !== currentId && isOneShot(job)));
	const listed = $derived(jobs.filter((job) => !folded.includes(job)));
	let foldOpen = $state(false);

	// A menu that opens again opens compact.
	$effect(() => {
		if (!open) foldOpen = false;
	});

	/** A row from a daemon that predates plans has neither a status nor counts. */
	function planStatusOf(job: SessionTaskSummary): PlanStatus {
		return job.status ?? (job.closed_at ? 'done' : 'active');
	}

	function toggleSwitcher(event: MouseEvent): void {
		event.stopPropagation();
		open = !open;
	}

	function onMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			open = false;
			titleTriggerEl?.focus();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			const items = Array.from(titleMenuEl?.querySelectorAll<HTMLButtonElement>('.trace-job') ?? []);
			const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
			const next = items[currentIndex + 1] ?? items[0];
			next?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const items = Array.from(titleMenuEl?.querySelectorAll<HTMLButtonElement>('.trace-job') ?? []);
			const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
			const prev = items[currentIndex - 1] ?? items[items.length - 1];
			prev?.focus();
		}
	}

	$effect(() => {
		if (!open) return;
		function onPointerDown(e: PointerEvent): void {
			if (isOutside(e.target as Node, titleMenuEl)) {
				open = false;
			}
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
		};
	});

	$effect(() => {
		if (open) {
			const activeBtn = titleMenuEl?.querySelector<HTMLButtonElement>('.trace-job.is-current');
			activeBtn?.focus();
		}
	});

	/** So the board's own Escape listener can put focus back once it closes this from outside. */
	export function focusTrigger(): void {
		titleTriggerEl?.focus();
	}
</script>

{#snippet jobRow(job: SessionTaskSummary)}
	{@const status = planStatusOf(job)}
	{@const total = totalTicketCount(job.ticket_counts)}
	<button
		type="button"
		role="option"
		class="trace-job"
		class:is-current={job.id === currentId}
		aria-selected={job.id === currentId}
		onclick={() => {
			onSelectJob(job.id);
			titleTriggerEl?.focus();
		}}
	>
		<span class="trace-job-check" aria-hidden="true">
			{#if job.id === currentId}
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="20 6 9 17 4 12"></polyline>
				</svg>
			{/if}
		</span>
		<div class="trace-job-info">
			<span class="trace-job-title">{planTitle(job)}</span>
			<span class="trace-job-meta">
				<span class="plan-status is-{status}">{t.plan.status[status]}</span>
				{#if total > 0} · {t.plan.ticketCounts(openTicketCount(job.ticket_counts), countedTicketCount(job.ticket_counts), parkedTicketCount(job.ticket_counts))}{/if}
				 · <span class="mono">{job.dir}</span>
			</span>
		</div>
	</button>
{/snippet}

{#if jobs.length > 1}
	<div class="trace-title-select" bind:this={titleMenuEl}>
		<button
			type="button"
			class="trace-title-trigger"
			bind:this={titleTriggerEl}
			aria-haspopup="listbox"
			aria-expanded={open}
			onclick={toggleSwitcher}
			title={heading}
		>
			<h2>{heading}</h2>
			<svg
				class="trace-title-arrow"
				class:is-open={open}
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<polyline points="6 9 12 15 18 9"></polyline>
			</svg>
		</button>
		{#if open}
			<div
				class="trace-switcher-popover"
				role="listbox"
				tabindex="-1"
				aria-label={t.trace.title}
				onkeydown={onMenuKeydown}
			>
				{#each listed as job (job.id)}
					{@render jobRow(job)}
				{/each}
				{#if folded.length > 0}
					<button type="button" class="trace-job is-fold" aria-expanded={foldOpen} onclick={() => (foldOpen = !foldOpen)}>
						<span class="trace-job-check" aria-hidden="true">
							<svg class="trace-job-fold-arrow" class:is-open={foldOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="9 6 15 12 9 18"></polyline>
							</svg>
						</span>
						<div class="trace-job-info">
							<span class="trace-job-title">{t.plan.oneShotJobs(folded.length)}</span>
						</div>
					</button>
					{#if foldOpen}
						{#each folded as job (job.id)}
							{@render jobRow(job)}
						{/each}
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<h2>{heading}</h2>
{/if}

<style>
	/* `.trace-titles` is the header's own wrapper, in TraceView; the h2 it sizes renders here. */
	:global(.trace-titles) h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-title-select {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 100%;
	}

	.trace-title-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		margin: -3px -6px;
		padding: 3px 6px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		text-align: left;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.trace-title-trigger:hover {
		background: var(--chip);
		border-color: var(--line-subtle);
	}

	.trace-title-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trace-title-arrow {
		flex: none;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	.trace-title-arrow.is-open {
		transform: rotate(180deg);
	}

	.trace-switcher-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 100;
		min-width: 260px;
		max-width: min(440px, calc(100vw - 32px));
		max-height: 280px;
		overflow-y: auto;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		padding: 4px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-job {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		text-align: left;
		font-size: 12px;
		transition: background 0.12s ease, color 0.12s ease;
		box-sizing: border-box;
	}

	.trace-job:hover,
	.trace-job:focus-visible {
		background: var(--chip);
		outline: none;
	}

	/* The fold row: a quiet line, its arrow turning to point down once it is open. */
	.trace-job.is-fold {
		align-items: center;
		color: var(--muted);
	}

	.trace-job.is-fold .trace-job-check {
		margin-top: 0;
		color: var(--muted);
	}

	.trace-job-fold-arrow {
		transition: transform 0.15s ease;
	}

	.trace-job-fold-arrow.is-open {
		transform: rotate(90deg);
	}

	.trace-job.is-current {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
		font-weight: 500;
	}

	.trace-job-check {
		flex: none;
		width: 14px;
		height: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-top: 2px;
		color: var(--accent);
	}

	.trace-job-info {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-job-title {
		font-weight: inherit;
		color: inherit;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-job-meta {
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-job.is-current .trace-job-meta {
		color: color-mix(in srgb, var(--accent) 70%, var(--muted));
	}

	/* Duplicated from TraceView: the header's own meta line shows the same pill outside this popover. */
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
</style>
