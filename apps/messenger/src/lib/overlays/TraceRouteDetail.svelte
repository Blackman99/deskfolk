<script lang="ts">
	import type { Provider, TaskTraceNode } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatDurationMs, formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import type { RouteLogRow } from './route-log.ts';

	interface Props {
		node: TaskTraceNode;
		route: RouteLogRow;
		t: Copy;
		providers: readonly Provider[];
		onJump: (sessionId: string, messageId: string) => void;
		/** The card's own toggle closes this instead: the state it opens on lives in the parent. */
		onClose: () => void;
	}

	let { node, route, t, providers, onJump, onClose }: Props = $props();
</script>

<!-- Unfolded under its own card, the way a file is: what was picked, why, and what came of it. -->
<section class="trace-route" aria-label={t.routes.cardTitle}>
	<header class="trace-route-head">
		<span class="trace-route-title">{t.routes.cardTitle}</span>
		<span class="trace-route-outcome is-{route.outcome}">{route.outcomeLabel}</span>
		<button type="button" class="trace-route-close" title={t.trace.outputClose} aria-label={t.trace.outputClose} onclick={onClose}>
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
		</button>
	</header>
	<div class="trace-route-chips">
		<span class="trace-route-chip is-model mono" title={route.model}>{route.model}</span>
		<span class="trace-route-chip">{t.routes.thinkingPrefix} {route.thinkingLabel}</span>
		<span class="trace-route-chip" title={t.routes.kindLabel}>{route.signatureLabel}</span>
		{#if providers.length > 1 && route.providerName}
			<span class="trace-route-chip" title={t.routes.endpoint}>{route.providerName}</span>
		{/if}
	</div>
	{#if route.durationMs !== null || (route.hops !== null && route.toolErrors !== null)}
		<p class="trace-route-stats mono">
			{#if route.durationMs !== null}{formatDurationMs(route.durationMs)}{/if}{#if route.durationMs !== null && route.hops !== null && route.toolErrors !== null}{' · '}{/if}{#if route.hops !== null && route.toolErrors !== null}{t.routes.execution(route.hops, route.toolErrors)}{/if}
		</p>
	{/if}
	{#if route.failReason}
		<p class="trace-route-fail">{route.failReason}</p>
	{/if}
	{#if route.reason}
		<p class="trace-route-why"><span class="trace-route-label">{t.routes.pickReason}</span>{route.reason}</p>
	{/if}
	{#if route.feedback.length > 0}
		<div class="trace-route-block">
			<span class="trace-route-label">{t.routes.feedbackCount(route.feedback.length)}</span>
			<ul class="trace-route-feedback">
				{#each route.feedback as note (note.message_id)}
					<li>
						<button
							type="button"
							class="trace-route-note"
							title={t.routes.jump}
							onclick={() => onJump(node.session_id, note.message_id)}
						>
							<span class="trace-route-note-body">{note.body}</span>
							<span class="trace-route-note-time mono" title={formatFullTimestamp(note.created_at)}>{formatMessageTime(note.created_at)}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#if route.review}
		<div class="trace-route-block trace-route-review" class:is-model={route.review.blamedModel}>
			<span class="trace-route-review-head">
				<span class="trace-route-label">{t.routes.reviewTitle}</span>
				<span class="trace-route-fault">{route.review.faultLabel}</span>
				{#if route.review.directionLabel}
					<span class="trace-route-direction">{route.review.directionLabel}</span>
				{/if}
				{#if route.review.rounds > 0}
					<span class="trace-route-rounds">{t.routes.reviewRounds(route.review.rounds)}</span>
				{/if}
			</span>
			{#if route.review.reason}
				<span class="trace-route-review-reason">{route.review.reason}</span>
			{/if}
			{#if route.review.retired}
				<span class="trace-route-effect">{t.routes.effectRetired}</span>
			{:else if route.review.effect === 'unknown'}
				<span class="trace-route-effect">{t.routes.effectUnused}</span>
			{:else if route.review.effect === 'followed'}
				<span class="trace-route-effect">{t.routes.effectFollowed}{route.review.cleaner ? ` · ${t.routes.effectCleaner}` : ''}</span>
			{/if}
		</div>
	{/if}
	{#if route.learning}
		<p class="trace-route-learning">
			{route.learning.kind === 'memory'
				? t.routes.learnedMemory(route.learning.label)
				: route.learning.kind === 'skill'
					? t.routes.learnedSkill(route.learning.label)
					: t.routes.learnedNone}
		</p>
	{/if}
</section>

<style>
	.trace-route {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 8px 10px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		font-size: 11.5px;
		color: var(--ink-secondary);
	}

	.trace-route-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.trace-route-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-route-outcome {
		font-size: 10.5px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		border: 1px solid var(--line);
		background: var(--chip);
		color: var(--muted);
		white-space: nowrap;
	}

	.trace-route-outcome.is-completed {
		background: var(--ok-bg);
		color: var(--ok-text);
		border-color: var(--ok-line);
	}

	.trace-route-outcome.is-failed {
		background: var(--danger-bg);
		color: var(--danger-text);
		border-color: var(--danger-line);
	}

	.trace-route-outcome.is-interrupted {
		background: var(--warn-bg);
		color: var(--warn-text);
		border-color: var(--warn-line);
	}

	.trace-route-outcome.is-live,
	.trace-route-outcome.is-redirected {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: var(--accent-border);
	}

	.trace-route-close {
		margin-left: auto;
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.trace-route-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.trace-route-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.trace-route-chip {
		max-width: 100%;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--chip);
		font-size: 10.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-route-chip.is-model {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.trace-route-stats,
	.trace-route-fail,
	.trace-route-why,
	.trace-route-learning {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.trace-route-stats {
		font-size: 10.5px;
		color: var(--muted);
	}

	.trace-route-fail {
		color: var(--danger-text);
	}

	.trace-route-learning {
		color: var(--ok-text);
	}

	.trace-route-label {
		margin-right: 6px;
		font-weight: 600;
		color: var(--muted);
	}

	.trace-route-block {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.trace-route-feedback {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.trace-route-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		width: 100%;
		padding: 5px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
		font-size: 11.5px;
		text-align: left;
		cursor: pointer;
		box-sizing: border-box;
	}

	.trace-route-note:hover {
		border-color: var(--accent-border);
	}

	.trace-route-note-body {
		flex: 1;
		min-width: 0;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.trace-route-note-time {
		flex: none;
		padding-top: 1px;
		font-size: 10px;
		color: var(--muted-light);
	}

	.trace-route-review {
		padding: 6px 8px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
	}

	.trace-route-review.is-model {
		border-color: var(--warn-line);
		background: var(--warn-bg);
	}

	.trace-route-review-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
	}

	.trace-route-fault {
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.trace-route-direction,
	.trace-route-rounds,
	.trace-route-effect {
		font-size: 10.5px;
		color: var(--muted);
	}

	.trace-route-review-reason {
		line-height: 1.45;
		overflow-wrap: anywhere;
	}
</style>
