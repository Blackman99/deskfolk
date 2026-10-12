<script lang="ts">
	import { tick } from 'svelte';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatTokens, formatUsd } from '../spend-format.ts';
	import { spendCopyFor, type SpendCopy } from './spend-copy.ts';
	import QualityReport from './QualityReport.svelte';
	import SpendCategories from './SpendCategories.svelte';
	import SpendDetailTable from './SpendDetailTable.svelte';
	import SpendGroupTable from './SpendGroupTable.svelte';
	import SpendHeader from './SpendHeader.svelte';
	import SpendIcon from './SpendIcon.svelte';
	import SpendSummary from './SpendSummary.svelte';
	import SpendCap from './SpendCap.svelte';
	import { SpendLedger } from './spend-ledger.svelte.ts';

	/** The spend ledger fills its host. Width comes from the container, not the window. */
	interface Props {
		api: MessengerApi | null;
		/** Bumped when a `spend.created` or `spend.repriced` arrives. The ledger itself is not kept on the client. */
		revision?: number;
		locale?: 'zh' | 'en';
		/** The machine's zone. Day buckets and "today" are cut here. */
		timeZone?: string;
		/** Where the view remembers its range and dimension. Tests pass their own. */
		storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
		/** Clock for "today" and the custom-range default. Tests pin a day with this. */
		now?: () => Date;
		/** Open the conversation this row belongs to. */
		onOpenSession?: (sessionId: string) => void;
		/** Open the message that woke a turn. */
		onOpenTrigger?: (sessionId: string, messageId: string) => void;
		/** The narrow page's way out. A desktop pane leaves this unset and has no back button. */
		onClose?: () => void;
		backLabel?: string;
		/** The day's spend cap (ADR 0088), in USD; null is none. */
		capUsd?: number | null;
		/** Sets the cap; left out, the overview has no cap card. Resolves to a refusal or nothing. */
		onSetCap?: (usd: number | null) => Promise<unknown>;
	}

	let {
		api,
		revision = 0,
		locale = 'zh',
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
		storage = typeof localStorage === 'undefined' ? null : localStorage,
		now = () => new Date(),
		onOpenSession,
		onOpenTrigger,
		onClose,
		backLabel = '',
		capUsd = null,
		onSetCap
	}: Props = $props();

	const copy: SpendCopy = $derived(spendCopyFor(locale));
	const ledger = new SpendLedger({
		api: () => api,
		revision: () => revision,
		timeZone: () => timeZone,
		storage: () => storage,
		now: () => now,
		copy: () => copy
	});

	let section = $state<'overview' | 'details'>('overview');
	let scrollArea: HTMLDivElement | undefined = $state();
	const scrollPositions = { overview: 0, details: 0 };

	function switchSection(next: 'overview' | 'details'): void {
		if (next === section) return;
		if (scrollArea) scrollPositions[section] = scrollArea.scrollTop;
		const top = scrollPositions[next];
		section = next;
		void tick().then(() => { if (scrollArea) scrollArea.scrollTop = top; });
	}

	function sectionKey(event: KeyboardEvent, current: 'overview' | 'details'): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'details' : current === 'overview' ? 'details' : 'overview';
		switchSection(next);
		const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
		tabs?.[next === 'overview' ? 0 : 1]?.focus();
	}

	function num(value: number | null): string {
		return value == null ? copy.dash : formatTokens(value);
	}

	function money(ticks: number | null, estimated = false): string {
		if (ticks == null) return copy.dash;
		const text = formatUsd(ticks);
		return estimated ? `${text} ${copy.estimated}` : text;
	}
</script>

