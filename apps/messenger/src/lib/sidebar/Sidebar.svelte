<script lang="ts">
	import type { Hold, SessionSummary } from '@real-bot/protocol';
	import BrandMark from '../BrandMark.svelte';
	import EmptyState from '../EmptyState.svelte';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { groupSessions, isFileDropSession, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { BOT_DM_VISIBLE, recentBotDms, resolveBotDmOrigin } from './bot-dm-source.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import HoldsBar from './HoldsBar.svelte';
	import { holdLabel, listedHolds } from './holds-list.ts';
	import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from './working-only.ts';
	import { sessionTitle } from './session-title.ts';
	import { latestPreview } from '../chat/transcript.ts';
	import { sessionUnreadCount } from './unread.ts';
	import { formatListTime, listTimeSource } from './list-time.ts';
	import { plainPreview } from './preview-text.ts';
	import ToolsMenu from './ToolsMenu.svelte';
	import ToolsToggle from './ToolsToggle.svelte';
	import SessionRow from './SessionRow.svelte';
	import PinnedRoster from './PinnedRoster.svelte';
	import SidebarFoot from './SidebarFoot.svelte';
	import UsagePage from '../usage/UsagePage.svelte';
	import { usageWidget } from '../usage/usage-widget.svelte.ts';
	import CreateFab from './CreateFab.svelte';
	import WorkingFilter from './WorkingFilter.svelte';
	import MobileArchivedHead from './MobileArchivedHead.svelte';
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
		/**
		 * Whether the workbench is on screen, so the tools open as its tabs. Not the same as "wider
		 * than a phone": the app reached from a tablet is wider and still has no workbench, so its
		 * tools open the phone's pages.
		 */
		workbench: boolean;
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
		workbench,
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

	let viewingArchived = $state(false);
	/** A phone's usage page (ADR 0080), opened from Tools; wider windows have the floating widget instead. */
	let viewingUsage = $state(false);

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
		return sidebarStatus(session, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements, snapshot.messages);
	}

	/** Your stops that wait to be lifted, for the bar above the list. */
	const myHolds = $derived(snapshot.holdsOn ? listedHolds(snapshot.holds) : []);

	function labelOf(hold: Hold): string {
		return holdLabel(hold, { bots: botsById, sessions: sessionsById, roster: rosterLabels, t: t.control });
	}

	/**
	 * 「全部停下」 from the tools menu. A stop is only "stop for now", and the list shows none: your
	 * next line is the end of it (ADR 0081), so the menu never turns into a 「全部继续」.
	 */
	function everything(): void {
		void runtime.stopScope('global', null, runtime.selectedId);
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
			{#if !viewingArchived}<WorkingFilter {t} {workingOnly} {toggleWorkingOnly} />{/if}
			{#if onCollapse}{@render collapseButton()}{/if}
		</div>
	{/if}
	<!-- Nothing pinned is not news worth the top of the sidebar: the band only appears once something is. -->
	{#if pinnedSessions.length > 0}
	<PinnedRoster
		{runtime}
		{t}
		{pinnedSessions}
		{contextMenuSessionId}
		{onOpenContextMenu}
		{botsById}
		{botStatusOf}
		{statusOf}
		{unreadOf}
		{titleOf}
		{archivedSuffix}
	/>
	{/if}
	<div class="side-body relative flex-1 min-h-0 flex flex-col">
	{#if phone && viewingUsage}
		<UsagePage {runtime} {t} onBack={() => (viewingUsage = false)} />
	{:else}
	{#if phone && viewingArchived}
		<MobileArchivedHead {t} count={archivedSessions.length} onBack={() => (viewingArchived = false)} />
	{:else}
		<div class="search-wrap">
			{#if phone}<div class="tools-entry-wrap"><ToolsToggle {t} {phone} bind:open={toolsMenuOpen} bind:focusLast={toolsFocusLast} bind:buttonEl={toolsToggleBtnEl} /></div>{/if}
			<div class="search-trigger-wrap">
				{@render searchGlyph()}
				<button type="button" class="search search-trigger" aria-label={t.sidebar.globalSearch} aria-haspopup="dialog" onclick={onOpenSearch}>
					<span>{t.sidebar.searchShort}</span><kbd>{searchShortcutLabel()}</kbd>
				</button>
			</div>
			{#if phone && !viewingArchived}<WorkingFilter {t} {workingOnly} {toggleWorkingOnly} />{/if}
		</div>
		<HoldsBar holds={myHolds} label={labelOf} {t} disabled={runtime.connection !== 'connected'} onLift={(hold) => runtime.liftHold(hold.id)} />
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
					<SessionRow
						{session}
						{t}
						on={runtime.selectedId === session.id}
						contextOpen={contextMenuSessionId === session.id}
						archived
						title="{titleOf(session)}{archivedSuffix(session)}"
						time={timeOf(session)}
						{status}
						preview={previewOf(session) || t.sidebar.noMessages}
						{unread}
						bots={botsById}
						botStatus={botStatusOf}
						onSelect={() => void runtime.selectSession(session.id)}
						onContextMenu={(e) => onOpenContextMenu(e, session)}
					/>
				{/each}
			{/if}
		{:else}
			{#if fileDrop}
				<div class="ghead">
					<span>{t.sidebar.fileDrop}</span>
				</div>
				{@const dropStatus = statusOf(fileDrop)}
				{@const dropUnread = unreadOf(fileDrop)}
				<SessionRow
					session={fileDrop}
					{t}
					on={runtime.selectedId === fileDrop.id}
					contextOpen={contextMenuSessionId === fileDrop.id}
					fileDrop
					title={t.sidebar.fileDrop}
					time={timeOf(fileDrop)}
					status={dropStatus}
					showCount={false}
					preview={previewOf(fileDrop) || t.sidebar.fileDropHint}
					unread={dropUnread}
					bots={botsById}
					botStatus={botStatusOf}
					onSelect={() => void runtime.selectSession(fileDrop.id)}
					onContextMenu={(e) => onOpenContextMenu(e, fileDrop)}
				/>
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
				<SessionRow
					{session}
					{t}
					on={runtime.selectedId === session.id}
					contextOpen={contextMenuSessionId === session.id}
					title={titleOf(session)}
					time={timeOf(session)}
					{status}
					preview={previewOf(session) || t.sidebar.noMessages}
					{unread}
					bots={botsById}
					botStatus={botStatusOf}
					onSelect={() => void runtime.selectSession(session.id)}
					onContextMenu={(e) => onOpenContextMenu(e, session)}
				/>
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
				<SessionRow
					{session}
					{t}
					on={runtime.selectedId === session.id}
					contextOpen={contextMenuSessionId === session.id}
					title="{titleOf(session)}{archivedSuffix(session)}"
					time={timeOf(session)}
					{status}
					preview={previewOf(session) || t.sidebar.noMessages}
					{unread}
					bots={botsById}
					botStatus={botStatusOf}
					onSelect={() => void runtime.selectSession(session.id)}
					onContextMenu={(e) => onOpenContextMenu(e, session)}
				/>
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
					<SessionRow
						{session}
						{t}
						on={runtime.selectedId === session.id}
						contextOpen={contextMenuSessionId === session.id}
						title={titleOf(session)}
						time={timeOf(session)}
						{status}
						preview={previewOf(session) || t.sidebar.noMessages}
						unread={0}
						bots={botsById}
						botStatus={botStatusOf}
						onSelect={() => void runtime.selectSession(session.id)}
						onContextMenu={(e) => onOpenContextMenu(e, session)}
					/>
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
	{/if}
	</div>
	{#if !phone}
		<SidebarFoot
			{runtime}
			{t}
			{workspaceOpen}
			workspacePath={snapshot.settings.workspace_path}
			{onToggleWorkspace}
			{onOpenSettings}
			bind:toolsMenuOpen
			bind:toolsFocusLast
			bind:toolsToggleBtnEl
		/>
	{/if}
	<ToolsMenu
		{t}
		locale={snapshot.settings.locale === 'en' ? 'en' : 'zh'}
		{phone}
		pages={!workbench}
		anchor={toolsToggleBtnEl}
		bind:open={toolsMenuOpen}
		bind:focusLast={toolsFocusLast}
		archivedCount={archivedSessions.length}
		current={{
			routines: !workbench && runtime.routinesOpen,
			spend: !workbench && runtime.spendOpen,
			usage: phone ? viewingUsage : !workbench && usageWidget.open,
			terminal: !workbench && runtime.terminalOpen,
			screen: runtime.screenOpen,
			archived: viewingArchived
		}}
		{onOpenRoutines}
		{onOpenSpend}
		onOpenUsage={() => {
			if (!phone) return runtime.openUsage();
			viewingArchived = false;
			viewingUsage = true;
		}}
		onOpenTerminal={() => (workbench ? onNewTerminal() : runtime.openTerminal())}
		onOpenScreen={runtime.screenOffered ? () => runtime.openRemoteScreen() : null}
		screenHost={runtime.screenHost}
		onOpenArchived={() => {
			viewingUsage = false;
			viewingArchived = true;
		}}
		everything={snapshot.holdsOn ? 'stop' : null}
		everythingDisabled={runtime.connection !== 'connected'}
		onEverything={everything}
	/>
</aside>


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

<!--
	Creating on a phone: one button that floats over the list rather than a + in each group header.
	The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	there are two of them saying the same kind of thing; this asks which once, where your thumb is.
-->
{#if phone && !selected && !searchOpen && !viewingArchived && !viewingUsage && !workspaceOpen && !runtime.settingsOpen && !runtime.routinesOpen && !runtime.spendOpen && !runtime.terminalOpen && !runtime.screenOpen}
	<CreateFab {t} bind:createMenuOpen bind:wrapEl={fabEl} {onCreateBot} {onCreateGroup} />
{/if}

<style>
	@media (max-width: 680px) {
		.side > :global(.foot) { display: none; }
		.groups .archived-ghead { display: none; }
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

	.row-stack :global(.row) {
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

		.working-empty-hint {
			font-size: 13px;
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

		.groups {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
