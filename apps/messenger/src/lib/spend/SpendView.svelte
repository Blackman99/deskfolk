<script lang="ts">
	import { tick } from 'svelte';
	import type { SpendTotals } from '@real-bot/protocol';
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
		backLabel = ''
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

	function tokenMetrics(row: Pick<SpendTotals, 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'>) {
		return [
			{ label: copy.input, value: row.input_tokens },
			{ label: copy.cached, value: row.cached_tokens },
			{ label: copy.output, value: row.output_tokens },
			{ label: copy.reasoning, value: row.reasoning_tokens },
		];
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
				<SpendSummary {copy} {locale} totals={ledger.summary.totals} {num} {money} {tokenMetrics} />

				<SpendCategories {copy} {locale} {timeZone} {ledger} categories={ledger.summary.categories} {num} {money} />

				<SpendGroupTable {copy} {ledger} {num} {money} {tokenMetrics} {onOpenSession} />
			{:else}
				<SpendDetailTable {copy} {locale} {timeZone} {ledger} {num} {tokenMetrics} {onOpenTrigger} />
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
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.spend-scroll > * {
		flex-shrink: 0;
		min-width: 0;
	}

	.quiet {
		min-height: 38px;
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

	.quiet:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
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

	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading-mark {
			animation: none;
		}
	}

	@container spend (max-width: 620px) {
		.spend-scroll {
			padding: 14px max(12px, env(safe-area-inset-left, 0px)) max(24px, calc(16px + env(safe-area-inset-bottom, 0px))) max(12px, env(safe-area-inset-right, 0px));
			gap: 16px;
		}
	}
</style>