<section class="spend" aria-label={copy.title} data-spend-view>
	<SpendHeader {copy} {ledger} {api} {section} {switchSection} {sectionKey} {onClose} {backLabel} />

	<div
		class="spend-scroll"
		bind:this={scrollArea}
		onscroll={() => (scrollPositions[section] = scrollArea?.scrollTop ?? 0)}
		role="tabpanel"
		aria-label={section === 'overview' ? copy.overview : copy.details}
		aria-busy={ledger.loading}
	>
		{#if section === 'overview' && onSetCap}
			<SpendCap {copy} {capUsd} {onSetCap} />
		{/if}
		{#if ledger.failed}
			<div class="status-box" role="alert">
				<div class="status-icon-wrap is-error">
					<SpendIcon name="info" />
				</div>
				<strong>{copy.error}</strong>
				<button type="button" class="quiet" onclick={() => ledger.refresh()} disabled={ledger.loading || !!ledger.rangeIssue}>{copy.retry}</button>
			</div>
		{:else if !ledger.summary}
			<div class="loading-state" role="status">
				<span class="loading-mark" aria-hidden="true"></span>
				<span class="loading-label">{copy.loading}</span>
			</div>
		{:else if ledger.summary.totals.calls === 0}
			<div class="empty-state">
				<span class="empty-mark" aria-hidden="true"><SpendIcon name="filter" /></span>
				<h2>{copy.empty}</h2>
				<p>{copy.emptyHint}</p>
				{#if ledger.chips.length}
					<button type="button" class="quiet" onclick={() => (ledger.drill = {})}>{copy.clearAll}</button>
				{/if}
			</div>
		{:else}
			{#if section === 'overview'}
				<SpendSummary {copy} {locale} totals={ledger.summary.totals} {num} {money} />

				<SpendCategories {copy} {locale} {timeZone} {ledger} categories={ledger.summary.categories} {num} />

				<SpendGroupTable {copy} {ledger} {num} {onOpenSession} />
			{:else}
				<SpendDetailTable {copy} {locale} {timeZone} {ledger} {num} {onOpenTrigger} />
			{/if}
		{/if}
		<QualityReport {api} {locale} {revision} />
	</div>
</section>

<style>
	.spend {
		container: spend / inline-size;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		background: var(--sidebar-bg);
		color: var(--ink);
		font-family: var(--font);
	}

	h2, p {
		margin: 0;
	}

	h2 {
		font-size: 14px;
		line-height: 1.4;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.spend-scroll {
		min-width: 0;
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		padding: 20px 24px 28px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Every section is a child component: without :global a section with overflow hidden shrinks to its border. */
	.spend-scroll > :global(*) {
		flex-shrink: 0;
		min-width: 0;
	}

	/*
	 * The ledger's shared parts. Each section is its own component; these are drawn the same in all of them.
	 * `:where` keeps them at one class's weight, so a section's own rule for one of them wins.
	 */
	:where(.spend) :global(.surface) {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		overflow: hidden;
		min-width: 0;
	}

	:where(.spend) :global(.section-head) {
		padding: 14px 18px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	:where(.spend) :global(.section-head-title) {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	:where(.spend) :global(.section-head h2) {
		margin: 0;
		font-size: 14px;
		line-height: 1.4;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	:where(.spend) :global(.section-hint) {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}

	:where(.spend) :global(.segmented) {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
	}

	:where(.spend) :global(.segmented button) {
		border: 0;
		background: transparent;
		border-radius: var(--radius-xs);
		color: var(--muted);
		min-height: 26px;
		padding: 2px 12px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	:where(.spend) :global(.segmented button:hover:not([aria-pressed='true'])) {
		color: var(--ink);
	}

	:where(.spend) :global(.segmented button[aria-pressed='true']) {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		font-weight: 600;
	}

	:where(.spend) :global(.text-action) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		border: 0;
		background: transparent;
		padding: 0 4px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
		text-align: left;
		transition: opacity 0.15s ease;
	}

	:where(.spend) :global(.text-action:hover:not(:disabled)) {
		opacity: 0.8;
		text-decoration: underline;
	}

	:where(.spend) :global(.quiet) {
		min-height: 36px;
		padding: 0 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	:where(.spend) :global(.quiet:hover:not(:disabled)) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	/* A bare icon at the end of a row: open the session, open the message. */
	:where(.spend) :global(.row-icon) {
		position: relative;
		z-index: 1;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	/* Only a real pointer hovers: on a phone a tapped icon would keep the hover after the finger lifts. */
	@media (hover: hover) {
		:where(.spend) :global(.row-icon:hover) {
			background: var(--line-subtle);
			color: var(--accent);
		}
	}

	:where(.spend) :global(.num) {
		font-variant-numeric: tabular-nums;
	}

	:where(.spend) :global(.deleted) {
		display: inline-block;
		padding: 0 5px;
		font-size: 10px;
		font-weight: 500;
		line-height: 16px;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: var(--radius-xs);
		white-space: nowrap;
	}

	:where(.spend) :global(.sr) {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	:where(.spend) :global(:is(button, summary, select, input):focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	:where(.spend) :global(button:disabled) {
		opacity: 0.5;
		cursor: default;
	}

	.empty-state, .loading-state, .status-box {
		padding: 48px 20px;
		color: var(--muted);
		font-size: 13px;
		text-align: center;
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 14px;
	}

	.empty-mark {
		display: inline-flex;
		width: 48px;
		height: 48px;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		color: var(--muted);
	}

	.empty-state h2 {
		font-size: 15px;
	}

	.empty-state p {
		max-width: 280px;
		font-size: 13px;
		line-height: 1.5;
	}

	.loading-mark {
		display: block;
		width: 22px;
		height: 22px;
		border: 2.5px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.status-icon-wrap {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.status-icon-wrap.is-error {
		background: var(--danger-bg);
		color: var(--danger);
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-mark {
			animation: none;
		}
	}

	@container spend (max-width: 620px) {
		.spend-scroll {
			padding: 12px max(12px, env(safe-area-inset-left, 0px)) max(24px, calc(16px + env(safe-area-inset-bottom, 0px))) max(12px, env(safe-area-inset-right, 0px));
			gap: 12px;
		}

		:where(.spend) :global(.section-head) {
			padding: 12px 14px;
		}
	}

	/* A finger needs a bigger target than a pointer; the width alone does not say which one this is. */
	@media (pointer: coarse) {
		:where(.spend) :global(.row-icon) {
			width: 40px;
			height: 40px;
		}
	}
</style>
