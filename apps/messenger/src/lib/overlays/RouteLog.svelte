<script lang="ts">
	import { onMount } from 'svelte';
	import { formatDurationMs, formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import type { Copy } from '../copy.ts';
	import type { RouteLogRow } from './route-log.ts';
	import {
		blamedRowCount,
		emptyRouteLogFilter,
		facetTriggerLabel,
		feedbackRowCount,
		filterRouteLogRows,
		routeLogFacets,
		routeLogFilterActive,
		toggleFilterValue,
		type RouteLogFacetOption,
		type RouteLogFilter
	} from './route-log-filter.ts';
	import { listWindow } from './route-log-window.ts';

	interface Props {
		rows: RouteLogRow[];
		sessionTitle: string;
		loading: boolean;
		/** The endpoint only earns a chip once more than one is configured. */
		showEndpoint: boolean;
		t: Copy;
		onClose: () => void;
		onJump: (messageId: string) => void;
	}

	let { rows, sessionTitle, loading, showEndpoint, t, onClose, onJump }: Props = $props();

	/** Feedback bodies stay folded until asked for; one open turn at a time keeps the list scannable. */
	let openFeedback = $state<string | null>(null);
	/** Local to this open overlay; closing the pane unmounts and drops it. */
	let filter = $state<RouteLogFilter>(emptyRouteLogFilter());
	/** Which facet menu is open; one at a time, none once you click outside. */
	let openFacet = $state<string | null>(null);

	const facets = $derived(routeLogFacets(rows));
	const showEndpointFacet = $derived(showEndpoint && facets.providers.length > 1);
	const filtered = $derived(filterRouteLogRows(rows, filter));
	const filtering = $derived(routeLogFilterActive(filter));
	const subtitle = $derived(
		filtering
			? t.routes.subtitleFiltered(sessionTitle, filtered.length, rows.length)
			: t.routes.subtitle(sessionTitle, rows.length)
	);
	const feedbackCount = $derived(feedbackRowCount(rows));
	const blamedCount = $derived(blamedRowCount(rows));

	/** The gap under each row; it belongs to the row's pitch when the window does its arithmetic. */
	const ROW_GAP_PX = 8;
	/** The scrolling box's own top padding, which sits above row 0. */
	const LIST_TOP_PX = 14;

	let scrollEl = $state<HTMLElement | null>(null);
	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	/** Measured pitch per row index; a hole falls back to the estimate until the row has been seen. */
	let heights = $state<number[]>([]);

	const view = $derived(
		listWindow({
			count: filtered.length,
			scrollTop: scrollTop - LIST_TOP_PX,
			viewportHeight,
			heights
		})
	);
	const visible = $derived(filtered.slice(view.start, view.end));

	function onScroll(): void {
		if (scrollEl) scrollTop = scrollEl.scrollTop;
	}

	function resetList(): void {
		if (scrollEl) scrollEl.scrollTop = 0;
		scrollTop = 0;
		heights = [];
	}

	function setFilter(next: RouteLogFilter): void {
		filter = next;
		resetList();
	}

	function clearFilters(): void {
		openFacet = null;
		setFilter(emptyRouteLogFilter());
	}

	function onFacetKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !openFacet) return;
		// The shell also closes this overlay on Escape; the first press is only the menu.
		event.preventDefault();
		event.stopPropagation();
		openFacet = null;
	}

	onMount(() => {
		function onPointerDown(event: PointerEvent): void {
			if (!openFacet) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest('.route-facet')) return;
			openFacet = null;
		}
		function onKeydown(event: KeyboardEvent): void {
			if (event.key !== 'Escape' || !openFacet) return;
			// Capture, so the shell's window listener does not close the overlay on this press.
			event.preventDefault();
			event.stopPropagation();
			openFacet = null;
		}
		document.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('keydown', onKeydown, true);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeydown, true);
		};
	});

	/** Records what a row actually measures, so the window stops guessing once it has been on screen. */
	function measure(node: HTMLElement, index: number) {
		let at = index;
		const apply = () => {
			const pitch = node.offsetHeight + ROW_GAP_PX;
			if (Math.abs((heights[at] ?? 0) - pitch) <= 0.5) return;
			const next = heights.slice();
			next[at] = pitch;
			heights = next;
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(node);
		return {
			update(nextIndex: number) {
				at = nextIndex;
				apply();
			},
			destroy() {
				observer.disconnect();
			}
		};
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="route-log-overlay"
	role="dialog"
	aria-modal="true"
	aria-label={t.routes.title}
	tabindex="-1"
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
>
	<div class="route-log-pane">
		<header class="route-log-header shrink-0 flex items-start justify-between gap-6 px-8 py-7 bg-sidebar-bg">
			<div class="flex items-center gap-5 min-w-0">
				<span class="route-log-icon inline-flex items-center justify-center shrink-0 rounded-sm bg-accent-tint text-accent" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="8" y1="6" x2="21" y2="6"></line>
						<line x1="8" y1="12" x2="21" y2="12"></line>
						<line x1="8" y1="18" x2="21" y2="18"></line>
						<line x1="3" y1="6" x2="3.01" y2="6"></line>
						<line x1="3" y1="12" x2="3.01" y2="12"></line>
						<line x1="3" y1="18" x2="3.01" y2="18"></line>
					</svg>
				</span>
				<div class="route-log-titles min-w-0 flex flex-col gap-[1px]">
					<h2>{t.routes.title}</h2>
					<span class="text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis">{subtitle}</span>
				</div>
			</div>
			<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
		</header>

		{#if rows.length > 0}
			<div class="route-filter-bar">
				<div class="route-filter-top">
					<div class="route-search-wrap">
						<svg class="route-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="11" cy="11" r="8"></circle>
							<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
						</svg>
						<input
							type="text"
							class="route-search-input"
							placeholder={t.routes.filterSearchPlaceholder}
							aria-label={t.routes.filterSearchAria}
							value={filter.query}
							oninput={(e) => setFilter({ ...filter, query: e.currentTarget.value })}
						/>
						{#if filter.query}
							<button
								type="button"
								class="route-search-clear"
								title={t.routes.filterClearSearch}
								onclick={() => setFilter({ ...filter, query: '' })}
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<line x1="18" y1="6" x2="6" y2="18"></line>
									<line x1="6" y1="6" x2="18" y2="18"></line>
								</svg>
							</button>
						{/if}
					</div>
					{#if filtering}
						<button type="button" class="route-filter-clear-all" onclick={clearFilters}>
							{t.routes.filterClearAll}
						</button>
					{/if}
				</div>
				<div class="route-filter-facets">
					{@render facetMenu(
						'outcome',
						t.routes.facetOutcome,
						filter.outcomes,
						facets.outcomes,
						(value) =>
							setFilter({
								...filter,
								outcomes: toggleFilterValue(filter.outcomes, value as (typeof filter.outcomes)[number])
							}),
						() => setFilter({ ...filter, outcomes: [] }),
						true
					)}
					{@render facetMenu('bot', t.routes.facetBot, filter.botIds, facets.bots, (value) =>
						setFilter({ ...filter, botIds: toggleFilterValue(filter.botIds, value) }), () =>
						setFilter({ ...filter, botIds: [] }), false)}
					{@render facetMenu('model', t.routes.facetModel, filter.models, facets.models, (value) =>
						setFilter({ ...filter, models: toggleFilterValue(filter.models, value) }), () =>
						setFilter({ ...filter, models: [] }), false)}
					{@render facetMenu('kind', t.routes.facetKind, filter.signatures, facets.signatures, (value) =>
						setFilter({ ...filter, signatures: toggleFilterValue(filter.signatures, value) }), () =>
						setFilter({ ...filter, signatures: [] }), false)}
					{#if showEndpointFacet}
						{@render facetMenu('endpoint', t.routes.facetEndpoint, filter.providers, facets.providers, (value) =>
							setFilter({ ...filter, providers: toggleFilterValue(filter.providers, value) }), () =>
							setFilter({ ...filter, providers: [] }), false)}
					{/if}
					<div class="route-filter-divider" aria-hidden="true"></div>
					<button
						type="button"
						class="route-toggle-chip is-feedback"
						class:is-active={filter.hasFeedback}
						aria-pressed={filter.hasFeedback}
						onclick={() => setFilter({ ...filter, hasFeedback: !filter.hasFeedback })}
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
						</svg>
						<span>{t.routes.filterFeedback}</span>
						{#if feedbackCount > 0}
							<span class="route-toggle-badge mono">{feedbackCount}</span>
						{/if}
					</button>
					<button
						type="button"
						class="route-toggle-chip is-blamed"
						class:is-active={filter.blamedModel}
						aria-pressed={filter.blamedModel}
						onclick={() => setFilter({ ...filter, blamedModel: !filter.blamedModel })}
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
							<line x1="12" y1="9" x2="12" y2="13"></line>
							<line x1="12" y1="17" x2="12.01" y2="17"></line>
						</svg>
						<span>{t.routes.filterBlamed}</span>
						{#if blamedCount > 0}
							<span class="route-toggle-badge mono">{blamedCount}</span>
						{/if}
					</button>
				</div>
			</div>
			<p class="muted route-log-hint">{t.routes.hint}</p>
		{/if}

		<div
			class="route-log-body"
			bind:this={scrollEl}
			bind:clientHeight={viewportHeight}
			onscroll={onScroll}
		>
			{#if rows.length === 0}
				<p class="muted route-log-empty m-0 text-12 leading-normal">{loading ? t.routes.loading : t.routes.none}</p>
			{:else if filtered.length === 0}
				<div class="route-log-filter-empty">
					<p class="route-empty-title">{t.routes.filterNoMatch}</p>
					<p class="route-empty-desc">{t.routes.filterNoMatchHint}</p>
					<button type="button" class="route-empty-clear-btn" onclick={clearFilters}>
						{t.routes.filterClearAll}
					</button>
				</div>
			{:else}
				<ul
					class="route-log-list"
					style="padding-top: {view.padTop}px; padding-bottom: {view.padBottom}px"
				>
					{#each visible as row, i (row.turnId)}
						<li class="route-row" use:measure={view.start + i}>
							<button
								type="button"
								class="route-row-main"
								title={t.routes.jump}
								onclick={() => onJump(row.triggerMessageId)}
							>
								<span class="flex items-center gap-3">
									<span class="route-bot min-w-0 text-12p5 font-semibold text-ink whitespace-nowrap overflow-hidden text-ellipsis" class:is-unknown={!row.botKnown}>{row.botName}</span>
									<span class="route-outcome is-{row.outcome}">{row.outcomeLabel}</span>
									<span class="route-time mono ml-auto shrink-0 text-10p5 text-muted-light" title={formatFullTimestamp(row.createdAt)}>
										{formatMessageTime(row.createdAt)}
									</span>
								</span>
								<span class="route-row-meta flex flex-wrap items-center gap-2">
									<span class="route-chip is-model mono" title={row.model}>{row.model}</span>
									<span class="route-chip">{t.routes.thinkingPrefix} {row.thinkingLabel}</span>
									<span class="route-chip" title={t.routes.kindLabel}>{row.signatureLabel}</span>
									{#if showEndpoint && row.providerName}
										<span class="route-chip is-endpoint" title={t.routes.endpoint}>
											{row.providerName}
										</span>
									{/if}
									{#if row.durationMs !== null}
										<span class="route-duration mono text-10p5 text-muted-light">{formatDurationMs(row.durationMs)}</span>
									{/if}
								</span>
								{#if row.reason}
									<span class="route-why">
										<span class="route-why-label shrink-0 font-semibold text-muted-light">{t.routes.pickReason}</span>
										<span>{row.reason}</span>
									</span>
								{/if}
								{#if row.review}
									<span class="route-review" class:is-model={row.review.blamedModel}>
										<span class="route-review-head flex flex-wrap items-center gap-[5px]">
											<span class="route-review-tag font-semibold text-muted-light">{t.routes.reviewTitle}</span>
											<span class="route-review-fault font-semibold text-ink-secondary">{row.review.faultLabel}</span>
											{#if row.review.directionLabel}
												<span class="route-review-direction">{row.review.directionLabel}</span>
											{/if}
											{#if row.review.rounds > 0}
												<span class="route-review-rounds">{t.routes.reviewRounds(row.review.rounds)}</span>
											{/if}
										</span>
										{#if row.review.reason}
											<span class="route-review-reason">{row.review.reason}</span>
										{/if}
									</span>
								{/if}
								{#if row.failReason}
									<span class="route-fail flex items-start gap-[5px] text-11p5 leading-[1.4] text-danger-text">
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
										<span>{row.failReason}</span>
									</span>
								{/if}
							</button>
							{#if row.feedback.length > 0}
								{@const open = openFeedback === row.turnId}
								<button
									type="button"
									class="route-feedback-toggle"
									aria-expanded={open}
									onclick={() => (openFeedback = open ? null : row.turnId)}
								>
									<svg
										class="route-caret"
										class:is-open={open}
										width="11"
										height="11"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2.4"
										stroke-linecap="round"
										stroke-linejoin="round"
									><polyline points="9 18 15 12 9 6"></polyline></svg>
									<span>{t.routes.feedbackCount(row.feedback.length)}</span>
								</button>
								{#if open}
									<ul class="route-feedback">
										{#each row.feedback as note (note.message_id)}
											<li class="route-feedback-item">
												<p class="route-feedback-body">{note.body}</p>
												<span
													class="route-feedback-time mono shrink-0 pt-[1px] text-10 text-muted-light"
													title={formatFullTimestamp(note.created_at)}
												>
													{formatMessageTime(note.created_at)}
												</span>
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>

{#snippet facetMenu(
	name: string,
	label: string,
	selected: readonly string[],
	options: RouteLogFacetOption[],
	onToggle: (value: string) => void,
	onClear: () => void,
	paintOutcome: boolean
)}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<details
		class="route-facet"
		open={openFacet === name}
		onkeydown={onFacetKeydown}
	>
		<summary
			class="route-facet-btn"
			class:is-active={selected.length > 0}
			onclick={(e) => {
				e.preventDefault();
				openFacet = openFacet === name ? null : name;
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					openFacet = openFacet === name ? null : name;
				}
			}}
		>
			<span>{facetTriggerLabel(selected, options, label)}</span>
			<svg class="route-facet-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="6 9 12 15 18 9"></polyline>
			</svg>
		</summary>
		<div class="route-facet-popover">
			<div class="route-facet-popover-head">
				<span>{label}</span>
				{#if selected.length > 0}
					<button type="button" class="route-facet-reset" onclick={onClear}>{t.routes.filterFacetClear}</button>
				{/if}
			</div>
			<ul class="route-facet-list">
				{#each options as opt (opt.value)}
					<li>
						<button
							type="button"
							class="route-facet-item"
							class:is-selected={selected.includes(opt.value)}
							onclick={() => {
								onToggle(opt.value);
								openFacet = name;
							}}
						>
							<span class="route-facet-check" aria-hidden="true">
								{#if selected.includes(opt.value)}
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
										<polyline points="20 6 9 17 4 12"></polyline>
									</svg>
								{/if}
							</span>
							{#if paintOutcome}
								<span class="route-outcome is-{opt.value}">{opt.label}</span>
							{:else}
								<span class="route-facet-name" class:mono={name === 'model'}>{opt.label}</span>
							{/if}
							<span class="route-facet-count mono">{opt.count}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</details>
{/snippet}

<style>
	/* The overlay's own look. Scoped, so Svelte reports a rule this markup stopped using. */

	/* Borders stay in CSS: this project blocks the border utilities, see uno.config.ts. */
	.route-log-header {
		border-bottom: 1px solid var(--line);
	}

	.route-log-icon {
		width: 28px;
		height: 28px;
		border: 1px solid var(--accent-border);
	}

	.route-filter-bar {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 16px 12px;
		background: var(--sidebar-bg);
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}

	.route-filter-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.route-search-wrap {
		position: relative;
		flex: 1;
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.route-search-icon {
		position: absolute;
		left: 8px;
		color: var(--muted);
		pointer-events: none;
	}

	.route-search-input {
		width: 100%;
		height: 28px;
		padding: 0 26px;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		font-family: var(--font);
		font-size: 12px;
		color: var(--ink);
		box-shadow: var(--shadow-xs);
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
		box-sizing: border-box;
	}

	.route-search-input::placeholder {
		color: var(--muted);
	}

	.route-search-input:hover {
		border-color: var(--line-hover);
	}

	.route-search-input:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.route-search-clear {
		position: absolute;
		right: 6px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition:
			color 0.12s ease,
			background 0.12s ease;
	}

	.route-search-clear:hover {
		background: var(--chip);
		color: var(--ink);
	}

	.route-filter-clear-all {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition:
			color 0.12s ease,
			background 0.12s ease;
	}

	.route-filter-clear-all:hover {
		color: var(--accent);
		background: var(--chip);
	}

	.route-filter-facets {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.route-facet {
		position: relative;
	}

	.route-facet-btn {
		list-style: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 24px;
		padding: 0 8px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-sm);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink-secondary);
		cursor: pointer;
		user-select: none;
		transition: all 0.12s ease;
		box-sizing: border-box;
	}

	.route-facet-btn::-webkit-details-marker {
		display: none;
	}

	.route-facet-btn::marker {
		content: '';
	}

	.route-facet-btn:hover {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.route-facet[open] .route-facet-btn,
	.route-facet-btn:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.route-facet-btn.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
		font-weight: 600;
	}

	.route-facet-arrow {
		color: var(--muted);
		transition: transform 0.15s ease;
	}

	.route-facet[open] .route-facet-arrow {
		transform: rotate(180deg);
		color: var(--accent);
	}

	.route-facet-popover {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 50;
		min-width: 190px;
		max-width: 280px;
		max-height: 240px;
		overflow-y: auto;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		padding: 4px;
		box-sizing: border-box;
	}

	.route-facet-popover-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px 6px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		border-bottom: 1px solid var(--line-subtle);
		margin-bottom: 4px;
	}

	.route-facet-reset {
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 11px;
		cursor: pointer;
		padding: 0;
	}

	.route-facet-reset:hover {
		text-decoration: underline;
	}

	.route-facet-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.route-facet-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		transition: background 0.1s ease;
		box-sizing: border-box;
	}

	.route-facet-item:hover {
		background: var(--chip);
	}

	.route-facet-item.is-selected {
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 500;
	}

	.route-facet-check {
		width: 12px;
		height: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		flex-shrink: 0;
	}

	.route-facet-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.route-facet-count {
		font-size: 10.5px;
		color: var(--muted-light);
		flex-shrink: 0;
	}

	.route-facet-item.is-selected .route-facet-count {
		color: var(--accent);
	}

	.route-filter-divider {
		width: 1px;
		height: 16px;
		background: var(--line);
		margin: 0 2px;
	}

	.route-toggle-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 24px;
		padding: 0 8px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-sm);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--muted);
		cursor: pointer;
		transition: all 0.12s ease;
		box-sizing: border-box;
	}

	.route-toggle-chip:hover {
		border-color: var(--line-hover);
		color: var(--ink-secondary);
	}

	.route-toggle-chip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.route-toggle-chip.is-feedback.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
		font-weight: 600;
	}

	.route-toggle-chip.is-blamed.is-active {
		background: var(--warn-bg);
		border-color: var(--warn-line);
		color: var(--warn-text);
		font-weight: 600;
	}

	.route-toggle-badge {
		font-size: 10px;
		opacity: 0.85;
	}

	.route-log-filter-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
	}

	.route-empty-title {
		margin: 0 0 4px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.route-empty-desc {
		margin: 0 0 16px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
		max-width: 280px;
	}

	.route-empty-clear-btn {
		height: 28px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--chip-line);
		background: var(--chip);
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		cursor: pointer;
		transition: all 0.12s ease;
	}

	.route-empty-clear-btn:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.route-log-overlay {
	  position: fixed;
	  inset: 0;
	  z-index: 70;
	  display: flex;
	  justify-content: flex-end;
	  background: var(--modal-backdrop);
	  backdrop-filter: blur(6px);
	  -webkit-backdrop-filter: blur(6px);
	  animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.route-log-pane {
	  width: min(560px, calc(100vw - 72px));
	  height: 100%;
	  min-width: 0;
	  display: flex;
	  flex-direction: column;
	  overflow: hidden;
	  background: var(--pane);
	  border-left: 1px solid var(--line);
	  box-shadow: -16px 0 36px -6px rgba(15, 23, 42, 0.18);
	  animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.route-log-titles h2 {
	  margin: 0;
	  font-size: 14px;
	  font-weight: 600;
	  color: var(--ink);
	}

	.route-log-body {
	  flex: 1;
	  min-height: 0;
	  overflow-y: auto;
	  /* The top padding is a fixed offset the windowing subtracts from scrollTop. */
	  padding: 14px 16px 20px;
	}

	.route-log-hint {
	  flex-shrink: 0;
	  margin: 0;
	  padding: 12px 16px;
	  font-size: 12px;
	  line-height: 1.5;
	  border-bottom: 1px solid var(--line-subtle);
	}

	.route-log-list {
	  list-style: none;
	  margin: 0;
	  /* padding-top / padding-bottom are set inline: they stand in for the rows outside the window. */
	  padding: 0;
	}

	.route-row {
	  /* Every row carries the same gap, so one pitch per row is all the windowing needs to know. */
	  margin-bottom: 8px;
	  border: 1px solid var(--line);
	  border-radius: var(--radius-md);
	  background: var(--sidebar-bg);
	  overflow: hidden;
	}

	.route-row-main {
	  display: flex;
	  flex-direction: column;
	  gap: 6px;
	  width: 100%;
	  padding: 9px 10px;
	  border: 0;
	  background: transparent;
	  color: inherit;
	  font: inherit;
	  text-align: left;
	  cursor: pointer;
	  transition: background 0.15s ease;
	}

	.route-row-main:hover {
	  background: var(--chip);
	}

	.route-bot.is-unknown {
	  color: var(--muted);
	  font-weight: 500;
	  font-style: italic;
	}

	.route-outcome {
	  flex-shrink: 0;
	  font-size: 10.5px;
	  font-weight: 600;
	  line-height: 1.35;
	  padding: 1px 6px;
	  border-radius: 9999px;
	  border: 1px solid transparent;
	  white-space: nowrap;
	}

	.route-outcome.is-completed {
	  background: var(--ok-bg);
	  color: var(--ok-text);
	  border-color: var(--ok-line);
	}

	.route-outcome.is-failed {
	  background: var(--danger-bg);
	  color: var(--danger-text);
	  border-color: var(--danger-line);
	}

	.route-outcome.is-interrupted {
	  background: var(--warn-bg);
	  color: var(--warn-text);
	  border-color: var(--warn-line);
	}

	.route-outcome.is-live,
	.route-outcome.is-redirected {
	  background: var(--accent-tint);
	  color: var(--accent);
	  border-color: var(--accent-border);
	}

	.route-outcome.is-stopped {
	  background: var(--chip);
	  color: var(--muted);
	  border-color: var(--chip-line);
	}

	.route-chip {
	  max-width: 100%;
	  font-size: 10.5px;
	  font-weight: 500;
	  line-height: 1.35;
	  padding: 1px 6px;
	  border-radius: var(--radius-sm);
	  background: var(--chip);
	  color: var(--ink-secondary);
	  border: 1px solid var(--chip-line);
	  white-space: nowrap;
	  overflow: hidden;
	  text-overflow: ellipsis;
	}

	.route-chip.is-model {
	  max-width: 160px;
	  background: var(--accent-tint);
	  color: var(--accent);
	  border-color: var(--accent-border);
	}

	.route-chip.is-endpoint {
	  max-width: 120px;
	  background: transparent;
	  color: var(--muted);
	  border-style: dashed;
	}

	.route-why {
	  display: flex;
	  align-items: baseline;
	  gap: 5px;
	  font-size: 11.5px;
	  line-height: 1.45;
	  color: var(--muted);
	}

	.route-review {
	  display: flex;
	  flex-direction: column;
	  gap: 3px;
	  padding: 6px 8px;
	  border-radius: var(--radius-sm);
	  border: 1px solid var(--line-subtle);
	  background: var(--pane);
	  font-size: 11.5px;
	  line-height: 1.45;
	}

	/* A verdict that blamed the model is the one that changes later picks. */
	.route-review.is-model {
	  border-color: var(--warn-line);
	  background: var(--warn-bg);
	}

	.route-review.is-model .route-review-fault {
	  color: var(--warn-text);
	}

	.route-review-direction,
	.route-review-rounds {
	  color: var(--muted);
	}

	.route-review-reason {
	  color: var(--ink-secondary);
	  overflow-wrap: anywhere;
	}

	.route-fail svg {
	  flex-shrink: 0;
	  margin-top: 1px;
	}

	.route-feedback-toggle {
	  display: flex;
	  align-items: center;
	  gap: 5px;
	  width: 100%;
	  padding: 6px 10px;
	  border: 0;
	  border-top: 1px solid var(--line-subtle);
	  background: transparent;
	  color: var(--muted);
	  font-size: 11.5px;
	  font-weight: 500;
	  text-align: left;
	  cursor: pointer;
	  transition:
	    color 0.15s ease,
	    background 0.15s ease;
	}

	.route-feedback-toggle:hover {
	  color: var(--ink-secondary);
	  background: var(--chip);
	}

	.route-caret {
	  flex-shrink: 0;
	  transition: transform 0.15s ease;
	}

	.route-caret.is-open {
	  transform: rotate(90deg);
	}

	.route-feedback {
	  list-style: none;
	  margin: 0;
	  padding: 0 10px 9px;
	  display: flex;
	  flex-direction: column;
	  gap: 6px;
	}

	.route-feedback-item {
	  display: flex;
	  align-items: flex-start;
	  gap: 6px;
	  padding: 6px 8px;
	  border-radius: var(--radius-sm);
	  background: var(--pane);
	  border: 1px solid var(--line-subtle);
	}

	.route-feedback-body {
	  flex: 1;
	  min-width: 0;
	  margin: 0;
	  font-size: 11.5px;
	  line-height: 1.45;
	  color: var(--ink-secondary);
	  overflow-wrap: anywhere;
	}
</style>
