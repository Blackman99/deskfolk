<script lang="ts">
	import type { Bot, TaskDetail, TicketWithArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import Select from '../Select.svelte';
	import ModelPicker from '../ModelPicker.svelte';
	import { actorFace, actorName, dependsTags, ticketObligations, type TicketObligations } from './plan-board.ts';
	import { reviewerHint } from './ticket-lanes.ts';
	import { badgeOf, describeCheck } from './acceptance-checks.ts';
	import type { TicketEdits } from './ticket-edits.svelte.ts';

	/**
	 * The picked ticket, below its card: what it answers to — the spec, as every ticket does, and
	 * what is held to it alone — and its own settings: who reviews it, the model it runs on, what it
	 * waits for.
	 */
	interface Props {
		api: MessengerApi | null;
		detail: TaskDetail;
		ticket: TicketWithArtifacts;
		t: Copy;
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		edits: TicketEdits;
		/** Open the spec the tickets answer to, keeping the picked ticket picked. */
		onShowSpec?: () => void;
		/** The ticket whose list of what it waits for is open. */
		dependsOpen: string | null;
		/**
		 * Who actually ran the ticket's turns, and how many (ADR 0086), where the inspector shows it:
		 * said under the settings, with a press to make the Bot that has been reviewing it in all but
		 * name its reviewer. Left out on the board.
		 */
		ranBy?: ReadonlyMap<string, number> | null;
	}

	let {
		api,
		detail,
		ticket,
		t,
		bots,
		youLabel,
		deletedLabel,
		edits,
		onShowSpec,
		dependsOpen = $bindable(),
		ranBy = null
	}: Props = $props();

	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot] as const)));
	const owes = $derived(ticketObligations(detail, ticket.id));
	const ran = $derived(ranBy ? [...ranBy].sort((a, b) => b[1] - a[1]) : []);
	/** Offered only where reviews are on (level 5) and the Bot may review it. */
	const hint = $derived(
		ranBy && api && detail.submissions_on ? reviewerHint(ticket, ranBy, new Set(reviewerOptions(ticket).map((option) => option.value))) : null
	);

	/** What every ticket meets from the spec, in words: 「验收 4 条、规则 13 条、你的要求 20 条」. */
	function planWideLine(owes: TicketObligations): string {
		const links = t.plan.links;
		const parts: string[] = [];
		if (owes.acceptance > 0) parts.push(links.acceptanceCount(owes.acceptance));
		if (owes.rules > 0) parts.push(links.rulesCount(owes.rules));
		if (owes.planRequirements > 0) parts.push(links.requirementsCount(owes.planRequirements));
		return parts.length > 0 ? links.planWide(parts.join(links.join)) : links.planWideNone;
	}

	/** Who may review a ticket (ADR 0046, from level 5): a Bot of the plan's conversation, never the one on it. */
	function reviewerOptions(ticket: TicketWithArtifacts): Array<{ value: string; label: string }> {
		const owner = ticket.owner_bot_id ?? ticket.worker;
		const able = new Set(detail.reviewer_ids ?? []);
		const options = bots.filter((bot) => able.has(bot.id) && bot.id !== owner).map((bot) => ({ value: bot.id, label: bot.name }));
		// The one set now stays readable by name even once it left the plan's conversation.
		const current = ticket.reviewer_bot_id;
		if (current && !options.some((option) => option.value === current)) {
			options.push({ value: current, label: actorName(current, botsById, youLabel, deletedLabel) });
		}
		return options;
	}
</script>

