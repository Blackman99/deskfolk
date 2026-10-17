<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Ticket } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp } from '../chat/chat-view.ts';
	import { ticketTag } from './plan-board.ts';
	import { roundTime, saidNothing, type TraceRound } from './task-trace.ts';

	interface Props {
		round: TraceRound;
		t: Copy;
		ticketsById: ReadonlyMap<string, Ticket>;
		nameOf: (actor: string) => string;
		onToggle: () => void;
	}

	let { round, t, ticketsById, nameOf, onToggle }: Props = $props();
</script>

{#snippet tickets()}
	{#each round.ticketIds as id (id)}
		{@const ticket = ticketsById.get(id)}
		{#if ticket}
			<span class="trace-ticket-tag mono" title={ticket.title}>{ticketTag(ticket.seq)}</span>
		{/if}
	{/each}
	{#if round.live}
		<span class="trace-round-live" title={t.trace.status.running} aria-label={t.trace.status.running}></span>
	{/if}
{/snippet}

{#snippet marks()}
	<!-- What came of the round, where it is worth a look: turns cut short, files, steps that went wrong. -->
	{#if round.cut > 0}
		<span class="trace-round-mark is-cut">{t.trace.roundCut(round.cut)}</span>
	{/if}
	{#if round.files > 0}
		<span class="trace-round-mark">{t.trace.roundFiles(round.files)}</span>
	{/if}
	{#if round.anomalies > 0}
		<span class="trace-round-mark is-anomalous">{t.traceSteps.anomaliesCount(round.anomalies)}</span>
	{/if}
{/snippet}

<!--
	One line per round: open, it heads it; folded, it stands in for the whole round, and says where the
	round got to under the line that started it (ADR 0094), not how many cards it took.
-->
<button
	type="button"
	class="trace-round"
	class:is-folded={round.folded}
	class:has-outcome={round.folded && round.last !== null}
	class:is-live={round.live}
	style="left: {round.header!.x}px; top: {round.header!.y}px; width: {round.header!.width}px; height: {round.header!.height}px;"
	aria-expanded={!round.folded}
	title={round.folded ? `${t.trace.roundUnfold} · ${t.trace.roundCards(round.cards)}` : t.trace.roundFold}
	onclick={onToggle}
>
	{#if round.folded}
		<span class="trace-round-row">
			<Icon name="chevron-right" size={12} class="trace-round-caret" />
			<span class="trace-round-said"><span class="trace-round-who">{nameOf(round.node.actor)}</span>{round.node.summary}</span>
			<span class="trace-round-meta mono" title={formatFullTimestamp(round.node.created_at)}>{roundTime(round.node.created_at)}</span>
			{@render tickets()}
			{#if !round.last}
				{@render marks()}
			{/if}
		</span>
		{#if round.last}
			<span class="trace-round-row is-outcome">
				<span class="trace-round-said"><span class="trace-round-who">{nameOf(round.last.actor)}</span>{saidNothing(round.last) ? t.trace.silent : round.last.summary}</span>
				{@render marks()}
			</span>
		{/if}
	{:else}
		<Icon name="chevron-right" size={12} class="trace-round-caret" />
		<span class="trace-round-meta mono" title={formatFullTimestamp(round.node.created_at)}>{roundTime(round.node.created_at)}</span>
		<span class="trace-round-meta">{t.trace.roundCards(round.cards)}{#if round.files > 0}{` · ${t.trace.roundFiles(round.files)}`}{/if}</span>
		{@render tickets()}
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
		border-radius: var(--radius-full);
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

	/* Two rows when folded: the line that started the round, and where it got to. */
	.trace-round.has-outcome {
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 5px;
	}

	.trace-round-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		width: 100%;
	}

	/* Under the caret's column, an arrow from the line above to what it led to. */
	.trace-round-row.is-outcome {
		padding-left: 18px;
	}

	.trace-round-row.is-outcome .trace-round-said::before {
		content: '→';
		margin-right: 4px;
		color: var(--muted);
	}

	.trace-round-row.is-outcome .trace-round-who {
		color: var(--ink-secondary);
	}

	.trace-round-mark {
		flex: none;
		color: var(--muted);
	}

	.trace-round-mark.is-cut {
		color: var(--danger-text);
	}

	.trace-round-mark.is-anomalous {
		color: var(--warn-text);
	}

	.trace-round :global(.trace-round-caret) {
		flex: none;
		transform: rotate(90deg);
		transition: transform 0.15s ease;
	}

	.trace-round.is-folded :global(.trace-round-caret) {
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
