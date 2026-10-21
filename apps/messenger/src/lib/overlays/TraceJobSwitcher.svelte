<script lang="ts">
	import Icon from '../Icon.svelte';
	import { flushSync } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import BottomSheet from '../BottomSheet.svelte';
	import { PHONE_SHEET_QUERY } from '../bottom-sheet.ts';
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
	/** On a phone the jobs open as a sheet from the bottom (`BottomSheet`). */
	const phone = new MediaQuery(PHONE_SHEET_QUERY);

	/**
	 * The jobs that were one question and its answer fold into a row of their own, so the jobs that
	 * were work stay in view. The one on screen never folds: it is where you are.
	 */
	const folded = $derived(jobs.filter((job) => job.id !== currentId && isOneShot(job)));
	const listed = $derived(jobs.filter((job) => !folded.includes(job)));
	let foldOpen = $state(false);

	/**
	 * In the popover the two kinds sit in a column beside the list, as the model picker's sources do,
	 * so the one-question jobs are a hover away however many jobs there are. It opens on the work,
	 * where the job on screen is. A phone's sheet keeps the fold row.
	 */
	type Kind = 'work' | 'oneShot';
	let kind = $state<Kind>('work');
	const twoKinds = $derived(listed.length > 0 && folded.length > 0);
	const kinds = $derived<{ key: Kind; count: number }[]>([{ key: 'work', count: listed.length }, { key: 'oneShot', count: folded.length }]);
	const shown = $derived(twoKinds ? (kind === 'work' ? listed : folded) : listed.length > 0 ? listed : folded);

	// A menu that opens again opens compact, on the work.
	$effect(() => {
		if (!open) {
			foldOpen = false;
			kind = 'work';
		}
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
		} else if (event.key === 'ArrowLeft' && twoKinds && !phone.current) {
			event.preventDefault();
			titleMenuEl?.querySelector<HTMLButtonElement>('.trace-job-kind.is-active')?.focus();
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

	/** On the kinds: up and down show the other kind, right goes into its list. */
	function onKindsKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			showKind(kind === 'work' ? 'oneShot' : 'work', 'kind');
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			focusList();
		} else {
			onMenuKeydown(event);
		}
	}

	function showKind(next: Kind, focus: 'kind' | 'list'): void {
		kind = next;
		flushSync();
		if (focus === 'kind') titleMenuEl?.querySelector<HTMLButtonElement>('.trace-job-kind.is-active')?.focus();
		else focusList();
	}

	/** Into the list: on the job on screen when it is there, else its first. */
	function focusList(): void {
		const list = titleMenuEl?.querySelector('.trace-job-list');
		(list?.querySelector<HTMLButtonElement>('.trace-job.is-current') ?? list?.querySelector<HTMLButtonElement>('.trace-job'))?.focus();
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
		if (open && !phone.current) {
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
			if (!phone.current) titleTriggerEl?.focus();
		}}
	>
		<span class="trace-job-check" aria-hidden="true">
			{#if job.id === currentId}
				<Icon name="check" size={12} />
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

{#snippet jobList()}
	{#each listed as job (job.id)}
		{@render jobRow(job)}
	{/each}
	{#if folded.length > 0}
		<button type="button" class="trace-job is-fold" aria-expanded={foldOpen} onclick={() => (foldOpen = !foldOpen)}>
			<span class="trace-job-check" aria-hidden="true">
				<Icon name="chevron-right" size={12} class={['trace-job-fold-arrow', { 'is-open': foldOpen }]} />
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
			<h2 class="trace-heading">{heading}</h2>
			<Icon name="chevron-down" size={12} class={['trace-title-arrow', { 'is-open': open }]} />
		</button>
		{#if open && phone.current}
			<BottomSheet title={t.trace.title} closeLabel={t.common.close} onClose={() => (open = false)}>
				<div class="trace-switcher-sheet" role="listbox" tabindex="-1" aria-label={t.trace.title} onkeydown={onMenuKeydown}>
					{@render jobList()}
				</div>
			</BottomSheet>
		{:else if open}
			<div class="trace-switcher-popover" class:has-kinds={twoKinds} role="dialog" aria-label={t.trace.title}>
				{#if twoKinds}
					<div class="trace-job-kinds" role="tablist" aria-orientation="vertical" aria-label={t.plan.jobKinds.label} tabindex="-1" onkeydown={onKindsKeydown}>
						{#each kinds as entry (entry.key)}
							<button
								type="button"
								role="tab"
								class="trace-job-kind"
								class:is-active={entry.key === kind}
								aria-selected={entry.key === kind}
								tabindex="-1"
								onmouseenter={() => (kind = entry.key)}
								onclick={() => showKind(entry.key, 'list')}
							>
								<span class="trace-job-kind-label">{t.plan.jobKinds[entry.key]}</span>
								<span class="trace-job-kind-count">{entry.count}</span>
							</button>
						{/each}
					</div>
				{/if}
				<div class="trace-job-list" role="listbox" tabindex="-1" aria-label={twoKinds ? t.plan.jobKinds[kind] : t.trace.title} onkeydown={onMenuKeydown}>
					{#each shown as job (job.id)}
						{@render jobRow(job)}
					{/each}
				</div>
			</div>
		{/if}
	</div>
{:else}
	<h2 class="trace-heading">{heading}</h2>
{/if}

<style>
	/* One row wherever the switcher sits, the flow's header or the map's: clipped only when the row runs out. */
	h2.trace-heading {
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
		/* No `max-width: 100%`: the select is as wide as this button's margin box, 12px under its own width, so a cap held the title short. */
		min-width: 0;
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

	:global(.icon.trace-title-arrow) {
		flex: none;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	:global(.icon.trace-title-arrow.is-open) {
		transform: rotate(180deg);
	}

	.trace-switcher-popover {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 100;
		display: flex;
		min-width: 260px;
		max-width: min(440px, calc(100vw - 32px));
		max-height: 280px;
		overflow: hidden;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		box-sizing: border-box;
	}

	/* Both kinds: one width, so moving from one kind to the other does not resize it; it fits a job tab at its narrowest. */
	.trace-switcher-popover.has-kinds {
		width: min(492px, calc(100vw - 32px));
		max-width: none;
	}

	/* The kinds stay put while the list scrolls; drawn as the model picker's sources. */
	.trace-job-kinds {
		flex: 0 0 112px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px;
		border-right: 1px solid var(--line);
		background: var(--line-subtle);
		box-sizing: border-box;
		outline: none;
	}

	.trace-job-kind {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 7px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.trace-job-kind.is-active {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
	}

	.trace-job-kind:focus-visible {
		outline: 2px solid var(--accent-border);
		outline-offset: -2px;
	}

	.trace-job-kind-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.trace-job-kind-count {
		flex: none;
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.trace-job-list {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		box-sizing: border-box;
		outline: none;
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

	:global(.icon.trace-job-fold-arrow) {
		transition: transform 0.15s ease;
	}

	:global(.icon.trace-job-fold-arrow.is-open) {
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

	/* On a phone's sheet: rows for a thumb. */
	.trace-switcher-sheet {
		display: flex;
		flex-direction: column;
		gap: 2px;
		outline: none;
	}

	.trace-switcher-sheet .trace-job {
		gap: 12px;
		min-height: 56px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
	}

	.trace-switcher-sheet .trace-job-title {
		font-size: 15px;
	}

	.trace-switcher-sheet .trace-job-check {
		margin-top: 2px;
	}
</style>
