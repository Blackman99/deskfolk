<script lang="ts">
	/**
	 * A conversation's header in a workbench pane: who it is with and what they are doing, what is
	 * waiting on you here, and the conversation's own actions (pin, flow, settings) in reach.
	 *
	 * The actions are the tab's — the same list its ⋯ and right-click offer — so the two never
	 * disagree. The phone keeps its own header (`ChatHeader.svelte`).
	 */
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, isFileDropSession, youBotPeer } from '../sidebar/session-groups.ts';
	import { botWorkStatus, sidebarStatus } from '../sidebar/session-status.ts';
	import { sessionPresence, sessionTitle } from '../sidebar/session-title.ts';
	import type { TabAction } from '../workbench/layout-types.ts';
	import { waitingInSession } from './waiting.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		session: SessionSummary;
		/** The tab's actions: pin, the flow, the conversation's settings. */
		actions: TabAction[];
	};

	let { runtime, t, session, actions }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		failed: t.sidebar.statusFailed,
		interrupted: t.sidebar.statusInterrupted,
		idle: t.sidebar.statusIdle
	});
	const kind = $derived(classifySession(session));
	const work = $derived(sidebarStatus(session, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements));
	const presence = $derived(
		sessionPresence(
			session,
			botsById,
			t.common.you,
			kind === 'group' ? t.top.members : kind === 'bot-bot' ? t.top.presenceOpen : '',
			rosterLabels
		)
	);
	const peerModel = $derived.by(() => {
		const peer = kind === 'you-bot' ? youBotPeer(session) : null;
		return peer ? (botsById.get(peer)?.model ?? null) : null;
	});

	const waiting = $derived(
		waitingInSession(
			snapshot.messages,
			snapshot.approvals,
			snapshot.turns,
			session.id,
			runtime.notificationCapabilities.pending_ask_v1
		)
	);
	const approvals = $derived(waiting.filter((w) => w.kind === 'approval'));
	const asks = $derived(waiting.filter((w) => w.kind === 'ask'));

	const settingsAction = $derived(actions.find((a) => a.id === 'settings'));

	function botStatusOf(botId: string) {
		return botWorkStatus(botId, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements);
	}

	function jump(id: string): void {
		runtime.setHighlightedMessage(id, session.id);
	}
</script>

{#if !isFileDropSession(session)}
	<header class="pane-chat-bar">
		<button
			type="button"
			class="bar-identity"
			class:is-active={settingsAction?.active}
			title={settingsAction?.label}
			disabled={!settingsAction}
			onclick={() => settingsAction?.run()}
		>
			<SessionAvatar {session} bots={botsById} size="top" botStatus={botStatusOf} />
			<span class="bar-titles">
				<span class="bar-title" role="heading" aria-level="2">{sessionTitle(session, botsById, rosterLabels)}</span>
				<span class="bar-meta">
					{#if work.kind !== 'idle'}
						<span class="bar-status is-{work.kind}">
							{#if work.isBusy}<span class="bar-pulse"></span>{/if}
							{work.label}
						</span>
					{/if}
					{#if peerModel}
						<span class="bar-model mono" title={peerModel}>{peerModel}</span>
					{:else if presence && kind !== 'you-bot'}
						<!-- A direct's presence is "you ↔ the Bot", which the title already says. -->
						<span class="bar-presence">{presence}</span>
					{/if}
				</span>
			</span>
		</button>

		{#if approvals.length > 0 || asks.length > 0}
			<div class="bar-waiting">
				{#if approvals.length > 0}
					<button type="button" class="bar-pill is-approval" onclick={() => jump(approvals[0].id)}>
						<Icon name="shield-check" size={13} />
						{t.stream.waitingJump.approvals(approvals.length)}
					</button>
				{/if}
				{#if asks.length > 0}
					<button type="button" class="bar-pill is-ask" onclick={() => jump(asks[0].id)}>
						<Icon name="help-circle" size={13} />
						{t.stream.waitingJump.asks(asks.length)}
					</button>
				{/if}
			</div>
		{/if}

		<div class="bar-actions">
			{#each actions as action (action.id)}
				<button
					type="button"
					class="bar-action is-{action.id}"
					class:is-active={action.active}
					aria-pressed={action.id === 'pin' ? Boolean(action.active) : undefined}
					title={action.label}
					aria-label={action.label}
					onclick={() => action.run()}
				>
					{#if action.icon}{@render action.icon()}{/if}
					{#if action.id === 'trace'}<span class="bar-action-label">{action.label}</span>{/if}
				</button>
			{/each}
		</div>
	</header>
{/if}

<style>
	.pane-chat-bar {
		container: chat-bar / inline-size;
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 6px 8px 6px 12px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--pane);
	}

	.bar-identity {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 4px 10px 4px 4px;
		border-radius: var(--radius-md);
		text-align: left;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.bar-identity:hover:not(:disabled),
	.bar-identity.is-active {
		background: var(--row-hover);
	}

	.bar-identity:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.bar-titles {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 1px;
	}

	.bar-title {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--text-caption);
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
	}

	.bar-status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 600;
	}

	/* Working is the accent, waiting on your approval the warn colour, on your answer purple. */
	.bar-status.is-running,
	.bar-status.is-replying {
		color: var(--accent);
	}

	.bar-status.is-waiting_approval {
		color: var(--warn-text);
	}

	.bar-status.is-waiting_ask {
		color: var(--purple-text);
	}

	.bar-status.is-failed,
	.bar-status.is-interrupted {
		color: var(--danger-text);
	}

	.bar-pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		animation: bar-pulse 1.8s ease-in-out infinite;
	}

	.bar-model {
		padding: 0 6px;
		border-radius: var(--radius-xs);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: var(--text-micro);
		line-height: 18px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar-presence {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar-waiting {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.bar-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 10px 0 8px;
		border-radius: var(--radius-full);
		font-size: var(--text-caption);
		font-weight: 650;
		white-space: nowrap;
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.bar-pill.is-approval {
		background: var(--warn-bg);
		color: var(--warn-text);
		box-shadow: inset 0 0 0 1px var(--warn-line);
	}

	.bar-pill.is-approval:hover {
		box-shadow: inset 0 0 0 1px var(--warn);
	}

	.bar-pill.is-ask {
		background: var(--purple-bg);
		color: var(--purple-text);
		box-shadow: inset 0 0 0 1px var(--purple-line);
	}

	.bar-pill.is-ask:hover {
		box-shadow: inset 0 0 0 1px var(--purple);
	}

	.bar-pill:active {
		transform: scale(0.97);
	}

	.bar-pill:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.bar-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
		flex: none;
	}

	.bar-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 32px;
		height: 32px;
		padding: 0 8px;
		border-radius: 8px;
		color: var(--muted);
		font-size: var(--text-small);
		font-weight: 600;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.bar-action:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.bar-action:active {
		transform: scale(0.94);
	}

	.bar-action:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.bar-action.is-active {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.bar-action :global(svg) {
		width: 16px;
		height: 16px;
		flex: none;
	}

	/* A narrow pane keeps the pills and the icons; the words go first. */
	@container chat-bar (max-width: 560px) {
		.bar-action-label,
		.bar-model,
		.bar-presence {
			display: none;
		}
	}

	@container chat-bar (max-width: 420px) {
		.bar-pill {
			padding: 0 8px;
			font-size: 0;
			gap: 0;
		}
	}

	@keyframes bar-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
