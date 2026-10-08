<script lang="ts">
	import SpendIcon from './SpendIcon.svelte';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { SpendCopy } from './spend-copy.ts';
	import type { SpendLedger } from './spend-ledger.svelte.ts';
	import type { SpendRangeIssue, SpendRangePreset } from './spend-query.ts';

	interface Props {
		copy: SpendCopy;
		ledger: SpendLedger;
		api: MessengerApi | null;
		section: 'overview' | 'details';
		switchSection: (next: 'overview' | 'details') => void;
		sectionKey: (event: KeyboardEvent, current: 'overview' | 'details') => void;
		/** The narrow page's way out. A desktop pane leaves this unset and has no back button. */
		onClose?: () => void;
		backLabel?: string;
	}

	let { copy, ledger, api, section, switchSection, sectionKey, onClose, backLabel = '' }: Props = $props();

	const ranges: SpendRangePreset[] = ['today', 'last7', 'last30', 'all', 'custom'];

	function rangeMessage(issue: SpendRangeIssue): string {
		if (issue === 'blank') return copy.rangeBlank;
		if (issue === 'reversed') return copy.rangeReversed;
		return copy.rangeInvalid;
	}
</script>

<header class="spend-head">
	<div class="spend-toolbar">
		<div class="spend-title-area">
			{#if onClose}
				<button type="button" class="icon-button back" aria-label={backLabel} onclick={onClose}>
					<SpendIcon name="back" />
				</button>
			{/if}
			<div class="heading">
				<h1>{copy.title}</h1>
				<p>{copy.subtitle}</p>
			</div>
		</div>

		<div class="spend-header-actions">
			<label class="period-control">
				<span class="sr">{copy.period}</span>
				<span class="period-icon text-muted" aria-hidden="true"><SpendIcon name="calendar" /></span>
				<select
					aria-label={copy.period}
					value={ledger.view.range}
					onchange={(event) => ledger.setRange(event.currentTarget.value as SpendRangePreset)}
				>
					{#each ranges as range}
						<option value={range}>{copy.ranges[range]}</option>
					{/each}
				</select>
				<span class="period-chevron text-muted" aria-hidden="true"><SpendIcon name="chevron" /></span>
			</label>

			<button
				type="button"
				class="icon-button refresh"
				class:is-spinning={ledger.loading}
				aria-label={copy.refresh}
				title={copy.refresh}
				disabled={ledger.loading || !!ledger.rangeIssue || !api}
				onclick={() => ledger.refresh()}
			>
				<SpendIcon name="refresh" />
			</button>
		</div>
	</div>

	<div class="expandable-controls">
		{#if ledger.view.range === 'custom'}
			<div class="custom-dates">
				<div class="custom-date-inputs">
					<label class="date">
						<span class="date-label">{copy.from}</span>
						<input type="date" aria-label={copy.from} aria-invalid={!!ledger.rangeIssue} bind:value={ledger.view.customFrom} />
					</label>
					<span class="date-sep text-muted" aria-hidden="true">→</span>
					<label class="date">
						<span class="date-label">{copy.to}</span>
						<input type="date" aria-label={copy.to} aria-invalid={!!ledger.rangeIssue} bind:value={ledger.view.customTo} />
					</label>
				</div>
				{#if ledger.rangeIssue}
					<p class="field-error" role="alert">{rangeMessage(ledger.rangeIssue)}</p>
				{/if}
			</div>
		{/if}

		{#if ledger.chips.length}
			<div class="chips" aria-label={copy.filters}>
				<span class="filter-icon text-muted" aria-hidden="true"><SpendIcon name="filter" /></span>
				{#each ledger.chips as chip (chip.key)}
					<button type="button" class="chip" aria-label={copy.clearFilter(chip.label)} onclick={chip.clear}>
						<span class="chip-label">{chip.label}</span>
						<span class="chip-close" aria-hidden="true"><SpendIcon name="close" /></span>
					</button>
				{/each}
				<button type="button" class="text-action clear-all" onclick={() => (ledger.drill = {})}>
					{copy.clearAll}
				</button>
			</div>
		{/if}
	</div>

	<div class="spend-navigation">
		<div class="view-tabs" role="tablist" aria-label={copy.title}>
			{#each ['overview', 'details'] as name}
				<button
					type="button"
					role="tab"
					aria-selected={section === name}
					tabindex={section === name ? 0 : -1}
					class="tab-btn"
					class:is-active={section === name}
					onclick={() => switchSection(name as 'overview' | 'details')}
					onkeydown={(event) => sectionKey(event, name as 'overview' | 'details')}
				>
					{name === 'overview' ? copy.overview : copy.details}
				</button>
			{/each}
		</div>
		<span class="update-status" role="status">{ledger.loading && ledger.summary ? copy.refreshing : ''}</span>
	</div>
</header>

<style>
	.spend-head {
		flex: none;
		padding: 16px 24px 0;
		background: var(--pane);
		border-bottom: 1px solid var(--line);
		z-index: 2;
		position: relative;
		max-height: 58%;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
	}

	.spend-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-width: 0;
	}

	.spend-title-area {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
	}

	.spend-header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
	}

	.heading {
		flex: 1;
		min-width: 0;
	}

	h1, p {
		margin: 0;
	}

	h1 {
		font-size: 20px;
		line-height: 1.3;
		font-weight: 650;
		letter-spacing: -0.025em;
		color: var(--ink);
	}

	.heading p {
		margin-top: 2px;
		color: var(--muted);
		font-size: 12px;
		letter-spacing: -0.01em;
	}

	.icon-button {
		width: 38px;
		height: 38px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--muted);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.icon-button:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.icon-button.refresh.is-spinning :global(svg) {
		animation: spin 0.8s linear infinite;
	}

	.period-control {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		transition: border-color 0.15s ease;
	}

	.period-control:hover {
		border-color: var(--line-hover);
	}

	.period-control select {
		appearance: none;
		-webkit-appearance: none;
		padding: 0 32px 0 32px;
		height: 38px;
		border: 0;
		border-radius: inherit;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}

	.period-icon {
		position: absolute;
		left: 10px;
		pointer-events: none;
		display: flex;
		align-items: center;
	}

	.period-chevron {
		position: absolute;
		right: 10px;
		pointer-events: none;
		display: flex;
		align-items: center;
	}

	.expandable-controls {
		min-height: 0;
	}

	.custom-dates {
		margin-top: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.custom-date-inputs {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 520px;
	}

	.date {
		min-width: 0;
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
	}

	.date-label {
		flex: none;
		font-weight: 500;
	}

	.date input {
		min-width: 0;
		width: 100%;
		padding: 6px 10px;
		height: 38px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		transition: border-color 0.15s ease;
	}

	.date input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.date-sep {
		font-size: 13px;
		flex: none;
	}

	.field-error {
		font-size: 12px;
		color: var(--danger);
		font-weight: 500;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 10px 0 4px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: min(100%, 320px);
		min-height: 32px;
		padding: 4px 10px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.chip:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-close {
		display: flex;
		align-items: center;
		opacity: 0.8;
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
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

	.text-action:hover:not(:disabled) {
		opacity: 0.8;
		text-decoration: underline;
	}

	.clear-all {
		color: var(--muted);
	}

	.clear-all:hover {
		color: var(--ink);
	}

	.spend-navigation {
		margin-top: 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		border-top: 1px solid var(--line-subtle);
		padding-top: 4px;
	}

	.view-tabs {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		background: var(--line-subtle);
		border-radius: var(--radius-sm);
	}

	.tab-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		min-height: 32px;
		padding: 4px 16px;
		border-radius: var(--radius-xs);
		font-size: 13px;
		font-weight: 550;
		cursor: pointer;
		transition: 0.15s cubic-bezier(0.16, 1, 0.3, 1);
		transition-property: var(--transition-props);
	}

	.tab-btn:hover:not(.is-active) {
		color: var(--ink);
	}

	.tab-btn.is-active {
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		font-weight: 600;
	}

	.update-status {
		font-size: 11px;
		color: var(--muted);
	}

	.sr {
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

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	button:focus-visible, select:focus-visible, input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (prefers-reduced-motion: reduce) {
		.icon-button.refresh.is-spinning :global(svg) {
			animation: none;
		}
	}

	@container spend (max-width: 620px) {
		.spend-head {
			padding: max(12px, env(safe-area-inset-top, 0px)) max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));
		}

		.spend-toolbar {
			gap: 10px;
		}

		.heading p {
			display: none;
		}

		h1 {
			font-size: 18px;
		}

		.period-control {
			border-radius: var(--radius-sm);
		}

		.period-control select {
			max-width: 130px;
			font-size: 12px;
			height: 44px;
			padding-left: 28px;
			padding-right: 26px;
		}

		.period-icon {
			left: 8px;
		}

		.period-chevron {
			right: 8px;
		}

		.icon-button {
			width: 44px;
			height: 44px;
		}

		.spend-navigation {
			margin-top: 10px;
			padding-top: 0;
			border-top: 0;
		}

		.view-tabs {
			width: 100%;
			display: flex;
		}

		.tab-btn {
			flex: 1;
			min-height: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 13px;
		}

		.chip {
			min-height: 44px;
			padding: 6px 12px;
		}

		.custom-date-inputs {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}

		.date-sep {
			display: none;
		}

		.date {
			flex-direction: column;
			align-items: flex-start;
			gap: 4px;
		}

		.date input {
			width: 100%;
			box-sizing: border-box;
			height: 44px;
		}
	}

	@container spend (max-width: 360px) {
		.spend-head {
			padding-left: 10px;
			padding-right: 10px;
		}

		.spend-toolbar {
			gap: 6px;
		}

		.period-control select {
			max-width: 110px;
			font-size: 12px;
		}

		.update-status {
			display: none;
		}
	}
</style>
