<script lang="ts">
	import { formatDurationMs, formatFullTimestamp, formatMessageTime } from './chat-view.ts';
	import type { Copy } from './copy.ts';
	import type { RouteLogRow } from './route-log.ts';
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
			count: rows.length,
			scrollTop: scrollTop - LIST_TOP_PX,
			viewportHeight,
			heights
		})
	);
	const visible = $derived(rows.slice(view.start, view.end));

	function onScroll(): void {
		if (scrollEl) scrollTop = scrollEl.scrollTop;
	}

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
		<header class="route-log-header">
			<div class="route-log-heading">
				<span class="route-log-icon" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="8" y1="6" x2="21" y2="6"></line>
						<line x1="8" y1="12" x2="21" y2="12"></line>
						<line x1="8" y1="18" x2="21" y2="18"></line>
						<line x1="3" y1="6" x2="3.01" y2="6"></line>
						<line x1="3" y1="12" x2="3.01" y2="12"></line>
						<line x1="3" y1="18" x2="3.01" y2="18"></line>
					</svg>
				</span>
				<div class="route-log-titles">
					<h2>{t.routes.title}</h2>
					<span class="route-log-subtitle">{t.routes.subtitle(sessionTitle, rows.length)}</span>
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
			<p class="muted route-log-hint">{t.routes.hint}</p>
		{/if}

		<div
			class="route-log-body"
			bind:this={scrollEl}
			bind:clientHeight={viewportHeight}
			onscroll={onScroll}
		>
			{#if rows.length === 0}
				<p class="muted route-log-empty">{loading ? t.routes.loading : t.routes.none}</p>
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
								<span class="route-row-head">
									<span class="route-bot" class:is-unknown={!row.botKnown}>{row.botName}</span>
									<span class="route-outcome is-{row.outcome}">{row.outcomeLabel}</span>
									<span class="route-time mono" title={formatFullTimestamp(row.createdAt)}>
										{formatMessageTime(row.createdAt)}
									</span>
								</span>
								<span class="route-row-meta">
									<span class="route-chip is-model mono" title={row.model}>{row.model}</span>
									<span class="route-chip">{t.routes.thinkingPrefix} {row.thinkingLabel}</span>
									<span class="route-chip" title={t.routes.kindLabel}>{row.signatureLabel}</span>
									{#if showEndpoint && row.providerName}
										<span class="route-chip is-endpoint" title={t.routes.endpoint}>
											{row.providerName}
										</span>
									{/if}
									{#if row.durationMs !== null}
										<span class="route-duration mono">{formatDurationMs(row.durationMs)}</span>
									{/if}
								</span>
								{#if row.failReason}
									<span class="route-fail">
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
													class="route-feedback-time mono"
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
