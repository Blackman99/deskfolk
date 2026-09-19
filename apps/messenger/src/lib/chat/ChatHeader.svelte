<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc } from '../avatar.ts';
	import { botAvatarColor } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import { isSessionPinned } from '../sidebar/pinned-sessions.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { botWorkStatus, sidebarStatus } from '../sidebar/session-status.ts';
	import { sessionPresence, sessionTitle } from '../sidebar/session-title.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		pinnedSessionIds: string[];
		onTogglePin: (sessionId: string) => void;
		onToggleSessionSettings: () => void;
		onCreateBot: () => void;
		onShowOnboarding: () => void;
	};

	let {
		runtime,
		t,
		selected,
		pinnedSessionIds,
		onTogglePin,
		onToggleSessionSettings,
		onCreateBot,
		onShowOnboarding
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		idle: t.sidebar.statusIdle
	});
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
	const selectedWork = $derived(
		selected
			? sidebarStatus(
					selected,
					snapshot.turns,
					snapshot.approvals,
					statusLabels,
					snapshot.pendingJudgements
				)
			: null
	);
	const thinkingHere = $derived(Boolean(selectedWork?.isBusy));

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}

	function botStatusOf(botId: string) {
		return botWorkStatus(
			botId,
			snapshot.turns,
			snapshot.approvals,
			statusLabels,
			snapshot.pendingJudgements
		);
	}

	function archivedSuffix(session: SessionSummary): string {
		if (session.archived_at) return ` · ${t.top.archived}`;
		const peer = youBotPeer(session);
		if (!peer) return '';
		return botsById.get(peer)?.archived_at ? ` · ${t.top.archived}` : '';
	}
</script>

<header class="top">
	{#if selected}
		<div class="top-session-identity">
			<button
				type="button"
				class="btn-mobile-back"
				title={t.common.close}
				onclick={() => (runtime.selectedId = null)}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<button
				type="button"
				class="top-identity-btn"
				class:is-active={runtime.sessionSettingsOpen}
				title={sessionSettingsLabel}
				aria-expanded={runtime.sessionSettingsOpen}
				onclick={onToggleSessionSettings}
			>
				{#if selectedKind === 'you-bot' && selectedPeerBot}
					{@const pal = botAvatarColor(selectedPeerBot.id)}
					{@const peerStatus = botStatusOf(selectedPeerBot.id)}
					<span
						class="top-avatar"
						style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
					>
						{#if avatarSrc(selectedPeerBot.avatar)}
							<img src={avatarSrc(selectedPeerBot.avatar)} alt={selectedPeerBot.name} class="avatar-img" />
						{:else}
							{rosterLetter(selectedPeerBot.name)}
						{/if}
						{#if !selectedPeerBot.archived_at}
							<span
								class="avatar-status-dot is-{peerStatus.kind}"
								class:is-busy={peerStatus.isBusy}
								title="{selectedPeerBot.name}: {peerStatus.label}"
							></span>
						{/if}
					</span>
				{:else}
					<span class="top-avatar is-composite">
						<SessionAvatar session={selected} bots={botsById} size="top" botStatus={botStatusOf} />
						<span class="avatar-status-dot" class:is-busy={thinkingHere}></span>
					</span>
				{/if}
				<span class="top-titles">
					<span class="top-title-text" role="heading" aria-level="1">{titleOf(selected)}{archivedSuffix(selected)}</span>
					<span class="top-subline">
						{#if selectedKind === 'you-bot' && selectedPeerBot}
							<span class="status-indicator">
								<span class="status-dot" class:is-busy={thinkingHere}></span>
								{selectedWork && selectedWork.kind !== 'idle' ? selectedWork.label : t.chat.online}
							</span>
							{#if selectedPeerBot.model}
								<span class="top-model-pill mono">{selectedPeerBot.model}</span>
							{/if}
						{/if}
						<span class="meta"
							>{sessionPresence(
								selected,
								botsById,
								t.common.you,
								selectedKind === 'group'
									? t.top.members
									: selectedKind === 'bot-bot'
										? t.top.presenceOpen
										: '',
								rosterLabels
							)}</span
						>
					</span>
				</span>
			</button>
		</div>

		<div class="top-actions">
			<button
				type="button"
				class="btn-top-action"
				class:is-active={isSessionPinned(pinnedSessionIds, selected.id)}
				title={isSessionPinned(pinnedSessionIds, selected.id) ? t.top.unpin : t.top.pin}
				onclick={() => onTogglePin(selected.id)}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill={isSessionPinned(pinnedSessionIds, selected.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="17" x2="12" y2="22"></line>
					<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
				</svg>
				<span>{isSessionPinned(pinnedSessionIds, selected.id) ? t.top.pinned : t.top.pin}</span>
			</button>
			<button
				type="button"
				class="btn-top-action"
				class:is-active={runtime.routeLogOpen}
				title={t.routes.title}
				onclick={() => runtime.toggleRouteLog()}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="8" y1="6" x2="21" y2="6"></line>
					<line x1="8" y1="12" x2="21" y2="12"></line>
					<line x1="8" y1="18" x2="21" y2="18"></line>
					<line x1="3" y1="6" x2="3.01" y2="6"></line>
					<line x1="3" y1="12" x2="3.01" y2="12"></line>
					<line x1="3" y1="18" x2="3.01" y2="18"></line>
				</svg>
				<span>{t.routes.topAction}</span>
			</button>
			<button
				type="button"
				class="btn-top-action"
				class:is-active={runtime.sessionSettingsOpen}
				onclick={onToggleSessionSettings}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"></circle>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
				</svg>
				<span>{sessionSettingsLabel}</span>
			</button>
		</div>
	{:else}
		<h1>{t.top.pickSession}</h1>
		{#if !snapshot.settings.wizard_complete}
			<button
				type="button"
				class="setup-guide-pill"
				onclick={() => onShowOnboarding()}
			>
				{t.onboarding.reopenGuide}
			</button>
		{/if}
		{#if visibleBots.length === 0}
			<button type="button" class="empty-roster" onclick={onCreateBot}
				>{t.top.emptyRoster}</button
			>
		{/if}
	{/if}
</header>
