<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import { isSessionPinned } from '../sidebar/pinned-sessions.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, isFileDropSession, youBotPeer } from '../sidebar/session-groups.ts';
	import { botWorkStatus, sidebarStatus } from '../sidebar/session-status.ts';
	import { sessionPresence, sessionTitle } from '../sidebar/session-title.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		pinnedSessionIds: string[];
		onTogglePin: (sessionId: string) => void;
		onToggleSessionSettings: () => void;
		/**
		 * Whether the conversation's settings are open. Left out, the runtime's flag answers for the
		 * narrow shell's drawer; a workbench pane says its own, because its sidebar is in its tab.
		 */
		settingsOpen?: boolean;
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
		settingsOpen: paneSettingsOpen,
		onCreateBot,
		onShowOnboarding
	}: Props = $props();

	const settingsOpen = $derived(paneSettingsOpen ?? runtime.sessionSettingsOpen);

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
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
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
	const fileDrop = $derived(selected ? isFileDropSession(selected) : false);
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
	let mobileActionsOpen = $state(false);

	function closeMobileActions(): void {
		mobileActionsOpen = false;
	}

	function handleWindowClick(event: MouseEvent): void {
		if (event.target instanceof Element && event.target.closest('.mobile-actions')) return;
		closeMobileActions();
	}

	function runMobileAction(action: () => void): void {
		closeMobileActions();
		action();
	}

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

<svelte:window onclick={handleWindowClick} />

