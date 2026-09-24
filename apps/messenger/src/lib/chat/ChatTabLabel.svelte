<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, isFileDropSession, youBotPeer } from '../sidebar/session-groups.ts';
	import { botWorkStatus, sidebarStatus } from '../sidebar/session-status.ts';
	import { sessionPresence } from '../sidebar/session-title.ts';

	/**
	 * A conversation's tab. In a narrow pane it is also the conversation's header: the avatar and
	 * its status dot sit before the name, and the header's second line is the tooltip. The
	 * picture is marked `wb-tab-icon`, which the tab strip shows only while the pane is narrow.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		session: SessionSummary;
		/** The tab's name, the same words the rest of the workbench uses for this conversation. */
		title: string;
	};

	let { runtime, t, session, title }: Props = $props();

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
	const fileDrop = $derived(isFileDropSession(session));
	const peerBot = $derived.by(() => {
		const peer = youBotPeer(session);
		return peer ? (botsById.get(peer) ?? null) : null;
	});
	const work = $derived(
		sidebarStatus(session, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements)
	);

	function botStatusOf(botId: string) {
		return botWorkStatus(botId, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements);
	}

	const archived = $derived(
		session.archived_at || peerBot?.archived_at ? ` · ${t.top.archived}` : ''
	);
	/** What the header's second line says, so a folded header loses nothing. */
	const detail = $derived.by(() => {
		if (fileDrop) return t.sidebar.fileDropHint;
		if (kind === 'you-bot' && peerBot) {
			const status = work.kind !== 'idle' ? work.label : t.chat.online;
			return peerBot.model ? `${status} · ${peerBot.model}` : status;
		}
		const prefix = kind === 'group' ? t.top.members : kind === 'bot-bot' ? t.top.presenceOpen : '';
		return sessionPresence(session, botsById, t.common.you, prefix, rosterLabels);
	});
</script>

<span class="chat-tab" title={`${title}${archived}\n${detail}`}>
	{#if fileDrop}
		<span class="wb-tab-icon chat-tab-avatar is-file" aria-hidden="true">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
				<polyline points="14 2 14 8 20 8"></polyline>
			</svg>
		</span>
	{:else}
		<span class="wb-tab-icon chat-tab-avatar" aria-hidden="true">
			{#if kind === 'you-bot' && peerBot}
				<!-- The Bot's own dot, the way the header draws it: what that Bot is doing anywhere. -->
				<SessionAvatar {session} bots={botsById} size="tab" botStatus={botStatusOf} />
			{:else}
				<SessionAvatar {session} bots={botsById} size="tab" />
				<!-- Only while something runs: at this size an idle dot is one more speck, and the
				     fourth face of a full group sits over it anyway. -->
				{#if work.isBusy}
					<span class="avatar-status-dot is-busy"></span>
				{/if}
			{/if}
		</span>
	{/if}
	<span class="chat-tab-name">{title}</span>
</span>

<style>
	.chat-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
	}

	/* No `display` here: the strip owns whether the picture is shown. */
	.chat-tab-avatar {
		position: relative;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
	}

	.chat-tab-avatar.is-file {
		border-radius: 50%;
		background: var(--accent-tint);
		color: var(--accent);
	}

	/* Rung in whatever the tab is painted, so the dot and the stacked faces read as cut out. */
	.chat-tab-avatar :global(.row-avatar) {
		--avatar-ring: var(--wb-tab-surface, var(--pane));
	}

	/* Over the faces, which stack up to 4. */
	.chat-tab-avatar > .avatar-status-dot {
		z-index: 5;
		width: 7px;
		height: 7px;
		border-width: 1.5px;
		border-color: var(--wb-tab-surface, var(--pane));
	}

	.chat-tab-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
