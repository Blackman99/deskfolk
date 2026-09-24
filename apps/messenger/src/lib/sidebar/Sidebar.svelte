<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { groupSessions, isFileDropSession, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { BOT_DM_VISIBLE, recentBotDms, resolveBotDmOrigin } from './bot-dm-source.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { sessionTitle } from './session-title.ts';
	import { latestPreview } from '../chat/transcript.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import { formatListTime, listTimeSource } from './list-time.ts';
	import { plainPreview } from './preview-text.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import ToolsMenu from './ToolsMenu.svelte';
	import { searchShortcutLabel } from '../search/shortcuts.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		pinnedSessionIds: string[];
		searchOpen?: boolean;
		onOpenSearch: () => void;
		/** What the phone's + button opens. A menu, so Back and Escape close it first. */
		createMenuOpen?: boolean;
		/** Back and Escape close the tools menu before navigating. */
		toolsMenuOpen?: boolean;
		workspaceOpen: boolean;
		/** Marks the row the context menu belongs to. */
		contextMenuSessionId: string | null;
		onOpenContextMenu: (e: MouseEvent, session: SessionSummary) => void;
		onToggleWorkspace: () => void;
		onOpenRoutines: () => void;
		onOpenSpend: () => void;
		onNewTerminal: () => void;
		onOpenSettings: () => void;
		onCreateBot: () => void;
		onCreateGroup: () => void;
		/** Puts the list away. Only where it can be: the desktop workbench, which has a way back. */
		onCollapse?: () => void;
	};

	let {
		runtime,
		t,
		selected,
		pinnedSessionIds,
		searchOpen = false,
		onOpenSearch,
		createMenuOpen = $bindable(false),
		toolsMenuOpen = $bindable(false),
		workspaceOpen,
		contextMenuSessionId,
		onOpenContextMenu,
		onToggleWorkspace,
		onOpenRoutines,
		onOpenSpend,
		onNewTerminal,
		onOpenSettings,
		onCreateBot,
		onCreateGroup,
		onCollapse
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	const aliveBotIds = $derived(new Set(snapshot.bots.map((b) => b.id)));
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

	const grouped = $derived(groupSessions(snapshot.sessions, pinnedSessionIds, aliveBotIds, botsById));
	const fileDrop = $derived(grouped.fileDrop);
	let botBotExpanded = $state(false);
	const botBotVisible = $derived(
		recentBotDms(grouped.botBot, {
			keepId: runtime.selectedId,
			expanded: botBotExpanded
		})
	);
	const archivedSessions = $derived(
		snapshot.sessions.filter((session) => isSessionArchived(session, botsById))
	);
	const pinnedSessions = $derived(
		pinnedSessionIds
			.map((id) => sessionsById.get(id))
			.filter((session): session is SessionSummary => Boolean(session))
	);

	let pinnedExpanded = $state(false);
	let viewingArchived = $state(false);

	let phone = $state(false);
	$effect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const query = window.matchMedia('(max-width: 680px)');
		const apply = () => {
			if (phone !== query.matches) toolsMenuOpen = false;
			phone = query.matches;
		};
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	let fabEl = $state<HTMLElement | null>(null);

	let toolsToggleBtnEl = $state<HTMLButtonElement | null>(null);
	let toolsFocusLast = $state(false);


	function onToolsToggleKeyDown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		toolsFocusLast = e.key === 'ArrowUp';
		toolsMenuOpen = true;
	}

	/** Popups that close on a click elsewhere. Escape order is the shell's; this is not. */
	function onWindowClick(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (createMenuOpen && isOutside(target, fabEl)) {
			createMenuOpen = false;
		}
	}

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}

	function statusOf(session: SessionSummary) {
		return sidebarStatus(
			session,
			snapshot.turns,
			snapshot.approvals,
			statusLabels,
			snapshot.pendingJudgements,
			snapshot.messages
		);
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

	/**
	 * The time beside each name, the way a messenger shows it. It only has to be right to the
	 * minute, so it is recomputed on a slow tick rather than on every snapshot.
	 */
	let listNow = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (listNow = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	function timeOf(session: SessionSummary): string {
		return formatListTime(listTimeSource(session), listNow, snapshot.settings.locale === 'en' ? 'en' : 'zh');
	}

	function unreadOf(session: SessionSummary): number {
		return sessionUnreadCount(session, runtime.selectedId);
	}

	function previewOf(session: SessionSummary): string {
		return plainPreview(latestPreview(snapshot.messages, session.id, session, snapshot.turns, 400));
	}

	function archivedSuffix(session: SessionSummary): string {
		if (isFileDropSession(session)) return '';
		if (session.archived_at) return ` · ${t.top.archived}`;
		const peer = youBotPeer(session);
		if (!peer) return '';
		return botsById.get(peer)?.archived_at ? ` · ${t.top.archived}` : '';
	}

	/** The archived list, asked for from the rail's menu: the list opens already on it. */
	export function showArchived(): void {
		viewingArchived = true;
	}

</script>

<svelte:window onclick={onWindowClick} />

{#snippet searchGlyph()}
	<span class="search-icon-badge absolute left-5 text-muted-light pointer-events-none flex items-center justify-center" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="11" cy="11" r="8"></circle>
			<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
		</svg>
	</span>
{/snippet}

<aside class="side">
	<div class="roster-panel">
		<div class="roster" class:is-expanded={pinnedExpanded} title={t.sidebar.pinned}>
			{#if pinnedSessions.length === 0}
				<span class="roster-empty-hint text-12 text-muted py-2 px-0 select-none self-center">{t.sidebar.pinnedEmpty}</span>
			{:else}
				{#each pinnedSessions as pSession (pSession.id)}
					{@const pStatus = statusOf(pSession)}
					{@const pUnread = unreadOf(pSession)}
					<button
						type="button"
						title="{titleOf(pSession)}{archivedSuffix(pSession)}"
						class="pinned-session-btn"
						class:is-active={runtime.selectedId === pSession.id}
						class:is-context-open={contextMenuSessionId === pSession.id}
						class:is-run={pStatus.isBusy}
						class:is-unread={pUnread > 0}
						onclick={() => void runtime.selectSession(pSession.id)}
						oncontextmenu={(e) => onOpenContextMenu(e, pSession)}
					>
						<span class="pinned-avatar-wrap relative flex items-center justify-center w-17 h-17 shrink-0">
							{#if isFileDropSession(pSession)}
								<span class="row-avatar size-md" aria-hidden="true">
									<span class="row-avatar-bot file-drop-mark">
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
											<polyline points="14 2 14 8 20 8"></polyline>
											<line x1="12" y1="18" x2="12" y2="12"></line>
											<polyline points="9 15 12 18 15 15"></polyline>
										</svg>
									</span>
								</span>
							{:else}
								<SessionAvatar session={pSession} bots={botsById} botStatus={botStatusOf} />
							{/if}
							{#if pStatus.count}
								<span class="pinned-badge">{pStatus.count}</span>
							{:else if pUnread > 0}
								<span class="pinned-unread" title={t.sidebar.unread}>{unreadBadge(pUnread)}</span>
							{/if}
						</span>
						<span class="pinned-session-name text-11 font-medium text-ink leading-[1.2] w-full max-w-27 overflow-hidden text-ellipsis whitespace-nowrap text-center block select-none">{titleOf(pSession)}</span>
					</button>
				{/each}
			{/if}
		</div>
		{#if pinnedSessions.length > 5}
			<button
				type="button"
				class="pinned-expand-btn"
				title={pinnedExpanded ? t.sidebar.collapse : t.sidebar.expand}
				onclick={() => (pinnedExpanded = !pinnedExpanded)}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					class:is-rotated={pinnedExpanded}
				>
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
		{/if}
	</div>
	<div class="side-body relative flex-1 min-h-0 flex flex-col">
	{#if phone && viewingArchived}
		<div class="mobile-archived-head">
			<button
				type="button"
				class="mobile-archived-back"
				title={t.sidebar.backToSessions}
				aria-label={t.sidebar.backToSessions}
				onclick={() => (viewingArchived = false)}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="15 18 9 12 15 6"></polyline>
				</svg>
			</button>
			<h2 class="mobile-archived-title">
				<span>{t.sidebar.archivedSessions}</span>
				{#if archivedSessions.length > 0}
					<span class="mobile-archived-count">({archivedSessions.length})</span>
				{/if}
			</h2>
			<div class="mobile-archived-spacer" aria-hidden="true"></div>
		</div>
	{:else}
		<div class="search-wrap">
			{#if phone}<div class="tools-entry-wrap">{@render toolsToggle()}</div>{/if}
			<div class="search-trigger-wrap">
				{@render searchGlyph()}
				<button type="button" class="search search-trigger" aria-label={t.sidebar.globalSearch} aria-haspopup="dialog" onclick={onOpenSearch}>
					<span>{t.sidebar.searchShort}</span><kbd>{searchShortcutLabel()}</kbd>
				</button>
			</div>
				{#if !phone && onCollapse}
					<button
						type="button"
						class="side-collapse"
						title="{t.sidebar.hide} (⌘B)"
						aria-label={t.sidebar.hide}
						aria-expanded="true"
						onclick={onCollapse}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="3" y="3" width="18" height="18" rx="2"></rect>
							<path d="M9 3v18"></path>
							<path d="m16 15-3-3 3-3"></path>
						</svg>
					</button>
				{/if}
		</div>
	{/if}
	<div class="groups">
		{#if viewingArchived}
			<div class="ghead archived-ghead flex items-center justify-between">
				<span>{t.sidebar.archivedSessions}</span>
				<button type="button" class="btn-back-sessions" onclick={() => (viewingArchived = false)}>
					{t.sidebar.backToSessions}
				</button>
			</div>
			{#if archivedSessions.length === 0}
				<p class="muted archived-empty-hint py-9 px-5 text-center text-12 text-muted">{t.sidebar.archivedEmpty}</p>
			{:else}
				{#each archivedSessions as session (session.id)}
					{@const status = statusOf(session)}
					{@const unread = unreadOf(session)}
					<button
						type="button"
						class="row is-archived-row opacity-85"
						class:is-on={runtime.selectedId === session.id}
						class:is-context-open={contextMenuSessionId === session.id}
						class:is-unread={unread > 0}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => onOpenContextMenu(e, session)}
					>
						<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
						<span class="t">{titleOf(session)}{archivedSuffix(session)}</span>
						<span class="row-time">{timeOf(session)}</span>
						<span class="row-status is-{status.kind}">
							<span class="row-status-dot" class:is-busy={status.isBusy}></span>
							<span class="row-status-text">{status.label}</span>
							{#if status.count}
								<span class="badge">{status.count}</span>
							{/if}
						</span>
						<span class="s">{previewOf(session) || t.sidebar.noMessages}</span>
						{#if unread > 0}
							<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(unread)}</span>
						{/if}
					</button>
				{/each}
			{/if}
		{:else}
			{#if fileDrop}
				<div class="ghead">
					<span>{t.sidebar.fileDrop}</span>
				</div>
				{@const dropStatus = statusOf(fileDrop)}
				{@const dropUnread = unreadOf(fileDrop)}
				<button
					type="button"
					class="row"
					class:is-on={runtime.selectedId === fileDrop.id}
					class:is-context-open={contextMenuSessionId === fileDrop.id}
					class:is-unread={dropUnread > 0}
					onclick={() => void runtime.selectSession(fileDrop.id)}
					oncontextmenu={(e) => onOpenContextMenu(e, fileDrop)}
				>
					<span class="row-avatar size-md" aria-hidden="true">
						<span class="row-avatar-bot file-drop-mark">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
								<polyline points="14 2 14 8 20 8"></polyline>
								<line x1="12" y1="18" x2="12" y2="12"></line>
								<polyline points="9 15 12 18 15 15"></polyline>
							</svg>
						</span>
					</span>
					<span class="t">{t.sidebar.fileDrop}</span>
					<span class="row-time">{timeOf(fileDrop)}</span>
					<span class="row-status is-{dropStatus.kind}">
						<span class="row-status-dot" class:is-busy={dropStatus.isBusy}></span>
						<span class="row-status-text">{dropStatus.label}</span>
					</span>
					<span class="s">{previewOf(fileDrop) || t.sidebar.fileDropHint}</span>
					{#if dropUnread > 0}
						<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(dropUnread)}</span>
					{/if}
				</button>
			{/if}
			<div class="ghead">
				<span>{t.sidebar.groups}</span>
				<button type="button" class="add" title={t.sidebar.addGroup} onclick={onCreateGroup}
					>+</button
				>
			</div>
			{#each grouped.groups as session (session.id)}
				{@const status = statusOf(session)}
				{@const unread = unreadOf(session)}
				<button
					type="button"
					class="row"
					class:is-on={runtime.selectedId === session.id}
					class:is-context-open={contextMenuSessionId === session.id}
					class:is-unread={unread > 0}
					onclick={() => void runtime.selectSession(session.id)}
					oncontextmenu={(e) => onOpenContextMenu(e, session)}
				>
					<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
					<span class="t">{titleOf(session)}</span>
					<span class="row-time">{timeOf(session)}</span>
					<span class="row-status is-{status.kind}">
						<span class="row-status-dot" class:is-busy={status.isBusy}></span>
						<span class="row-status-text">{status.label}</span>
						{#if status.count}
							<span class="badge">{status.count}</span>
						{/if}
					</span>
					<span class="s">{previewOf(session) || t.sidebar.noMessages}</span>
					{#if unread > 0}
						<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(unread)}</span>
					{/if}
				</button>
			{/each}
			<div class="ghead">
				<span>{t.sidebar.youBot}</span>
				<button type="button" class="add" title={t.sidebar.addBot} onclick={onCreateBot}>+</button>
			</div>
			{#each grouped.youBot as session (session.id)}
				{@const status = statusOf(session)}
				{@const unread = unreadOf(session)}
				<button
					type="button"
					class="row"
					class:is-on={runtime.selectedId === session.id}
					class:is-context-open={contextMenuSessionId === session.id}
					class:is-unread={unread > 0}
					onclick={() => void runtime.selectSession(session.id)}
					oncontextmenu={(e) => onOpenContextMenu(e, session)}
				>
					<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
					<span class="t">{titleOf(session)}{archivedSuffix(session)}</span>
					<span class="row-time">{timeOf(session)}</span>
					<span class="row-status is-{status.kind}">
						<span class="row-status-dot" class:is-busy={status.isBusy}></span>
						<span class="row-status-text">{status.label}</span>
						{#if status.count}
							<span class="badge">{status.count}</span>
						{/if}
					</span>
					<span class="s">{previewOf(session) || t.sidebar.noMessages}</span>
					{#if unread > 0}
						<span class="unread-dot" title={t.sidebar.unread}>{unreadBadge(unread)}</span>
					{/if}
				</button>
			{/each}
			<div class="ghead">
				<span>{t.sidebar.botBot}</span>
				{#if grouped.botBot.length > BOT_DM_VISIBLE}
					<button
						type="button"
						class="ghead-more"
						onclick={() => (botBotExpanded = !botBotExpanded)}
					>
						{botBotExpanded
							? t.sidebar.collapse
							: t.sidebar.botBotMore(grouped.botBot.length - BOT_DM_VISIBLE)}
					</button>
				{/if}
			</div>
			{#each botBotVisible as session (session.id)}
				{@const status = statusOf(session)}
				{@const source = resolveBotDmOrigin(session, sessionsById)}
				<div class="row-stack" class:is-on={runtime.selectedId === session.id}>
					<button
						type="button"
						class="row"
						class:is-on={runtime.selectedId === session.id}
						class:is-context-open={contextMenuSessionId === session.id}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => onOpenContextMenu(e, session)}
					>
						<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
						<span class="t">{titleOf(session)}</span>
						<span class="row-time">{timeOf(session)}</span>
						<span class="row-status is-{status.kind}">
							<span class="row-status-dot" class:is-busy={status.isBusy}></span>
							<span class="row-status-text">{status.label}</span>
							{#if status.count}
								<span class="badge">{status.count}</span>
							{/if}
						</span>
						<span class="s">{previewOf(session) || t.sidebar.noMessages}</span>
					</button>
					{#if source.kind === 'session'}
						{@const sourceTitle = titleOf(source.session)}
						<button
							type="button"
							class="row-source"
							title={source.root
								? t.sidebar.botBotSourceRoot(sourceTitle, titleOf(source.root))
								: t.sidebar.botBotSource(sourceTitle)}
							onclick={() =>
								void runtime.selectSession(
									source.session.id,
									source.messageId ? { messageId: source.messageId } : undefined
								)}
						>
							<span class="row-source-glyph" aria-hidden="true">{source.depth > 0 ? '↳' : '↰'}</span>
							<span class="row-source-text">{t.sidebar.botBotSource(sourceTitle)}</span>
						</button>
					{:else}
						<span class="row-source is-static">
							{source.kind === 'missing'
								? t.sidebar.botBotSourceMissing
								: t.sidebar.botBotSourceUnknown}
						</span>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
	</div>
	{#if !phone}
		<div class="foot">
			<button
				type="button"
				class="foot-action"
				class:is-active={workspaceOpen}
				title={snapshot.settings.workspace_path ? `${t.sidebar.workspace} (⌘O)` : t.sidebar.workspaceUnset}
				aria-label={t.sidebar.workspace}
				aria-expanded={workspaceOpen}
				disabled={!snapshot.settings.workspace_path}
				onclick={() => onToggleWorkspace()}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
				</svg>
				<span>{t.sidebar.workspace}</span>
			</button>
			{@render toolsToggle()}
			<button
				type="button"
				class="foot-action foot-settings"
				class:is-active={runtime.settingsOpen}
				title={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
				aria-label={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
				onclick={onOpenSettings}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="3"></circle>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
				</svg>
				<span>{t.sidebar.settings}</span>
				{#if updateChecker.updateVisible}
					<span class="foot-badge is-dot" aria-hidden="true"></span>
				{/if}
			</button>
		</div>
	{/if}
	<ToolsMenu
		{t}
		locale={snapshot.settings.locale === 'en' ? 'en' : 'zh'}
		{phone}
		anchor={toolsToggleBtnEl}
		bind:open={toolsMenuOpen}
		bind:focusLast={toolsFocusLast}
		archivedCount={archivedSessions.length}
		current={{
			routines: phone && runtime.routinesOpen,
			spend: phone && runtime.spendOpen,
			terminal: phone && runtime.terminalOpen,
			archived: viewingArchived
		}}
		{onOpenRoutines}
		{onOpenSpend}
		onOpenTerminal={() => (phone ? runtime.openTerminal() : onNewTerminal())}
		onOpenArchived={() => (viewingArchived = true)}
	/>
</aside>

{#snippet toolsToggle()}
	<button
		bind:this={toolsToggleBtnEl}
		type="button"
		class="tools-entry"
		class:foot-action={!phone}
		class:is-active={toolsMenuOpen}
		title={t.sidebar.tools}
		aria-label={t.sidebar.tools}
		aria-haspopup="menu"
		aria-expanded={toolsMenuOpen}
		aria-controls={toolsMenuOpen ? 'sidebar-tools-menu' : undefined}
		onkeydown={onToolsToggleKeyDown}
		onclick={() => (toolsMenuOpen = !toolsMenuOpen)}
	>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
			<rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
			<rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
			<rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
		</svg>
		{#if !phone}
			<span>{t.sidebar.tools}</span>
			<svg class="tools-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg>
		{/if}
	</button>
{/snippet}

<!--
	Creating on a phone: one button that floats over the list rather than a + in each group header.
	The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	there are two of them saying the same kind of thing; this asks which once, where your thumb is.
-->
{#if phone && !selected && !searchOpen && !viewingArchived && !workspaceOpen && !runtime.settingsOpen && !runtime.routinesOpen && !runtime.spendOpen && !runtime.terminalOpen}
	<div class="fab-wrap" bind:this={fabEl}>
		{#if createMenuOpen}
			<div class="fab-menu" role="menu">
				<button
					type="button"
					class="fab-menu-item"
					role="menuitem"
					onclick={() => {
						createMenuOpen = false;
						onCreateBot();
					}}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="4" y="8" width="16" height="12" rx="3"></rect>
						<path d="M12 8V4"></path>
						<circle cx="9" cy="14" r="1"></circle>
						<circle cx="15" cy="14" r="1"></circle>
					</svg>
					<span>{t.sidebar.addBot}</span>
				</button>
				<button
					type="button"
					class="fab-menu-item"
					role="menuitem"
					onclick={() => {
						createMenuOpen = false;
						onCreateGroup();
					}}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
						<circle cx="9" cy="7" r="4"></circle>
						<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
					</svg>
					<span>{t.sidebar.addGroup}</span>
				</button>
			</div>
		{/if}
		<button
			type="button"
			class="fab"
			class:is-open={createMenuOpen}
			aria-haspopup="menu"
			aria-expanded={createMenuOpen}
			aria-label={t.sidebar.createMenu}
			onclick={() => (createMenuOpen = !createMenuOpen)}
		>
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
				<path d="M12 5v14M5 12h14"></path>
			</svg>
		</button>
	</div>
{/if}

<style>
	.mobile-archived-head { display: none; }
	@media (max-width: 680px) {
		.side > .foot { display: none; }
		.groups .archived-ghead { display: none; }
	}

	.pinned-session-btn.is-context-open {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.search-wrap {
		position: relative;
		margin: 10px 12px 6px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.tools-entry-wrap {
		display: none;
	}

	.side-collapse {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.side-collapse:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.search-trigger-wrap { position: relative; flex: 1; min-width: 0; }
	.search-trigger { display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left; cursor: pointer; }
	.search-trigger span { color: var(--muted); }
	.search-trigger kbd { flex-shrink: 0; padding: 1px 4px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); font: 10px var(--font); }
	.search-trigger:hover { border-color: var(--line-hover); background: var(--row-hover); }
	@media (max-width: 680px) { .search-trigger kbd { display: none; } }

	/*
	 * Above the list, under everything that covers the list: a drawer, a sheet or the settings
	 * page all sit higher, so the button cannot poke through them.
	 */
	.fab-wrap {
		position: fixed;
		right: 16px;
		bottom: calc(60px + env(safe-area-inset-bottom) + 16px);
		z-index: 12;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
	}

	.fab {
		width: 52px;
		height: 52px;
		border: 0;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-ink, #fff);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--shadow-lg);
		cursor: pointer;
		transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/* The + turns into the × that closes what it opened. */
	.fab.is-open {
		transform: rotate(45deg);
	}

	.fab:active {
		transform: scale(0.94);
		background: var(--accent-hover);
	}

	.fab.is-open:active {
		transform: rotate(45deg) scale(0.94);
		background: var(--accent-hover);
	}

	/* The focus ring is the app's, and on a circle it has to follow the circle. */
	.fab:focus-visible {
		box-shadow: var(--shadow-lg), 0 0 0 3px var(--accent-glow);
	}

	.fab-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px;
		min-width: 152px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		animation: sidebarMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
		transform-origin: bottom right;
	}

	.fab-menu-item {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 42px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 14px;
		text-align: left;
		cursor: pointer;
	}

	.fab-menu-item:active {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.fab-menu-item svg {
		flex-shrink: 0;
		color: var(--muted);
	}

	.pinned-session-btn :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
		display: block;
	}

	.file-drop-mark {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: transparent;
	}

	/* Roster row, search, session groups and footer. */
	/* Sidebar */
	.side {
		background: var(--sidebar-bg);
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		position: relative;
		user-select: none;
	}

	/* Pinned Bar / Roster Row (Top of Sidebar) */
	.roster-panel {
		position: relative;
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--line);
		background: var(--glass-sidebar-header);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}

	.roster {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 8px 10px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: thin;
		scrollbar-color: var(--line-hover) transparent;
		min-height: 72px;
		flex: 1;
		min-width: 0;
		transition: all 0.2s ease;
	}

	.roster::-webkit-scrollbar {
		height: 4px;
	}

	.roster::-webkit-scrollbar-thumb {
		background: var(--line-hover);
		border-radius: 4px;
	}

	.roster.is-expanded {
		flex-wrap: wrap;
		overflow-x: hidden;
		overflow-y: auto;
		max-height: 200px;
		gap: 8px 6px;
	}

	.pinned-expand-btn {
		width: 28px;
		height: 28px;
		margin-right: 10px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--muted);
		box-shadow: var(--shadow-xs);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.pinned-expand-btn:hover {
		color: var(--ink);
		border-color: var(--line-hover);
		background: var(--line-subtle);
	}

	.pinned-expand-btn :global(svg.is-rotated) {
		transform: rotate(180deg);
	}

	.pinned-session-btn {
		width: 58px;
		height: 60px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 3px;
		position: relative;
		flex: 0 0 58px;
		box-shadow: var(--shadow-xs);
		transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
		padding: 4px 2px 2px;
		cursor: pointer;
		box-sizing: border-box;
	}

	.pinned-session-btn:hover {
		transform: translateY(-1px);
		border-color: var(--line-hover);
		box-shadow: var(--shadow-sm);
		background: var(--btn-secondary-hover);
	}

	.pinned-session-btn:active {
		transform: translateY(0);
	}

	.pinned-session-btn.is-active {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-tint);
		background: var(--accent-tint);
	}

	.pinned-session-btn.is-run {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--sidebar-bg), 0 0 0 4px var(--accent);
		color: var(--accent);
	}

	.pinned-avatar-wrap :global(.row-avatar),
	.pinned-avatar-wrap :global(.row-avatar.size-md) {
		--avatar-size: 34px;
	}

	.pinned-session-btn.is-run .pinned-avatar-wrap::after {
		content: "";
		position: absolute;
		top: -2px;
		right: -2px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--ok);
		border: 2px solid var(--sidebar-bg);
		box-shadow: 0 0 6px var(--ok);
		animation: pulse-dot 1.4s ease-in-out infinite;
		z-index: 2;
	}

	.pinned-session-btn.is-active .pinned-session-name {
		color: var(--accent);
		font-weight: 600;
	}

	.pinned-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		background: var(--warn);
		color: #ffffff;
		font-size: 9.5px;
		font-weight: 700;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
		z-index: 2;
	}

	.search-icon-badge {
		position: absolute;
		left: 10px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted-light);
		pointer-events: none;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Groups and Session Rows */
	.groups {
		flex: 1;
		overflow-y: auto;
		padding: 6px 8px 12px;
	}

	.ghead {
		padding: 14px 10px 6px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.ghead:first-child {
		padding-top: 6px;
	}

	.ghead :global(.add) {
		width: 22px;
		height: 22px;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 15px;
		font-weight: 400;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
	}

	.ghead :global(.add:hover) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	/* Only the Bot↔Bot rows stack: a row plus the source line under it. */
	.row-stack {
		display: flex;
		flex-direction: column;
	}

	.row-stack .row {
		margin-bottom: 0;
	}

	.row-source {
		/* 10px row padding + 40px avatar + 10px gap: lines up under the title. */
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 0 10px 2px 60px;
		padding: 2px 6px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.3;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	button.row-source {
		cursor: pointer;
	}

	button.row-source:hover {
		background: var(--line-subtle);
		color: var(--accent);
	}

	button.row-source:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.row-source.is-static {
		opacity: 0.7;
	}

	.row-source-glyph {
		flex-shrink: 0;
		opacity: 0.8;
	}

	.row-source-text {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ghead-more {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: none;
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.ghead-more:hover {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.ghead-more:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.row {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) auto auto;
		grid-template-rows: auto auto;
		gap: 2px 10px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		margin: 1px 0;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		color: inherit;
		transition: all 0.12s ease;
	}

	.row:hover {
		background: var(--row-hover);
	}

	.row.is-on:hover {
		background: var(--accent-tint);
	}

	.row.is-on {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		box-shadow: 0 1px 2px rgba(37, 99, 235, 0.06);
	}

	/* Ring colors according to active / hover / container contexts */
	.row :global(.row-avatar) {
		--avatar-ring: var(--sidebar-bg);
	}

	.row:hover :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.row.is-on :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.row.is-on :global(.row-avatar) :global(.slot-overflow) {
		background: var(--accent);
		color: #ffffff;
		border-color: var(--accent);
	}

	.pinned-session-btn :global(.row-avatar) {
		--avatar-ring: var(--btn-secondary-bg);
	}

	.pinned-session-btn:hover :global(.row-avatar) {
		--avatar-ring: var(--btn-secondary-hover);
	}

	.pinned-session-btn.is-active :global(.row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.pinned-session-btn.is-active :global(.row-avatar) :global(.slot-overflow) {
		background: var(--accent);
		color: #ffffff;
		border-color: var(--accent);
	}

	.row.is-unread .t {
		font-weight: 750;
	}

	.row .t {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		grid-column: 2;
		grid-row: 1;
		min-width: 0;
	}

	.row.is-on .t {
		color: var(--accent);
	}

	.row :global(.s) {
		font-size: 12px;
		color: var(--muted);
		grid-column: 2 / -1;
		grid-row: 2;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.4;
		min-height: 1.4em;
	}

	/* Placed by the phone block below; a wide row shows the status chip in that corner instead. */
	.row-time {
		display: none;
	}

	.row-status {
		display: inline-flex;
		align-items: center;
		gap: 4.5px;
		grid-column: 3;
		grid-row: 1;
		font-size: 11px;
		line-height: 1;
		white-space: nowrap;
	}

	.row-status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.15s ease;
	}

	.row-status.is-idle .row-status-dot {
		background: var(--ok);
	}

	.row-status.is-idle .row-status-text {
		color: var(--muted-light);
		font-weight: 500;
	}

	.row-status.is-running .row-status-dot {
		background: var(--accent);
		animation: pulse 1s infinite;
	}

	.row-status.is-running .row-status-text {
		color: var(--accent);
		font-weight: 600;
	}

	.row-status.is-replying .row-status-dot {
		background: var(--accent);
		animation: pulse 1s infinite;
	}

	.row-status.is-replying .row-status-text {
		color: var(--accent);
		font-weight: 600;
	}

	.row-status.is-waiting_approval .row-status-dot {
		background: var(--warn);
	}

	.row-status.is-waiting_approval .row-status-text {
		color: var(--warn);
		font-weight: 600;
	}

	.row-status.is-waiting_ask .row-status-dot {
		background: var(--purple);
	}

	.row-status.is-waiting_ask .row-status-text {
		color: var(--purple);
		font-weight: 600;
	}

	.row-status.is-failed .row-status-dot,
	.row-status.is-interrupted .row-status-dot {
		background: var(--danger);
	}

	.row-status.is-failed .row-status-text,
	.row-status.is-interrupted .row-status-text {
		color: var(--danger-text);
		font-weight: 600;
	}

	.row-status .badge {
		margin-left: 2px;
		height: 16px;
		min-width: 16px;
		font-size: 9.5px;
		padding: 0 4px;
	}

	.unread-dot {
		grid-column: 4;
		grid-row: 1 / 3;
		align-self: center;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent);
		color: #ffffff;
		font-size: 9.5px;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 3px var(--accent-glow);
	}

	.pinned-unread {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: 8px;
		background: var(--accent);
		color: #ffffff;
		font-size: 9.5px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
	}

	.pinned-session-btn.is-unread:not(.is-run) {
		border-color: var(--accent-border);
	}

	.badge {
		background: var(--warn);
		color: #ffffff;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 700;
		min-width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 5px;
		grid-column: 2;
		box-shadow: 0 1px 3px rgba(217, 119, 6, 0.3);
	}

	.btn-back-sessions {
		font-size: 11px;
		font-weight: 500;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: var(--radius-sm);
		transition: opacity 0.15s ease;
	}

	.btn-back-sessions:hover {
		text-decoration: underline;
	}

	/* Sidebar Footer */
	.foot {
		border-top: 1px solid var(--line);
		padding: 6px 8px;
		display: flex;
		gap: 4px;
		align-items: center;
		container: sidebar-footer / inline-size;
		background: var(--glass-footer);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		position: relative;
		z-index: 20;
	}

	.foot-action {
		height: 36px;
		padding: 0 7px;
		gap: 6px;
		font: 500 12px/1 var(--font);
		white-space: nowrap;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s ease, color 0.15s ease;
		position: relative;
		cursor: pointer;
		flex-shrink: 0;
	}

	.foot-settings {
		margin-left: auto;
	}

	.tools-chevron {
		opacity: 0.65;
	}

	@container sidebar-footer (max-width: 270px) {
		.foot-action {
			padding-inline: 4px;
			gap: 4px;
		}

		.tools-chevron {
			display: none;
		}
	}

	@container sidebar-footer (max-width: 230px) {
		.foot-action svg {
			display: none;
		}
	}

	.foot-action:hover:not(:disabled) {
		border-color: var(--line);
		color: var(--ink);
		background: var(--btn-secondary-hover);
		box-shadow: var(--shadow-xs);
	}

	.foot-action.is-active {
		border-color: var(--accent-border);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.foot-action:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.foot-action:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.foot-badge {
		position: absolute;
		top: -3px;
		right: -3px;
		min-width: 14px;
		height: 14px;
		line-height: 12px;
		padding: 0 3px;
		border-radius: 999px;
		background: var(--accent);
		color: #ffffff;
		font-size: 9px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}

	.foot-badge.is-dot {
		min-width: 0;
		width: 8px;
		height: 8px;
		padding: 0;
		top: 3px;
		right: 3px;
		background: var(--danger);
	}

	/* Kept global: `.row` is the sidebar session row, but the context menu is what opens it. */
	.row.is-context-open {
		background: var(--line-subtle);
	}

	@keyframes pulse-dot {
		0%,
		100% {
		opacity: 1;
		transform: scale(1);
		}
		50% {
		opacity: 0.6;
		transform: scale(1.15);
		}
	}

	.search {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 12px 8px 32px;
		background: var(--input-bg);
		color: var(--ink);
		font-size: 13px;
		box-shadow: var(--shadow-xs);
		transition: all 0.15s ease;
	}

	.search:focus {
		background: var(--input-bg);
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}


	@keyframes sidebarMenuIn {
		from {
		opacity: 0;
		transform: scale(0.96) translateY(4px);
		}
		to {
		opacity: 1;
		transform: scale(1) translateY(0);
		}
	}

	@media (max-width: 680px) {
	.side {
	display: flex;
	width: 100%;
	}
	}
	@media (max-width: 680px) {
	/*
	 * A conversation covers the roster instead of replacing it, so the list is still here when
	 * that page walks back out to the right. The calendar is a page of its own and takes the
	 * column, so the roster steps aside for that one.
	 */
	:global(.shell.has-routines) .side,
	:global(.shell.has-terminal) .side {
	display: none;
	}
	}

	@media (max-width: 680px) {
		/*
		 * The roster reads like a messenger here: portrait, then the name with the time of the
		 * last thing said, then that message with the unread count beside it. No card behind the
		 * row — a hairline that starts where the text starts, so the eye follows one column.
		 */
		.row {
			grid-template-columns: 48px minmax(0, 1fr) auto;
			gap: 3px 12px;
			align-items: center;
			padding: 10px 14px;
			margin: 0;
			border: 0;
			border-radius: 0;
			position: relative;
		}

		.row + .row::before {
			content: '';
			position: absolute;
			left: 74px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line-subtle);
		}

		.row :global(.row-avatar) {
			--avatar-size: 48px;
			grid-row: 1 / 3;
			align-self: center;
		}

		.row .t {
			font-size: 15.5px;
			font-weight: 600;
			grid-column: 2;
			grid-row: 1;
		}

		.row-time {
			display: block;
			grid-column: 3;
			grid-row: 1;
			justify-self: end;
			font-size: 11.5px;
			line-height: 1.3;
			color: var(--muted-light);
			white-space: nowrap;
		}

		.row.is-unread .row-time {
			color: var(--accent);
		}

		.row :global(.s) {
			grid-column: 2;
			grid-row: 2;
			font-size: 13px;
			line-height: 1.35;
		}

		/*
		 * Idle is the normal state and the portrait already carries a dot for it, so the label
		 * only appears when the Bot is actually doing something — and then it speaks in place of
		 * the last message, the way a messenger shows "typing…".
		 */
		.row-status.is-idle {
			display: none;
		}

		.row-status:not(.is-idle) {
			grid-column: 2;
			grid-row: 2;
			font-size: 12.5px;
		}

		.row:has(.row-status:not(.is-idle)) :global(.s) {
			display: none;
		}

		.unread-dot {
			grid-column: 3;
			grid-row: 2;
			justify-self: end;
			align-self: center;
			min-width: 18px;
			height: 18px;
			padding: 0 5px;
			font-size: 10.5px;
		}

		/* Tapping a row leaves the list, so the selected one only needs a tint, not a frame. */
		.row.is-on {
			background: var(--accent-tint);
			border-color: transparent;
			box-shadow: none;
		}

		.ghead {
			padding: 12px 14px 4px;
			font-size: 10.5px;
		}

		/* Creating is the floating + now, so the headers are labels. */
		.ghead :global(.add) {
			display: none;
		}

		/* The source line belongs under the title, and the phone's avatar column is wider. */
		.row-source {
			margin: 0 14px 2px 74px;
		}

		/*
		 * A phone has no room for a scrollbar to push the list 15px off the edge the search field
		 * and the group headers keep; touch scrolling shows its own indicator anyway.
		 */
		.groups {
			scrollbar-width: none;
		}

		.groups::-webkit-scrollbar {
			width: 0;
			height: 0;
		}

		/* Nothing pinned is not news worth a row at the top of a phone screen. */
		.roster-empty-hint {
			display: none;
		}

		/* …and with the hint gone the rail was holding 88px of blank band, so it goes too. */
		.roster-panel:has(.roster-empty-hint) {
			display: none;
		}

		/*
		 * Mobile side body: natural vertical flex column.
		 */
		.side-body {
			display: flex;
			flex-direction: column;
			height: 100%;
		}

		/*
		 * Mobile header bar: tools menu on the left, full-width capsule search on the right.
		 * Padding accommodates safe-area notch and aligns with the conversation list (16px).
		 */
		.search-wrap {
			--tools-entry-size: 38px;
			display: flex;
			align-items: center;
			gap: 10px;
			margin: 0;
			padding: max(8px, env(safe-area-inset-top, 0px)) 16px 8px 16px;
			flex-shrink: 0;
		}

		.tools-entry-wrap {
			position: relative;
			display: inline-flex;
			flex: 0 0 auto;
		}

		.tools-entry {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: var(--tools-entry-size);
			height: var(--tools-entry-size);
			border: 1px solid var(--line);
			border-radius: var(--radius-md);
			background: var(--pane);
			color: var(--ink-secondary);
			cursor: pointer;
			position: relative;
			transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
		}

		.tools-entry:active,
		.tools-entry.is-active {
			background: var(--row-hover);
			color: var(--ink);
			border-color: var(--line-active, var(--line));
		}

		.search-trigger-wrap {
			flex: 1;
			min-width: 0;
			position: relative;
			display: flex;
			align-items: center;
		}

		.search-trigger-wrap .search-icon-badge {
			position: absolute;
			left: 12px;
			display: flex;
			align-items: center;
			justify-content: center;
			pointer-events: none;
			color: var(--muted);
		}

		.search-trigger {
			width: 100%;
			height: var(--tools-entry-size);
			padding: 0 14px 0 34px;
			border: 1px solid var(--line);
			border-radius: var(--radius-full);
			background: var(--pane);
			color: var(--muted);
			font-size: 14px;
			display: flex;
			align-items: center;
			text-align: left;
			cursor: pointer;
			transition: background 0.15s ease, border-color 0.15s ease;
		}

		.search-trigger:active {
			background: var(--row-hover);
			color: var(--ink);
		}

		/*
		 * Mobile archived navigation bar: clear Back button on the left, centered title with count.
		 */
		.mobile-archived-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			height: 52px;
			padding: max(6px, env(safe-area-inset-top, 0px)) 12px 6px 8px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
			flex-shrink: 0;
		}

		.mobile-archived-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 38px;
			height: 38px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
			flex-shrink: 0;
			transition: background 0.15s ease;
		}

		.mobile-archived-back:active {
			background: var(--row-hover);
		}

		.mobile-archived-title {
			margin: 0;
			font-size: 16px;
			font-weight: 600;
			color: var(--ink);
			display: flex;
			align-items: center;
			gap: 6px;
		}

		.mobile-archived-count {
			font-size: 13px;
			font-weight: 500;
			color: var(--muted);
		}

		.mobile-archived-spacer {
			width: 38px;
			flex-shrink: 0;
		}

		.groups {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