<header class="top" class:has-session={selected !== null}>
	{#if selected}
		<div class="top-session-identity flex items-center gap-6 min-w-0 flex-1">
			<button
				type="button"
				class="btn-mobile-back"
				title={t.sidebar.backToSessions}
				aria-label={t.sidebar.backToSessions}
				onclick={() => (runtime.selectedId = null)}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			{#if fileDrop}
				<div class="top-file-identity">
					<span class="top-avatar file-drop-mark" aria-hidden="true">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
							<polyline points="14 2 14 8 20 8"></polyline>
						</svg>
					</span>
					<span class="top-titles flex flex-col min-w-0 gap-1">
						<span class="top-title-text" role="heading" aria-level="1">{t.sidebar.fileDrop}</span>
						<span class="top-subline flex items-center gap-3 text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis">
							<span class="meta">{t.sidebar.fileDropHint}</span>
						</span>
					</span>
				</div>
			{:else}
			<button
				type="button"
				class="top-identity-btn"
				class:is-active={settingsOpen}
				title={sessionSettingsLabel}
				aria-expanded={settingsOpen}
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
				<span class="top-titles flex flex-col min-w-0 gap-1">
					<span class="top-title-text" role="heading" aria-level="1">{titleOf(selected)}{archivedSuffix(selected)}</span>
					<span class="top-subline flex items-center gap-3 text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis">
						{#if selectedKind === 'you-bot' && selectedPeerBot}
							<span class="status-indicator inline-flex items-center gap-2 text-muted font-medium">
								<span class="status-dot" class:is-busy={thinkingHere}></span>
								{selectedWork && selectedWork.kind !== 'idle' ? selectedWork.label : t.chat.online}
							</span>
							{#if selectedPeerBot.model}
								<span class="top-model-pill mono" title={selectedPeerBot.model}>{selectedPeerBot.model}</span>
							{/if}
						{/if}
						<span class="meta" class:is-direct-presence={selectedKind === 'you-bot'}
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
			{/if}
		</div>

		{#if !fileDrop}
		<div class="top-actions flex items-center gap-4 shrink-0">
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
				class:is-active={runtime.traceOpen}
				title={t.trace.title}
				onclick={() => (runtime.traceOpen ? runtime.closeTrace() : runtime.openTrace(null))}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="8" y="2" width="8" height="6" rx="1.5"></rect>
					<path d="M12 8v3"></path>
					<path d="M5.5 14v-3h13v3"></path>
					<rect x="2" y="14" width="7" height="6" rx="1.5"></rect>
					<rect x="15" y="14" width="7" height="6" rx="1.5"></rect>
				</svg>
				<span>{t.trace.topAction}</span>
			</button>
			<button
				type="button"
				class="btn-top-action"
				class:is-active={settingsOpen}
				title={sessionSettingsLabel}
				aria-expanded={settingsOpen}
				onclick={onToggleSessionSettings}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"></circle>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
				</svg>
				<span>{sessionSettingsLabel}</span>
			</button>
		</div>
		{/if}

		{#if !fileDrop}
		<div class="mobile-actions">
			<button
				type="button"
				class="btn-mobile-actions"
				class:is-active={mobileActionsOpen || runtime.traceOpen || settingsOpen || isSessionPinned(pinnedSessionIds, selected.id)}
				title={t.top.moreActions}
				aria-label={t.top.moreActions}
				aria-expanded={mobileActionsOpen}
				onclick={() => (mobileActionsOpen = !mobileActionsOpen)}
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<circle cx="5" cy="12" r="1.8"></circle>
					<circle cx="12" cy="12" r="1.8"></circle>
					<circle cx="19" cy="12" r="1.8"></circle>
				</svg>
			</button>
			{#if mobileActionsOpen}
				<div class="mobile-actions-menu">
					<button
						type="button"
						class:is-active={isSessionPinned(pinnedSessionIds, selected.id)}
						onclick={() => runMobileAction(() => onTogglePin(selected.id))}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill={isSessionPinned(pinnedSessionIds, selected.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="12" y1="17" x2="12" y2="22"></line>
							<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
						</svg>
						<span>{isSessionPinned(pinnedSessionIds, selected.id) ? t.top.unpin : t.top.pin}</span>
					</button>
					<button type="button" class:is-active={runtime.traceOpen} onclick={() => runMobileAction(() => (runtime.traceOpen ? runtime.closeTrace() : runtime.openTrace(null)))}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="8" y="2" width="8" height="6" rx="1.5"></rect>
							<path d="M12 8v3"></path>
							<path d="M5.5 14v-3h13v3"></path>
							<rect x="2" y="14" width="7" height="6" rx="1.5"></rect>
							<rect x="15" y="14" width="7" height="6" rx="1.5"></rect>
						</svg>
						<span>{t.trace.topAction}</span>
					</button>
					<button type="button" class:is-active={settingsOpen} onclick={() => runMobileAction(onToggleSessionSettings)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09A1.65 1.65 0 0 0 19.4 15z"></path>
						</svg>
						<span>{sessionSettingsLabel}</span>
					</button>
				</div>
			{/if}
		</div>
		{/if}
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

<style>
	.file-drop-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-tint);
		color: var(--accent);
		border-color: transparent;
	}

	.setup-guide-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 12px;
		border-radius: 9999px;
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		font-size: 11.5px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.setup-guide-pill:hover {
		background: var(--warn-bg);
		border-color: var(--warn);
	}

	.top-identity-btn,
	.top-file-identity {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
		padding: 4px 8px;
		margin: -4px -8px;
		text-align: left;
	}

	.top-identity-btn {
		background: transparent;
		border: none;
		box-shadow: none;
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: background 0.15s ease, opacity 0.15s ease;
		color: inherit;
		font: inherit;
	}

	.top-identity-btn:hover {
		background: var(--line-subtle);
	}

	.top-identity-btn:hover .top-avatar {
		border-color: var(--line-hover);
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
	}

	.top-identity-btn:hover .top-title-text {
		color: var(--accent);
	}

	.top-identity-btn.is-active {
		background: var(--line-subtle);
	}

	.top-identity-btn.is-active .top-title-text {
		color: var(--accent);
	}

	.top-identity-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.top-avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 14px;
		border: 1.5px solid var(--line);
		position: relative;
		flex-shrink: 0;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
	}

	.top-avatar.is-group {
		background: var(--chip);
		border-color: var(--line);
		font-size: 16px;
	}

	.top-avatar.is-composite {
		background: transparent;
		border: none;
		box-shadow: none;
	}

	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ok);
	}

	.status-dot.is-busy {
		background: var(--accent);
		animation: pulse 1s infinite;
	}

	.top-model-pill {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
	}

	:global(.top) .meta {
		color: var(--muted);
		font-size: 11.5px;
		font-weight: 500;
		white-space: nowrap;
	}

	.btn-top-action {
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		border-radius: var(--radius-sm);
		padding: 5px 10px;
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		box-shadow: var(--shadow-xs);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
		transition: all 0.15s ease;
	}

	.btn-top-action:hover {
		border-color: var(--line-hover);
		color: var(--accent);
		background: var(--line-subtle);
	}

	.btn-top-action.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.btn-mobile-back {
		display: none;
		background: transparent;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 4px 6px;
		color: var(--ink-secondary);
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.btn-mobile-back:hover {
		background: var(--line-subtle);
		color: var(--accent);
		border-color: var(--line-hover);
	}

	.mobile-actions {
		display: none;
		position: relative;
		flex: 0 0 auto;
	}

	.btn-mobile-actions {
		width: 40px;
		height: 40px;
		padding: 0;
		display: grid;
		place-items: center;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		box-shadow: var(--shadow-xs);
	}

	.btn-mobile-actions:hover,
	.btn-mobile-actions.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.mobile-actions-menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		width: max-content;
		min-width: 180px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		z-index: 20;
	}

	.mobile-actions-menu button {
		min-height: 40px;
		padding: 0 10px;
		display: flex;
		align-items: center;
		gap: 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 13px;
		font-weight: 600;
		text-align: left;
	}

	.mobile-actions-menu button:hover,
	.mobile-actions-menu button.is-active {
		background: var(--accent-tint);
		color: var(--accent);
	}


	.empty-roster {
		border: 0;
		background: transparent;
		padding: 0;
		color: var(--muted);
		font-size: 13px;
		text-align: left;
		margin-left: auto;
		text-decoration: underline;
		text-underline-offset: 3px;
		transition: color 0.15s ease;
	}

	.empty-roster:hover {
		color: var(--accent);
	}

	.top-avatar :global(.row-avatar),
	.top-identity-btn :global(.row-avatar) {
		--avatar-ring: var(--pane);
	}

	/* Main Header */
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 20px;
		min-height: 58px;
		background: var(--glass-header);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--line);
		box-shadow: 0 1px 3px rgba(15, 23, 42, 0.03);
		z-index: 2;
	}

	.top h1,
	.top-title-text {
		margin: 0;
		font-size: 15px;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.3;
		transition: color 0.15s ease;
	}

	/*
	 * The phone header, whenever the conversation is that narrow: a workbench pane in a wide window
	 * gets it too. The actions fold into the ⋯ menu, and without Back the name keeps a margin.
	 */
	@container conversation (max-width: 680px) {
		.top.has-session {
			padding: 0 0 0 10px;
			gap: 0;
			min-height: 64px;
			align-items: stretch;
			box-shadow: none;
		}

		.top-session-identity {
			gap: 0;
			align-items: stretch;
		}

		.top-identity-btn,
		.top-file-identity {
			flex: 1;
			gap: 10px;
			padding: 8px 6px;
			margin: 0;
			border-radius: 0;
		}

		.top-titles {
			flex: 1;
			gap: 3px;
		}

		.top-title-text {
			font-size: 16px;
			line-height: 21px;
			font-weight: 600;
		}

		.top-actions {
			display: none;
		}

		.mobile-actions {
			display: flex;
		}

		.btn-mobile-back,
		.btn-mobile-actions {
			width: 48px;
			min-height: 64px;
			height: 100%;
			flex: 0 0 48px;
			padding: 0;
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
			color: var(--ink-secondary);
		}

		.btn-mobile-back svg,
		.btn-mobile-actions svg {
			width: 22px;
			height: 22px;
		}

		.btn-mobile-back:hover,
		.btn-mobile-back:active,
		.btn-mobile-actions:hover,
		.btn-mobile-actions.is-active {
			background: var(--line-subtle);
			color: var(--accent);
		}

		.btn-mobile-back:focus-visible,
		.btn-mobile-actions:focus-visible,
		.top-identity-btn:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: -3px;
		}

		.mobile-actions-menu {
			top: 100%;
			right: 8px;
		}

		.top-avatar,
		.top-avatar :global(.row-avatar) {
			width: 36px;
			height: 36px;
		}

		.top-subline {
			gap: 8px;
			min-width: 0;
			font-size: 12px;
			line-height: 17px;
		}

		.status-indicator {
			flex-shrink: 0;
			font-weight: 400;
		}

		.status-indicator .status-dot,
		.meta.is-direct-presence {
			display: none;
		}

		.top .top-model-pill {
			min-width: 0;
			padding: 0;
			border: 0;
			border-radius: 0;
			background: transparent;
			font-family: var(--font);
			font-size: 12px;
			font-weight: 400;
			color: var(--muted);
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.top .meta {
			overflow: hidden;
			text-overflow: ellipsis;
			font-size: 12px;
		}
	}

	/* Back is the phone's way out to the roster; a pane has its tab strip for that. */
	@media (max-width: 680px) {
		.btn-mobile-back {
			display: inline-flex;
		}

		.top.has-session {
			padding-left: 0;
		}
	}

	.top .mono {
		font-size: 11.5px;
		color: var(--ink-secondary);
		font-weight: 500;
	}
</style>