<!-- What the picked ticket answers to: the spec, as every ticket does, and what is held to it alone. -->
<div class="ticket-owes" role="group" aria-label={t.plan.links.heldTo}>
	<div class="ticket-owes-head">
		<span class="ticket-owes-title">{t.plan.links.heldTo}</span>
		{#if onShowSpec}
			<button type="button" class="ticket-owes-spec" onclick={onShowSpec}>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
					<polyline points="14 2 14 8 20 8"></polyline>
				</svg>
				<span>{t.plan.links.showSpec}</span>
			</button>
		{/if}
	</div>
	<p class="ticket-owes-plan">{planWideLine(owes)}</p>
	{#if owes.requirements.length > 0 || owes.checks.length > 0}
		<span class="ticket-owes-sub">{t.plan.links.onlyThis}</span>
		<ul class="ticket-owes-list">
			{#each owes.requirements as entry (entry.id)}
				<li><span class="ticket-owes-seq mono">R-{entry.seq}</span><span class="ticket-owes-text">「{entry.quote}」</span></li>
			{/each}
			{#each owes.checks as check (check.id)}
				{@const badge = badgeOf(check)}
				<li><span class="ticket-owes-check is-{badge}">{t.plan.checks.status[badge]}</span><span class="ticket-owes-text">{describeCheck(check, t)}</span></li>
			{/each}
		</ul>
	{/if}
</div>
{#if api && edits.hasSettings}
	<!-- Who reviews it, the model it runs on, what it waits for: set on the picked ticket only, label beside menu. -->
	<div class="ticket-settings">
		{#if detail.submissions_on}
			<span class="ticket-setting-label">{t.plan.reviewer}</span>
			<div class="ticket-select-wrap ticket-reviewer-wrap">
				<Select
					value={ticket.reviewer_bot_id ?? ''}
					options={reviewerOptions(ticket)}
					emptyLabel={t.plan.noReviewer}
					size="sm"
					ariaLabel={t.plan.reviewer}
					disabled={edits.patchingId === ticket.id}
					onchange={(value) => edits.changeReviewer(ticket, value)}
				/>
			</div>
		{/if}
		{#if detail.routing_on && edits.modelData.sources.length > 0}
			<span class="ticket-setting-label">{t.plan.modelShort}</span>
			<div class="ticket-select-wrap ticket-model-wrap">
				<ModelPicker
					value={edits.modelValue(ticket)}
					data={edits.modelDataFor(ticket)}
					{t}
					size="sm"
					ariaLabel={t.plan.modelOverride}
					title={t.plan.modelOverride}
					disabled={edits.patchingId === ticket.id}
					onchange={(value) => edits.changeModel(ticket, value)}
				/>
			</div>
		{/if}
		{#if detail.supervision_on && detail.tickets.length > 1}
			<span class="ticket-setting-label">{t.plan.editDepends}</span>
			<button
				type="button"
				class="ticket-depends-toggle"
				aria-expanded={dependsOpen === ticket.id}
				title={t.plan.dependsHint}
				onclick={() => (dependsOpen = dependsOpen === ticket.id ? null : ticket.id)}
			>
				<span class="ticket-depends-value">{dependsTags(ticket, detail.tickets) ?? t.plan.dependsNothing}</span>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
		{/if}
	</div>
{/if}
{#if ranBy}
	<!-- Who ran it beside who is written down for it: the division as it happened. -->
	<div class="ticket-ran">
		<span class="ticket-setting-label">{t.plan.job.ran}</span>
		<span class="ticket-ran-list">
			{#each ran as [bot, turns] (bot)}
				{@const face = actorFace(bot, botsById, youLabel, deletedLabel)}
				<span class="ticket-ran-who" data-ran-bot={bot}>
					<span class="ticket-ran-face" style:background={face.palette?.bg} style:color={face.palette?.text} style:border-color={face.palette?.border}>
						{#if face.src}<img src={face.src} alt="" />{:else}{face.letter}{/if}
					</span>
					{actorName(bot, botsById, youLabel, deletedLabel)} <b class="mono">{turns}</b>
				</span>
			{:else}
				<span class="ticket-ran-none">{t.plan.job.ranNone}</span>
			{/each}
		</span>
	</div>
	{#if hint}
		{@const name = actorName(hint.bot, botsById, youLabel, deletedLabel)}
		<div class="ticket-reviewer-hint">
			<span>{t.plan.job.reviewerHint(name, hint.turns)}</span>
			<button type="button" class="ticket-reviewer-hint-go" disabled={edits.patchingId === ticket.id} onclick={() => edits.changeReviewer(ticket, hint.bot)}>
				{t.plan.job.makeReviewer(name)}
			</button>
		</div>
	{/if}
{/if}

<style>
	.ticket-ran {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: baseline;
		gap: 5px 10px;
		min-width: 0;
		font-size: 12px;
	}

	.ticket-ran-list {
		display: flex;
		flex-wrap: wrap;
		gap: 3px 12px;
		min-width: 0;
	}

	.ticket-ran-who {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.ticket-ran-face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		box-sizing: border-box;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 50%;
		font-size: 9px;
		font-weight: 700;
	}

	.ticket-ran-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.ticket-ran-none {
		color: var(--muted);
	}

	/* A suggestion in the inspector, nothing more: not a line in the conversation, not a card. */
	.ticket-reviewer-hint {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		padding: 7px 9px;
		border-radius: var(--radius-sm);
		background: var(--warn-bg);
		color: var(--ink-secondary);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.ticket-reviewer-hint-go {
		padding: 2px 8px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.ticket-reviewer-hint-go:hover:not(:disabled) {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.ticket-depends-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		width: 100%;
		min-width: 0;
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		line-height: 18px;
		text-align: left;
		cursor: pointer;
	}

	.ticket-depends-toggle svg {
		flex: none;
		color: var(--muted);
		transition: transform 0.2s ease;
	}

	.ticket-depends-toggle:hover,
	.ticket-depends-toggle[aria-expanded='true'] {
		border-color: var(--accent-border);
	}

	.ticket-depends-toggle[aria-expanded='true'] svg {
		transform: rotate(180deg);
		color: var(--accent);
	}

	.ticket-depends-value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The picked ticket's settings: a short label, then its menu, in two aligned columns. */
	.ticket-settings {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 5px 10px;
		min-width: 0;
	}

	.ticket-setting-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		white-space: nowrap;
	}

	.ticket-select-wrap {
		min-width: 0;
	}

	.ticket-settings :global(.real-select-trigger) {
		padding: 3px 8px;
		font-size: 12px;
		line-height: 18px;
		box-shadow: none;
	}

	/* The picked ticket's obligations: the spec it meets with every ticket, and what is its alone. */
	.ticket-owes {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 7px 9px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		font-size: 11.5px;
		color: var(--ink-secondary);
		min-width: 0;
	}

	.ticket-owes-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}

	.ticket-owes-title {
		font-size: 11px;
		font-weight: 700;
		color: var(--accent);
	}

	.ticket-owes-spec {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		padding: 4px 7px;
		min-height: 22px;
		cursor: pointer;
	}

	.ticket-owes-spec:hover {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.ticket-owes-plan {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.ticket-owes-sub {
		margin-top: 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.ticket-owes-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ticket-owes-list li {
		display: flex;
		align-items: baseline;
		gap: 5px;
		min-width: 0;
	}

	.ticket-owes-seq {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		color: var(--muted);
	}

	.ticket-owes-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.ticket-owes-check {
		flex: none;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		line-height: 15px;
	}

	.ticket-owes-check.is-pass {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.ticket-owes-check.is-fail {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.ticket-owes-check.is-blocked,
	.ticket-owes-check.is-error {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	/* Mobile screen adaptations: bigger targets, same layout. */
	@media (max-width: 560px) {
		.ticket-settings :global(.real-select-trigger),
		.ticket-depends-toggle {
			min-height: 34px;
			font-size: 13px;
		}
	}
</style>
