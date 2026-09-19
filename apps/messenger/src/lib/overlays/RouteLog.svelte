<script lang="ts">
	import { formatDurationMs, formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import type { Copy } from '../copy.ts';
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
					<span class="text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis">{t.routes.subtitle(sessionTitle, rows.length)}</span>
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
								<span class="flex items-center gap-3">
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
								{#if row.reason}
									<span class="route-why">
										<span class="route-why-label">{t.routes.pickReason}</span>
										<span>{row.reason}</span>
									</span>
								{/if}
								{#if row.review}
									<span class="route-review" class:is-model={row.review.blamedModel}>
										<span class="route-review-head">
											<span class="route-review-tag">{t.routes.reviewTitle}</span>
											<span class="route-review-fault">{row.review.faultLabel}</span>
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

	.route-log-empty {
	  margin: 0;
	  font-size: 12px;
	  line-height: 1.5;
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


	.route-bot {
	  min-width: 0;
	  font-size: 12.5px;
	  font-weight: 600;
	  color: var(--ink);
	  white-space: nowrap;
	  overflow: hidden;
	  text-overflow: ellipsis;
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

	.route-time {
	  margin-left: auto;
	  flex-shrink: 0;
	  font-size: 10.5px;
	  color: var(--muted-light);
	}

	.route-row-meta {
	  display: flex;
	  flex-wrap: wrap;
	  align-items: center;
	  gap: 4px;
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

	.route-duration {
	  font-size: 10.5px;
	  color: var(--muted-light);
	}

	.route-why {
	  display: flex;
	  align-items: baseline;
	  gap: 5px;
	  font-size: 11.5px;
	  line-height: 1.45;
	  color: var(--muted);
	}

	.route-why-label {
	  flex-shrink: 0;
	  font-weight: 600;
	  color: var(--muted-light);
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

	.route-review-head {
	  display: flex;
	  flex-wrap: wrap;
	  align-items: center;
	  gap: 5px;
	}

	.route-review-tag {
	  font-weight: 600;
	  color: var(--muted-light);
	}

	.route-review-fault {
	  font-weight: 600;
	  color: var(--ink-secondary);
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

	.route-fail {
	  display: flex;
	  align-items: flex-start;
	  gap: 5px;
	  font-size: 11.5px;
	  line-height: 1.4;
	  color: var(--danger-text);
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

	.route-feedback-time {
	  flex-shrink: 0;
	  padding-top: 1px;
	  font-size: 10px;
	  color: var(--muted-light);
	}
</style>
