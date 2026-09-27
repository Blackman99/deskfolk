<script lang="ts">
	import type { Ticket } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp } from '../chat/chat-view.ts';
	import { ticketTag } from './plan-board.ts';
	import { roundTime, type TraceRound } from './task-trace.ts';

	interface Props {
		round: TraceRound;
		t: Copy;
		ticketsById: ReadonlyMap<string, Ticket>;
		nameOf: (actor: string) => string;
		onToggle: () => void;
	}

	let { round, t, ticketsById, nameOf, onToggle }: Props = $props();
</script>

<!-- One line per round: folded, it stands in for the whole round; open, it heads it. -->
<button
	type="button"
	class="trace-round"
	class:is-folded={round.folded}
	class:is-live={round.live}
	style="left: {round.header!.x}px; top: {round.header!.y}px; width: {round.header!.width}px; height: {round.header!.height}px;"
	aria-expanded={!round.folded}
	title={round.folded ? t.trace.roundUnfold : t.trace.roundFold}
	onclick={onToggle}
>
	<svg class="trace-round-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>
	{#if round.folded}
		<span class="trace-round-said"><span class="trace-round-who">{nameOf(round.node.actor)}</span>{round.node.summary}</span>
	{/if}
	<span class="trace-round-meta mono" title={formatFullTimestamp(round.node.created_at)}>{roundTime(round.node.created_at)}</span>
	<span class="trace-round-meta">{t.trace.roundCards(round.cards)}{#if round.files > 0}{` · ${t.trace.roundFiles(round.files)}`}{/if}</span>
	{#each round.ticketIds as id (id)}
		{@const ticket = ticketsById.get(id)}
		{#if ticket}
			<span class="trace-ticket-tag mono" title={ticket.title}>{ticketTag(ticket.seq)}</span>
		{/if}
	{/each}
	{#if round.live}
		<span class="trace-round-live" title={t.trace.status.running} aria-label={t.trace.status.running}></span>
	{/if}
</button>

<style>
	/* The ticket a card worked in, as its number; the rail says the rest. Duplicated from TraceCard:
	   both render it and neither is worth a shared component for one small rule. */
	.trace-ticket-tag {
		flex: none;
		padding: 0 5px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		line-height: 15px;
	}

	/* A round's line: quieter than a card when it heads an open round, a list row when folded. */
	.trace-round {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: 1px dashed var(--line);
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		line-height: 1;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
		/* Not the buttons' `all`: a row that slid to its new place while the cards and the view
		   jumped to theirs swung away from under the pointer after a fold, then crept back. */
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
	}

	.trace-round:hover {
		background: var(--line-subtle);
		color: var(--ink-secondary);
	}

	.trace-round:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.trace-round.is-folded {
		border-style: solid;
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.trace-round-caret {
		flex: none;
		transform: rotate(90deg);
		transition: transform 0.15s ease;
	}

	.trace-round.is-folded .trace-round-caret {
		transform: none;
	}

	.trace-round-said {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ink-secondary);
		font-size: 12px;
	}

	.trace-round-who {
		margin-right: 4px;
		color: var(--ink);
		font-weight: 600;
	}

	.trace-round-who::after {
		content: '：';
	}

	.trace-round-meta {
		flex: none;
	}

	/* An open round's line is only its facts; push them to the middle so it reads as a divider. */
	.trace-round:not(.is-folded) {
		justify-content: center;
	}

	.trace-round-live {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
</style>
