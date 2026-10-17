<script lang="ts">
	import Icon from '../Icon.svelte';
	import { USER_MEMBER, type TaskTraceNode, type Ticket } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { buildCitedPathTree, citedBundleName, countCitedFiles } from './artifact-tree.ts';
	import { type ActorFace, ticketTag } from './plan-board.ts';
	import type { RouteLogRow } from './route-log.ts';
	import { saidNothing, traceFileName, traceNodeShape } from './task-trace.ts';

	interface Props {
		node: TaskTraceNode;
		t: Copy;
		here: boolean;
		focused: boolean;
		lit: boolean;
		litBlamed: boolean;
		dim: boolean;
		name: string;
		avatar: ActorFace;
		ticket: Ticket | null;
		/** Who a card says woke it, once the connectors are gone; null draws no line. */
		from: string | null;
		/** Where a card from another conversation happened; null when it is this job's own. */
		place: string | null;
		route: RouteLogRow | null;
		routeOpen: boolean;
		onToggleRoute: () => void;
		onOpen: () => void;
		onOpenArtifacts: () => void;
	}

	let {
		node,
		t,
		here,
		focused,
		lit,
		litBlamed,
		dim,
		name,
		avatar,
		ticket,
		from,
		place,
		route,
		routeOpen,
		onToggleRoute,
		onOpen,
		onOpenArtifacts
	}: Props = $props();

	function nodeBundleInfo(node: TaskTraceNode) {
		const tree = buildCitedPathTree(node.artifacts.map((a) => a.path));
		const fileCount = countCitedFiles(tree);
		const bundle = citedBundleName(tree);
		return { tree, fileCount, bundle };
	}

	const shape = $derived(traceNodeShape(node));
</script>

<article
	class="trace-card is-{node.status} is-shape-{shape}"
	class:is-here={here}
	class:is-focus={focused}
	class:is-lit={lit}
	class:is-lit-blamed={litBlamed}
	class:is-dim={dim}
