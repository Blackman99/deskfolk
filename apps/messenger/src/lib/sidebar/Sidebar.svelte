<script lang="ts">
	import type { Hold, SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import BrandMark from '../BrandMark.svelte';
	import EmptyState from '../EmptyState.svelte';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { groupSessions, isFileDropSession, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { BOT_DM_VISIBLE, recentBotDms, resolveBotDmOrigin } from './bot-dm-source.ts';
	import { botWorkStatus, sidebarStatus, type SessionStatusResult } from './session-status.ts';
	import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from './working-only.ts';
	import { sessionTitle } from './session-title.ts';
	import { latestPreview } from '../chat/transcript.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import { formatListTime, listTimeSource } from './list-time.ts';
	import { plainPreview } from './preview-text.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import ToolsMenu from './ToolsMenu.svelte';
	import HoldsBar from './HoldsBar.svelte';
	import { holdLabel, listedHolds, sessionHeld } from './holds-list.ts';
	import { searchShortcutLabel } from '../search/shortcuts.ts';
	import { formatShortcut } from '../keymap.ts';

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

	/**
	 * The list shows only what a Bot is working in or you have not read, and the conversation on
	 * screen. The pins above keep every pin. The rail reads and writes the same stored switch, and
	 * only one of the two is mounted at a time.
	 */
	let workingOnly = $state(loadWorkingOnly());
	function toggleWorkingOnly(): void {
		workingOnly = !workingOnly;
		saveWorkingOnly(workingOnly);
	}
	/** Null while the list is unfiltered. */
	const workingIds = $derived(
		workingOnly
			? workingOrUnreadIds(snapshot.sessions, snapshot.turns, snapshot.approvals, snapshot.pendingJudgements)
			: null
	);
	const listed = $derived(onlyWorking(grouped, workingIds, runtime.selectedId));

	const fileDrop = $derived(listed.fileDrop);
	const groupRows = $derived(listed.groups);
	const youBotRows = $derived(listed.youBot);
	let botBotExpanded = $state(false);
	/** Filtered, every working direct is listed: the cap is for idle history, not for live work. */
	const botBotVisible = $derived(
		workingIds
			? recentBotDms(listed.botBot, { expanded: true })
			: recentBotDms(grouped.botBot, {
					keepId: runtime.selectedId,
					expanded: botBotExpanded
				})
	);
	const nothingWorking = $derived(
		workingIds !== null && !fileDrop && groupRows.length === 0 && youBotRows.length === 0 && botBotVisible.length === 0
	);
	/** No conversation at all yet, unfiltered: the list says how to start one instead of three bare headers. */
	const rosterEmpty = $derived(
		workingIds === null && !fileDrop && groupRows.length === 0 && youBotRows.length === 0 && botBotVisible.length === 0
	);
	const archivedSessions = $derived(
		snapshot.sessions.filter((session) => isSessionArchived(session, botsById))
	);
	const pinnedSessions = $derived(
		pinnedSessionIds
			.map((id) => sessionsById.get(id))
			.filter((session): session is SessionSummary => Boolean(session))
	);
	const pinnedWorking = $derived(workingIds !== null && pinnedSessions.some((session) => workingIds.has(session.id)));

	let pinnedExpanded = $state(false);
	let viewingArchived = $state(false);

	let phone = $state(false);
	/**
	 * The footer row. Its labels hide once the three of them no longer fit beside each other; a
	 * list under 240px drops them in CSS even when they would fit.
	 */
	let footEl = $state<HTMLElement | null>(null);
	let footCompact = $state(false);
	$effect(() => {
		const foot = footEl;
		if (!foot || typeof ResizeObserver !== 'function') return;
		// How wide the row is while its words are showing. A plain variable, not state: reading the
		// state here would rerun this effect the moment the words hide, and forget the width.
		let labelWidth = 0;
		let compact = false;
		// The buttons, the gaps between them and the padding at both ends. Not scrollWidth: that only
		// grows once a button crosses the edge, so words that have eaten the end padding still "fit".
		const rowWidth = () => {
			const style = getComputedStyle(foot);
			const buttons = [...foot.children];
			const gaps = (parseFloat(style.columnGap) || 0) * Math.max(0, buttons.length - 1);
			const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
			return buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, gaps + padding);
		};
		const measure = () => {
			const room = foot.clientWidth;
			if (!compact) {
				labelWidth = rowWidth();
				compact = labelWidth > room + 1;
			} else if (labelWidth > 0 && labelWidth <= room + 1) {
				compact = false;
			}
			footCompact = compact;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(foot);
		return () => observer.disconnect();
	});
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
		const status = sidebarStatus(
			session,
			snapshot.turns,
			snapshot.approvals,
			statusLabels,
			snapshot.pendingJudgements,
			snapshot.messages
		);
		// A stop of yours on the group or the Bot speaks where the last line would, like any state.
		if (status.kind === 'idle' && sessionHeld(session, myHolds)) return { kind: 'held', label: t.control.rowHeld, isBusy: false } satisfies SessionStatusResult;
		return status;
	}

	/** Your stops in force, for the bar above the list and the rows they hold. */
	const myHolds = $derived(snapshot.holdsOn ? listedHolds(snapshot.holds) : []);
	const everythingHeld = $derived(snapshot.holds.filter((hold) => hold.scope === 'global'));

	function labelOf(hold: Hold): string {
		return holdLabel(hold, { bots: botsById, sessions: sessionsById, roster: rosterLabels, t: t.control });
	}

	/** The stops on everything as they stand, which 「全部停下」 or 「全部继续」 acts on. */
	const everythingNow = $derived(everythingHeld.map((hold) => hold.id).join(' '));
	/**
	 * 「全部停下」 or 「全部继续」 was refused, with the stops on everything as they stood then: the
	 * bar above the list says so until the next press, or until everything is stopped or let go some
	 * other way (the menu bar, a row's lift, a stop menu), when the note would no longer be true.
	 */
	let everythingRefused = $state<string | null>(null);
	const everythingFailed = $derived(everythingRefused === everythingNow);
	// Forgotten as soon as the stops move on, so a later return to how they stood (stopped
	// elsewhere, then lifted) does not bring back a refusal nobody has pressed again for.
	$effect.pre(() => {
		if (everythingRefused !== null && everythingRefused !== everythingNow) everythingRefused = null;
	});

	/** 「全部停下」 from the tools menu, or, while everything is stopped, lifting that. */
	async function everything(): Promise<void> {
		const over = everythingNow;
		everythingRefused = null;
		const refused =
			everythingHeld.length > 0
				? await Promise.all(everythingHeld.map((hold) => runtime.liftHold(hold.id)))
				: [await runtime.stopScope('global', null, runtime.selectedId)];
		everythingRefused = refused.some(Boolean) ? over : null;
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
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="11" cy="11" r="8"></circle>
			<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
		</svg>
	</span>
{/snippet}

<aside class="side">
	<!-- The mark heads the list on a wider window; a phone's top bar is the page title instead. -->
	{#if !phone}
		<div class="brand-row">
			<BrandMark size={22} />
			<span class="brand-name">Deskfolk</span>
			{#if !viewingArchived}{@render workingFilter()}{/if}
			{#if onCollapse}{@render collapseButton()}{/if}
		</div>
	{/if}
	<!-- Nothing pinned is not news worth the top of the sidebar: the band only appears once something is. -->
	{#if pinnedSessions.length > 0}
	<div class="roster-panel">
		<div class="roster" class:is-expanded={pinnedExpanded} title={t.sidebar.pinned}>
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
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class:is-rotated={pinnedExpanded}
				>
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
		{/if}
	</div>
	{/if}
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
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
			{#if phone && !viewingArchived}{@render workingFilter()}{/if}
		</div>
		<HoldsBar holds={myHolds} label={labelOf} {t} disabled={runtime.connection !== 'connected'} failed={everythingFailed} onLift={(hold) => runtime.liftHold(hold.id)} />
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
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
			{#if !workingIds || groupRows.length > 0}
				<div class="ghead">
					<span>{t.sidebar.groups}</span>
					<button type="button" class="add" title={t.sidebar.addGroup} onclick={onCreateGroup}
						>+</button
					>
				</div>
			{/if}
			{#each groupRows as session (session.id)}
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
			{#if !workingIds || youBotRows.length > 0}
				<div class="ghead">
					<span>{t.sidebar.youBot}</span>
					<button type="button" class="add" title={t.sidebar.addBot} onclick={onCreateBot}>+</button>
				</div>
			{/if}
			{#each youBotRows as session (session.id)}
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
			{#if !workingIds || botBotVisible.length > 0}
				<div class="ghead">
					<span>{t.sidebar.botBot}</span>
					{#if !workingIds && grouped.botBot.length > BOT_DM_VISIBLE}
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
			{/if}
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
			{#if nothingWorking}
				<p class="working-empty-hint">{pinnedWorking ? t.sidebar.workingEmptyPinned : t.sidebar.workingEmpty}</p>
			{/if}
			{#if rosterEmpty}
				<EmptyState size="inline" level={3} title={t.sidebar.rosterEmpty} hint={t.sidebar.rosterEmptyHint}>
					<button type="button" class="roster-empty-btn is-primary" onclick={onCreateBot}>{t.sidebar.addBot}</button>
					<button type="button" class="roster-empty-btn" onclick={onCreateGroup}>{t.sidebar.addGroup}</button>
				</EmptyState>
			{/if}
		{/if}
	</div>
	</div>
	{#if !phone}
		<div class="foot" class:is-compact={footCompact} bind:this={footEl}>
			<button
				type="button"
				class="foot-action"
				class:is-active={workspaceOpen}
				title={snapshot.settings.workspace_path ? `${t.sidebar.workspace} (${formatShortcut(['mod', 'O'])})` : t.sidebar.workspaceUnset}
				aria-label={t.sidebar.workspace}
				aria-expanded={workspaceOpen}
				disabled={!snapshot.settings.workspace_path}
				onclick={() => onToggleWorkspace()}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
				</svg>
				<span class="foot-label">{t.sidebar.workspace}</span>
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
				<span class="foot-label">{t.sidebar.settings}</span>
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
			screen: runtime.screenOpen,
			archived: viewingArchived
		}}
		{onOpenRoutines}
		{onOpenSpend}
		onOpenTerminal={() => (phone ? runtime.openTerminal() : onNewTerminal())}
		onOpenScreen={runtime.screenOffered ? () => runtime.openRemoteScreen() : null}
		screenHost={runtime.screenHost}
		onOpenArchived={() => (viewingArchived = true)}
		everything={snapshot.holdsOn ? (everythingHeld.length > 0 ? 'go-on' : 'stop') : null}
		everythingDisabled={runtime.connection !== 'connected'}
		onEverything={() => void everything()}
	/>
</aside>

{#snippet workingFilter()}
	<button
		type="button"
		class="working-filter"
		class:is-active={workingOnly}
		title={workingOnly ? t.sidebar.workingOnlyOff : t.sidebar.workingOnly}
		aria-label={t.sidebar.workingOnly}
		aria-pressed={workingOnly}
		onclick={toggleWorkingOnly}
	>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
		</svg>
	</button>
{/snippet}

{#snippet collapseButton()}
	<button
		type="button"
		class="side-collapse"
		title="{t.sidebar.hide} ({formatShortcut(['mod', 'B'])})"
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
{/snippet}

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
			<span class="foot-label">{t.sidebar.tools}</span>
			<svg class="tools-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg>
		{/if}
	</button>
{/snippet}

<!--
	Creating on a phone: one button that floats over the list rather than a + in each group header.
	The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	there are two of them saying the same kind of thing; this asks which once, where your thumb is.
-->
{#if phone && !selected && !searchOpen && !viewingArchived && !workspaceOpen && !runtime.settingsOpen && !runtime.routinesOpen && !runtime.spendOpen && !runtime.terminalOpen && !runtime.screenOpen}
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
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
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

	/* The mark and the name, with the list's two switches at the far end. */
	.brand-row {
		display: flex;
		align-items: center;
		gap: 4px;
		height: 46px;
		padding: 6px 10px 0 16px;
		flex-shrink: 0;
	}

	.brand-name {
		flex: 1;
		min-width: 0;
		margin-left: 4px;
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.search-wrap {
		position: relative;
		margin: 10px 12px 6px;
		display: flex;
		align-items: center;
		gap: 8px;
		container: sidebar-search / inline-size;
	}

	/* Right under the mark, the search needs no gap of its own above it. */
	.brand-row + .side-body .search-wrap {
		margin-top: 4px;
	}

	.roster-empty-btn {
		height: 32px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}

	.roster-empty-btn:hover {
		background: var(--btn-secondary-hover);
		border-color: var(--line-hover);
	}

	.roster-empty-btn.is-primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.roster-empty-btn.is-primary:hover {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
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

	.working-filter {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
	}

	.working-filter:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.working-filter.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.working-filter:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.working-empty-hint {
		margin: 0;
		padding: 36px 20px;
		text-align: center;
		font-size: 12px;
		color: var(--muted);
	}

	.search-trigger-wrap { position: relative; flex: 1; min-width: 0; }
	.search-trigger { display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left; cursor: pointer; }
	.search-trigger span { color: var(--muted); }
	.search-trigger kbd { flex-shrink: 0; padding: 1px 4px; border: 1px solid var(--line); border-radius: var(--radius-xs); color: var(--muted); font: 10px var(--font); }
	.search-trigger:hover { border-color: var(--line-hover); background: var(--row-hover); }
	@media (max-width: 680px) { .search-trigger kbd { display: none; } }
	/* Beside the two buttons, a list dragged to its narrowest has no room for "Search" and ⌘K both. */
	@container sidebar-search (max-width: 199px) { .search-trigger kbd { display: none; } }

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
		color: var(--on-accent);
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
		transition: 0.2s ease;
		transition-property: max-height, gap;
	}

	.roster::-webkit-scrollbar {
		height: 4px;
	}

	.roster::-webkit-scrollbar-thumb {
		background: var(--line-hover);
		border-radius: var(--radius-xs);
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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
		transition: 0.16s cubic-bezier(0.16, 1, 0.3, 1);
		transition-property: var(--transition-props);
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
		color: var(--on-warn);
		font-size: 10px;
		font-weight: 700;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: var(--radius-md);
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

	/* Sentence case at caption size: uppercase and tracking did nothing for 群 or 你 ↔ Bot. */
	.ghead {
		padding: 14px 10px 4px;
		font-size: var(--text-caption);
		font-weight: 600;
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}

	.row:hover {
		background: var(--row-hover);
	}

	.row.is-on:hover {
		background: var(--accent-tint);
	}

	/* The tint alone marks the open conversation; an outline on top of it was one signal too many. */
	.row.is-on {
		background: var(--accent-tint);
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
		color: var(--on-accent);
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
		color: var(--on-accent);
		border-color: var(--accent);
	}

	.row.is-unread .t {
		font-weight: 750;
	}

	.row .t {
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		grid-column: 2;
		grid-row: 1;
		min-width: 0;
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

	/* The time beside each name, the way a messenger shows it. */
	.row-time {
		grid-column: 3;
		grid-row: 1;
		justify-self: end;
		align-self: center;
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
		white-space: nowrap;
	}

	.row.is-unread .row-time {
		color: var(--mustard-ink);
		font-weight: 600;
	}

	/*
	 * Idle is the normal state, so it carries no mark at all: a green "空闲" on every row drowned
	 * out the rows that did need a look. The label only appears when a Bot is doing something or
	 * waiting on you, and then it speaks in place of the last message, the way a messenger shows
	 * "typing…".
	 */
	.row-status {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		grid-column: 2 / 4;
		grid-row: 2;
		min-width: 0;
		font-size: 12px;
		line-height: 1.4;
		white-space: nowrap;
	}

	.row-status.is-idle {
		display: none;
	}

	.row:has(.row-status:not(.is-idle)) :global(.s) {
		display: none;
	}

	.row-status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.15s ease;
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
		color: var(--warn-text);
		font-weight: 600;
	}

	.row-status.is-waiting_ask .row-status-dot {
		background: var(--purple);
	}

	.row-status.is-waiting_ask .row-status-text {
		color: var(--purple-text);
		font-weight: 600;
	}

	/* Stopped by you: not a state that needs a look, so it stays grey; the square says which. */
	.row-status.is-held .row-status-dot {
		background: var(--muted);
		border-radius: 1px;
	}

	.row-status.is-held .row-status-text {
		color: var(--muted);
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
		font-size: 10px;
		padding: 0 4px;
	}

	.unread-dot {
		grid-column: 4;
		grid-row: 1 / 3;
		align-self: center;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: var(--radius-full);
		/* Unread is the one place the mark's mustard marks the list: new, not working or selected. */
		background: var(--mustard);
		color: var(--on-mustard);
		font-size: 10px;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.pinned-unread {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: var(--radius-md);
		background: var(--mustard);
		color: var(--on-mustard);
		font-size: 10px;
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
		color: var(--on-warn);
		border-radius: var(--radius-full);
		font-size: 10px;
		font-weight: 700;
		min-width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 5px;
		grid-column: 2;
		box-shadow: 0 1px 3px color-mix(in srgb, var(--warn) 30%, transparent);
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

	/*
	 * A list under 300px tightens the row. Up to there the roomy one has to fit: written out in
	 * English it is 295px wide, and switching any earlier left a band where it overflowed into
	 * icons while a narrower list still showed the words.
	 */
	@container sidebar-footer (max-width: 283px) {
		.foot-action {
			padding-inline: 4px;
			gap: 4px;
		}

		.tools-chevron {
			display: none;
		}
	}

	/*
	 * Icons only. Under 240px the words would stand shoulder to shoulder even where they still fit
	 * (Chinese fits down to the 200px minimum), and at any width once the three no longer fit.
	 */
	@container sidebar-footer (max-width: 223px) {
		.foot-label,
		.tools-chevron {
			display: none;
		}

		.foot-action {
			padding-inline: 8px;
		}
	}

	.foot.is-compact .foot-label,
	.foot.is-compact .tools-chevron {
		display: none;
	}

	.foot.is-compact .foot-action {
		padding-inline: 8px;
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
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--on-accent);
		font-size: 10px;
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
		/* An update is news, not an error. */
		background: var(--accent);
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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
			font-size: 16px;
			font-weight: 600;
			grid-column: 2;
			grid-row: 1;
		}

		.row-time {
			font-size: 12px;
		}

		.row :global(.s) {
			grid-column: 2;
			grid-row: 2;
			font-size: 13px;
			line-height: 1.35;
		}

		.row-status {
			grid-column: 2;
			font-size: 13px;
		}

		.unread-dot {
			grid-column: 3;
			grid-row: 2;
			justify-self: end;
			align-self: center;
			min-width: 18px;
			height: 18px;
			padding: 0 5px;
			font-size: 11px;
		}

		/* Tapping a row leaves the list, so the selected one only needs a tint, not a frame. */
		.row.is-on {
			background: var(--accent-tint);
			border-color: transparent;
			box-shadow: none;
		}

		.ghead {
			padding: 12px 14px 4px;
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
		/* Room under the last row for the floating + (52px and its 16px inset), so the list can
		   scroll every row clear of it instead of leaving the last one's time underneath. */
		.groups {
			scrollbar-width: none;
			padding-bottom: 84px;
		}

		.groups::-webkit-scrollbar {
			width: 0;
			height: 0;
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

		.working-filter {
			width: var(--tools-entry-size);
			height: var(--tools-entry-size);
			border-color: var(--line);
			border-radius: var(--radius-md);
			background: var(--pane);
			color: var(--ink-secondary);
		}

		.working-filter:active {
			background: var(--row-hover);
		}

		.working-filter.is-active {
			border-color: var(--accent-border);
			background: var(--accent-tint);
			color: var(--accent);
		}

		.working-empty-hint {
			font-size: 13px;
		}

		.tools-entry:active,
		.tools-entry.is-active {
			background: var(--row-hover);
			color: var(--ink);
			border-color: var(--line-hover);
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