>
	{#if shape === 'decision'}
		<!-- Pointed ends can only be cut, and a cut box loses its border and rings: they are drawn here. -->
		<span class="trace-shape" aria-hidden="true"><span class="trace-shape-fill"></span></span>
	{/if}
	<button type="button" class="trace-card-main" onclick={onOpen} title={t.trace.jump}>
		<span class="trace-card-line">
			<span
				class="trace-avatar"
				class:is-you={node.actor === USER_MEMBER}
				style:background={avatar.palette?.bg}
				style:color={avatar.palette?.text}
				style:border-color={avatar.palette?.border}
				aria-hidden="true"
			>
				{#if avatar.src}
					<img src={avatar.src} alt="" class="avatar-img" />
				{:else}
					{avatar.letter}
				{/if}
			</span>
			<span class="trace-card-who">{name}</span>
			{#if ticket}
				<span class="trace-ticket-tag mono" title={ticket.title}>{ticketTag(ticket.seq)}</span>
			{/if}
			{#if node.actor !== USER_MEMBER}
				{#if node.status !== 'completed'}
					<!-- Your own line has no status worth reading: it was sent. Nor has a finished turn:
					     it is most of the board, and only the others say what they are. -->
					<span class="trace-status is-{node.status}">{t.trace.status[node.status]}</span>
				{/if}
			{:else if node.decision}
				<!-- What you decided here: an answer, a 放行 or 退回, a line sending a ticket back. -->
				<span class="trace-decision is-{node.decision.kind}">{t.trace.decision[node.decision.kind]}</span>
			{/if}
		</span>
		{#if from}
			<span class="trace-woken">{t.trace.wokenBy(from)}</span>
		{/if}
		{#if saidNothing(node)}
			<!-- Its summary would be the line that woke it, read as the Bot saying it. -->
			<span class="trace-silent">{t.trace.silent}</span>
		{:else if node.summary}
			<span class="trace-summary">{node.summary}</span>
		{/if}
		{#if node.ask}
			<span class="trace-wait">{t.trace.waitingAsk} · {node.ask.question}</span>
		{/if}
		{#if node.decision?.question}
			<span class="trace-wait">{t.trace.asked(node.decision.question)}</span>
		{:else if node.decision?.result}
			<span class="trace-wait">{node.decision.result}</span>
		{/if}
		{#if node.approval}
			<span class="trace-wait">{t.trace.waitingApproval}{#if node.approval.summary} · {node.approval.summary}{/if}</span>
		{/if}
		{#if node.passed > 0}
			<span class="trace-passed">{t.trace.passed(node.passed)}</span>
		{/if}
		{#if place !== null}
			<!-- The header names the job's own conversation; only a card from elsewhere says where. -->
			<span class="trace-place">{place}</span>
		{/if}
	</button>
	{#if route}
		<!-- How this turn ran: the model it was given, and the trouble that came of it. -->
		<div class="trace-route-line">
			<button
				type="button"
				class="trace-route-btn"
				class:is-open={routeOpen}
				aria-expanded={routeOpen}
				title={t.routes.cardToggle}
				onclick={onToggleRoute}
			>
				<span class="trace-route-model mono">{route.model}</span>
				<span class="trace-route-meta">{t.routes.thinkingPrefix} {route.thinkingLabel} · {route.signatureLabel}</span>
				<span class="trace-route-flags">
					{#if route.review?.blamedModel}
						<span class="trace-route-flag is-blamed" title={t.routes.filterBlamed}>
							<Icon name="alert-triangle" size={12} />
						</span>
					{/if}
					{#if route.feedback.length > 0}
						<span class="trace-route-flag is-feedback" title={t.routes.feedbackCount(route.feedback.length)}>
							<Icon name="message" size={12} />
							<span class="mono">{route.feedback.length}</span>
						</span>
					{/if}
					{#if route.failReason}
						<span class="trace-route-flag is-failed" title={route.failReason}>
							<Icon name="alert-circle" size={12} />
						</span>
					{/if}
				</span>
				<Icon name="chevron-down" size={12} class="trace-route-caret" />
			</button>
		</div>
	{/if}
	{#if node.artifacts.length > 0}
		{@const isBundle = node.artifacts.length > 1}
		{@const info = isBundle ? nodeBundleInfo(node) : null}
		{@const single = node.artifacts[0]!}
		<div class="trace-files">
			<button
				type="button"
				class="trace-file-btn trace-file"
				class:is-bundle={isBundle}
				onclick={onOpenArtifacts}
				title={isBundle ? node.artifacts.map((a) => a.path).join('\n') : single.path}
			>
				<div class="file-icon-box text-accent flex items-center" aria-hidden="true">
					{#if isBundle}
						<Icon name="folder" />
					{:else}
						<Icon name="file" />
					{/if}
				</div>
				<div class="file-meta-col flex flex-col min-w-0 flex-1">
					<span class="file-title text-12 font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
						{isBundle ? (info?.bundle ?? t.stream.artifactBundle) : traceFileName(single.path)}
					</span>
					<span class="file-sub text-10 text-muted overflow-hidden text-ellipsis whitespace-nowrap" class:mono={!isBundle}>
						{isBundle ? t.stream.artifactBundleCount(info?.fileCount ?? node.artifacts.length) : single.path}
					</span>
				</div>
			</button>
		</div>
	{/if}
</article>

<style>
	/* The ticket a card worked in, as its number; the rail says the rest. Duplicated from TraceRound:
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

	/* Each status sets its colours; the outline of the card (its shape) is drawn from them. */
	.trace-card {
		--card-edge: var(--line);
		--card-bar: var(--muted-light);
		--card-fill: var(--pane);
		--card-ring: none;
		border: 1px solid var(--card-edge);
		border-left: 3px solid var(--card-bar);
		border-radius: var(--radius-md);
		background: var(--card-fill);
		box-shadow: var(--card-ring);
		overflow: hidden;
		transition: opacity 0.15s ease;
	}

	.trace-card.is-running {
		/* The solid accent, not `--accent-border`: at 35% that wash is the same grey-teal as a
		   finished card's line, so the two could not be told apart. */
		--card-edge: var(--accent);
		--card-bar: var(--accent);
		--card-fill: var(--accent-tint);
	}

	.trace-card.is-waiting_approval {
		--card-edge: var(--warn);
		--card-bar: var(--warn);
		--card-fill: var(--warn-bg);
	}

	.trace-card.is-waiting_ask {
		--card-edge: var(--purple);
		--card-bar: var(--purple);
		--card-fill: var(--purple-bg);
	}

	/* A finished turn is most of any job, so it wears no colour: green on nine cards in ten was the
	   board's ground, and the few that need a look — live, waiting, cut — did not stand out of it
	   (ADR 0094). Its stripe is the line's grey, quieter than an unknown status's. */
	.trace-card.is-completed {
		--card-edge: var(--line);
		--card-bar: var(--line);
		--card-fill: var(--pane);
	}

	.trace-card.is-redirected {
		--card-edge: var(--line);
		--card-bar: var(--muted);
		--card-fill: var(--chip);
	}

	.trace-card.is-interrupted,
	.trace-card.is-stopped {
		--card-edge: var(--danger);
		--card-bar: var(--danger);
		--card-fill: var(--danger-bg);
	}

	/* Where you are, as a ring — but only on a card with no status of its own. A live card would
	   otherwise wear the same teal twice, and a finished one is most of the job's own conversation:
	   ringed, the board would be teal where it was meant to go quiet. */
	.trace-card.is-here:not(.is-running):not(.is-waiting_approval):not(.is-waiting_ask):not(.is-completed):not(.is-interrupted):not(.is-stopped) {
		--card-ring: inset 0 0 0 1px var(--accent);
	}

	.trace-card.is-focus,
	.trace-card.is-lit {
		--card-ring: 0 0 0 2px var(--accent);
		--card-ring-color: var(--accent);
	}

	.trace-card.is-lit.is-lit-blamed {
		--card-ring: 0 0 0 2px var(--warn);
		--card-ring-color: var(--warn);
	}

	.trace-card.is-dim {
		opacity: 0.32;
	}

	/* A line of yours starts a flow: rounded ends, as a flowchart's start is drawn. Its status says
	   nothing (it was sent), so it wears no stripe either. */
	.trace-card.is-shape-line {
		border-left-width: 1px;
		border-radius: 20px;
	}

	.trace-card.is-shape-line .trace-card-main {
		padding-inline: 14px;
	}

	.trace-card.is-shape-line :is(.trace-files, .trace-route-line) {
		padding-inline: 14px;
	}

	/* A decision of yours: pointed ends, as a flowchart's decision is drawn, cut to fit a card's text. */
	.trace-card.is-shape-decision {
		--point: 12px;
		position: relative;
		isolation: isolate;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		overflow: visible;
	}

	.trace-shape {
		position: absolute;
		inset: 0;
		z-index: -1;
	}

	/* A cut outline cannot carry a box-shadow, so its ring is four shadows of the outline itself. */
	.trace-card.is-shape-decision:is(.is-focus, .is-lit) .trace-shape {
		filter: drop-shadow(2px 0 0 var(--card-ring-color)) drop-shadow(-2px 0 0 var(--card-ring-color))
			drop-shadow(0 2px 0 var(--card-ring-color)) drop-shadow(0 -2px 0 var(--card-ring-color));
	}

	.trace-shape-fill,
	.trace-shape-fill::after {
		position: absolute;
		clip-path: polygon(
			var(--point) 0,
			calc(100% - var(--point)) 0,
			100% 50%,
			calc(100% - var(--point)) 100%,
			var(--point) 100%,
			0 50%
		);
	}

	.trace-shape-fill {
		inset: 0;
		background: var(--card-edge);
	}

	/* The fills are washes in the dark, and the edge layer under this one would show through: they
	   sit on the board's own colour, as a plain card's do. */
	.trace-shape-fill::after {
		content: '';
		inset: 1px;
		background: linear-gradient(var(--card-fill), var(--card-fill)), var(--pane);
	}

	.trace-card.is-shape-decision:has(.trace-card-main:hover) .trace-shape-fill::after {
		background: linear-gradient(var(--line-subtle), var(--line-subtle)), linear-gradient(var(--card-fill), var(--card-fill)), var(--pane);
	}

	.trace-card.is-shape-decision .trace-card-main {
		padding-inline: calc(var(--point) + 8px);
	}

	.trace-card.is-shape-decision .trace-card-main:hover {
		background: transparent;
	}

	.trace-card.is-shape-decision .trace-files {
		padding-inline: calc(var(--point) + 8px);
	}

	.trace-card-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.trace-card-main:hover {
		background: var(--line-subtle);
	}

	.trace-card-line {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.trace-avatar {
		width: 22px;
		height: 22px;
		flex: none;
		border-radius: 50%;
		border: 1px solid;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		user-select: none;
	}

	.trace-avatar.is-you {
		background: var(--ink);
		color: var(--pane);
		border-color: transparent;
	}

	.trace-card-who {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-status {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted);
	}

	.trace-status.is-running { color: var(--accent); }
	.trace-status.is-waiting_approval { color: var(--warn-text); }
	.trace-status.is-waiting_ask { color: var(--purple); }
	.trace-status.is-redirected { color: var(--muted); }
	.trace-status.is-interrupted,
	.trace-status.is-stopped { color: var(--danger-text); }

	/* A decision of yours: quiet like the status it stands in for, coloured by what it did. */
	.trace-decision {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted);
	}

	.trace-decision.is-approve { color: var(--ok-text); }
	.trace-decision.is-reject,
	.trace-decision.is-rework { color: var(--danger-text); }
	.trace-decision.is-answer { color: var(--purple); }

	.trace-summary,
	.trace-wait,
	.trace-woken,
	.trace-passed,
	.trace-silent,
	.trace-place {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.trace-place,
	.trace-woken,
	.trace-passed,
	.trace-silent {
		font-size: 11px;
		color: var(--muted);
	}

	.trace-wait {
		color: var(--accent);
	}

	.trace-files {
		padding: 0 10px 9px;
	}

	/* How the turn ran, as one line under what it did: model, thinking level, kind, and trouble. */
	.trace-route-line {
		padding: 0 10px 9px;
	}

	.trace-route-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.3;
		text-align: left;
		cursor: pointer;
		box-sizing: border-box;
		transition: border-color 0.15s ease, background 0.15s ease;
	}

	.trace-route-btn:hover,
	.trace-route-btn.is-open {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.trace-route-model {
		flex: 0 1 auto;
		max-width: 50%;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-route-meta {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
	}

	.trace-route-flags {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex: none;
	}

	.trace-route-flag {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 10px;
	}

	.trace-route-flag.is-blamed { color: var(--warn-text); }
	.trace-route-flag.is-feedback { color: var(--accent); }
	.trace-route-flag.is-failed { color: var(--danger-text); }

	.trace-route-btn :global(.trace-route-caret) {
		flex: none;
		color: var(--muted);
		transition: transform 0.15s ease;
	}

	.trace-route-btn.is-open :global(.trace-route-caret) {
		transform: rotate(180deg);
	}

	.trace-file-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s ease, background 0.15s ease;
		color: var(--ink);
		box-sizing: border-box;
	}

	.trace-file-btn:hover,
	.trace-file-btn.is-open {
		border-color: var(--accent-border);
		background: var(--line-subtle);
	}

	.trace-file-btn.is-open {
		background: var(--accent-tint);
	}

	.trace-file-btn .file-icon-box {
		flex: none;
		display: flex;
		align-items: center;
		color: var(--accent);
	}

	.trace-file-btn .file-meta-col {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.trace-file-btn .file-title {
		font-size: 12px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
	}

	.trace-file-btn .file-sub {
		font-size: 10px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
		margin-top: 1px;
	}
</style>
