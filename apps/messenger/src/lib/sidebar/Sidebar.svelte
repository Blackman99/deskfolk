<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Hold, SessionSummary } from '@real-bot/protocol';
	import BrandMark from '../BrandMark.svelte';
	import { dragRegion, scrollbarIsNotDrag } from '../window-chrome.ts';
	import EmptyState from '../EmptyState.svelte';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, groupSessions, isFileDropSession, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { directElsewhere } from './bot-elsewhere.ts';
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
	import ProjectSessionRow from './ProjectSessionRow.svelte';
	import ProjectAddMenu from './ProjectAddMenu.svelte';
	import { newProjectIn, newProjectInFolder } from './project-actions.ts';
	import { dirDisplay, dirSession, groupProjectSessions, isLiveRun, liveRunSessionIds, PROJECT_AGENTS, projectAgentOf } from './project-groups.ts';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from '../reduced-motion.ts';
	import { isSessionPinned } from './pinned-sessions.ts';
	import PinnedRoster from './PinnedRoster.svelte';
	import SidebarFoot from './SidebarFoot.svelte';
	import UsagePage from '../usage/UsagePage.svelte';
	import RolesPage from '../settings/RolesPage.svelte';
	import { usageWidget } from '../usage/usage-widget.svelte.ts';
	import CreateFab from './CreateFab.svelte';
	import WorkingFilter from './WorkingFilter.svelte';
	import FocusToggle from './FocusToggle.svelte';
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
		/** The project session whose row is a name field for now (ADR 0095). */
		renamingSessionId?: string | null;
		/** On a phone, which page of the bottom bar this list is: your Bots' conversations or the projects. */
		phoneList?: 'bots' | 'projects';
		/** Its new name, or null to leave it; false when the name did not go through. */
		onRenameSession?: (sessionId: string, name: string | null) => Promise<boolean>;
		onOpenContextMenu: (e: MouseEvent, session: SessionSummary) => void;
		/** Pin or unpin a conversation from its row, without opening its menu. */
		onTogglePin?: (sessionId: string) => void;
		/** A project directory opened in the preview, by one of its sessions: its tree is that session's project. */
		onOpenProjectDir?: (session: SessionSummary) => void;
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
		/** A press on a conversation that may become a drag into the workbench: only where there is one. */
		onDragSession?: (event: PointerEvent, session: SessionSummary) => void;
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
		renamingSessionId = null,
		phoneList = 'bots',
		onRenameSession,
		onOpenContextMenu,
		onTogglePin,
		onOpenProjectDir,
		onToggleWorkspace,
		onOpenRoutines,
		onOpenSpend,
		workbench,
		onNewTerminal,
		onOpenSettings,
		onCreateBot,
		onCreateGroup,
		onCollapse,
		onDragSession
	}: Props = $props();

	/** A row that moves up the list (a new message) slides there instead of jumping. */
	const rowFlip = () => ({ duration: prefersReducedMotion() ? 0 : 240, easing: cubicOut });

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	const aliveBotIds = $derived(new Set(snapshot.bots.map((b) => b.id)));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop, projectUntitled: t.project.untitled });
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
			? workingOrUnreadIds(snapshot.sessions, snapshot.turns, snapshot.approvals, snapshot.pendingJudgements, liveRunSessionIds(snapshot.agentRuns))
			: null
	);
	const listed = $derived(onlyWorking(grouped, workingIds, runtime.selectedId));

	/** Set from the phone media query below. */
	let phone = $state(false);
	/** A phone lists the Bots and the projects on two pages of its bottom bar; a wider window, together. */
	const showBots = $derived(!phone || phoneList === 'bots');
	const showProjects = $derived(!phone || phoneList === 'projects');
	const fileDrop = $derived(showBots ? listed.fileDrop : null);
	const groupRows = $derived(showBots ? listed.groups : []);
	const youBotRows = $derived(showBots ? listed.youBot : []);
	// A Bot↔Bot direct is not listed: it opens from the message it hangs under, in a popup (ADR 0091).
	const projectGroups = $derived(showProjects ? groupProjectSessions(listed.project) : []);
	const nothingWorking = $derived(
		workingIds !== null && !fileDrop && groupRows.length === 0 && youBotRows.length === 0 && projectGroups.length === 0
	);
	/** No conversation at all yet, unfiltered: the list says how to start one instead of bare headers. */
	const rosterEmpty = $derived(
		showBots && workingIds === null && !fileDrop && groupRows.length === 0 && youBotRows.length === 0 && projectGroups.length === 0
	);
	/** A phone's projects page with no project session yet says how to start one. */
	const projectsEmpty = $derived(!showBots && workingIds === null && projectGroups.length === 0);
	const archivedSessions = $derived(
		snapshot.sessions.filter((session) => isSessionArchived(session, botsById))
	);
	// A Bot↔Bot direct pinned before ADR 0091 stays out too: it opens only from its message.
	const pinnedSessions = $derived(
		pinnedSessionIds
			.map((id) => sessionsById.get(id))
			.filter((session): session is SessionSummary => Boolean(session) && classifySession(session!) !== 'bot-bot')
	);
	const pinnedWorking = $derived(workingIds !== null && pinnedSessions.some((session) => workingIds.has(session.id)));

	/**
	 * Which directories of the 「项目」 section are open: every one until you fold it, as in the
	 * agents' desktop apps — on a phone nothing is selected yet, and folded rows hid every session.
	 */
	let openDirs = $state<Record<string, boolean>>({});
	function dirOpen(dir: string): boolean {
		return openDirs[dir] ?? true;
	}
	function toggleDir(dir: string): void {
		openDirs = { ...openDirs, [dir]: !dirOpen(dir) };
	}
	/** The section's +: a new session of each agent in a folder, or a terminal session carried on (ADR 0095, ADR 0099). */
	let projectMenuOpen = $state(false);
	let projectAddEl = $state<HTMLButtonElement | null>(null);
	/**
	 * A directory's +, or a right-click on its row: a new session of each agent right there, the
	 * directory opened in the preview, and a terminal started in it. `point` is where the right-click
	 * was; the + leaves it out.
	 */
	let dirMenuOpen = $state(false);
	let dirMenuFor = $state<{ dir: string; label: string; anchor: HTMLElement; point?: { x: number; y: number } } | null>(null);
	/** Opens the directory the menu is for, by the session `dirSession` picks among those listed now. */
	function openDirOfMenu(): void {
		const group = dirMenuFor && projectGroups.find((row) => row.dir === dirMenuFor?.dir);
		if (group) onOpenProjectDir?.(dirSession(group, runtime.selectedId));
	}

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

	/** The archived list in a wide window: part of the list, not a page of its own. */
	let archivedInList = $state(false);
	/**
	 * On a phone, usage and the archived list are pages in the URL like the calendar (`?o=usage`,
	 * `?o=archived`), so Back walks out of them to the list.
	 */
	const viewingArchived = $derived(phone ? runtime.listPage === 'archived' : archivedInList);
	/** A phone's usage page (ADR 0080), opened from Tools; wider windows have the usage tab instead. */
	const viewingUsage = $derived(phone && runtime.listPage === 'usage');
	/** Roles (ADR 0083) where there is no workbench to hold its tab: a page in place of the list. */
	const viewingRoles = $derived(runtime.listPage === 'roles');

	function openArchived(): void {
		if (phone) runtime.openListPage('archived');
		else archivedInList = true;
	}

	function closeArchived(): void {
		if (phone) runtime.closeListPage();
		else archivedInList = false;
	}

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

	function pressOf(session: SessionSummary): ((event: PointerEvent) => void) | undefined {
		return onDragSession ? (event) => onDragSession(event, session) : undefined;
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

	/** Your direct's row, quiet here, with its Bot at work in another conversation: where. */
	function elsewhereOf(session: SessionSummary, status: ReturnType<typeof statusOf>): string | null {
		if (status.kind !== 'idle') return null;
		return directElsewhere(session, false, snapshot, botsById, statusLabels, rosterLabels, t.sidebar.elsewhere);
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
		openArchived();
	}

</script>

<svelte:window onclick={onWindowClick} />

{#snippet searchGlyph()}
	<span class="search-icon-badge absolute left-5 text-muted-light pointer-events-none flex items-center justify-center" aria-hidden="true">
		<Icon name="search" />
	</span>
{/snippet}

<aside class="side">
	<!-- The mark heads the list on a wider window; a phone's top bar is the page title instead. -->
	{#if !phone}
		<div class="brand-row" data-tauri-drag-region={dragRegion}>
			<BrandMark size={22} />
			<span class="brand-name" data-tauri-drag-region={dragRegion}>Deskfolk</span>
			{#if !viewingArchived}<WorkingFilter {t} {workingOnly} {toggleWorkingOnly} />{/if}
			<FocusToggle {t} />
			{#if onCollapse}{@render collapseButton()}{/if}
		</div>
	{/if}
	<!-- Nothing pinned is not news worth the top of the sidebar: the band only appears once something is. -->
	{#if pinnedSessions.length > 0 && showBots}
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
		{onDragSession}
	/>
	{/if}
	<div class="side-body relative flex-1 min-h-0 flex flex-col">
	{#if viewingRoles}
		<RolesPage {runtime} {t} host="page" onBack={() => runtime.closeListPage()} />
	{:else if phone && viewingUsage}
		<UsagePage {runtime} {t} onBack={() => runtime.closeListPage()} />
	{:else}
	{#if phone && viewingArchived}
		<MobileArchivedHead {t} count={archivedSessions.length} onBack={closeArchived} />
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
			{#if phone}<FocusToggle {t} />{/if}
		</div>
		<HoldsBar holds={myHolds} label={labelOf} {t} disabled={runtime.connection !== 'connected'} onLift={(hold) => runtime.liftHold(hold.id)} />
	{/if}
	<!-- The list's empty space moves the window, as the brand row does; its rows keep their clicks. -->
	<div class="groups" data-tauri-drag-region={dragRegion} use:scrollbarIsNotDrag>
		{#if viewingArchived}
			<div class="ghead archived-ghead flex items-center justify-between">
				<span>{t.sidebar.archivedSessions}</span>
				<button type="button" class="btn-back-sessions" onclick={closeArchived}>
					{t.sidebar.backToSessions}
				</button>
			</div>
			{#if archivedSessions.length === 0}
				<p class="muted archived-empty-hint py-9 px-5 text-center text-12 text-muted">{t.sidebar.archivedEmpty}</p>
			{:else}
				{#each archivedSessions as session (session.id)}
					{@const status = statusOf(session)}
					{@const unread = unreadOf(session)}
					<div class="row-flip" animate:flip={rowFlip()}>
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
							onPointerDown={pressOf(session)}
						/>
					</div>
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
					onPointerDown={pressOf(fileDrop)}
				/>
			{/if}
			{#if showBots && (!workingIds || groupRows.length > 0)}
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
				<div class="row-flip" animate:flip={rowFlip()}>
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
						onPointerDown={pressOf(session)}
						pinned={isSessionPinned(pinnedSessionIds, session.id)}
						onTogglePin={onTogglePin ? () => onTogglePin(session.id) : undefined}
					/>
				</div>
			{/each}
			{#if showBots && (!workingIds || youBotRows.length > 0)}
				<div class="ghead">
					<span>{t.sidebar.youBot}</span>
					<button type="button" class="add" title={t.sidebar.addBot} onclick={onCreateBot}>+</button>
				</div>
			{/if}
			{#each youBotRows as session (session.id)}
				{@const status = statusOf(session)}
				{@const unread = unreadOf(session)}
				<div class="row-flip" animate:flip={rowFlip()}>
					<SessionRow
						{session}
						{t}
						on={runtime.selectedId === session.id}
						contextOpen={contextMenuSessionId === session.id}
						title="{titleOf(session)}{archivedSuffix(session)}"
						time={timeOf(session)}
						{status}
						preview={previewOf(session) || t.sidebar.noMessages}
						elsewhere={elsewhereOf(session, status)}
						{unread}
						bots={botsById}
						botStatus={botStatusOf}
						onSelect={() => void runtime.selectSession(session.id)}
						onContextMenu={(e) => onOpenContextMenu(e, session)}
						onPointerDown={pressOf(session)}
						pinned={isSessionPinned(pinnedSessionIds, session.id)}
						onTogglePin={onTogglePin ? () => onTogglePin(session.id) : undefined}
					/>
				</div>
			{/each}
			{#if showProjects && (!workingIds || projectGroups.length > 0)}
				<div class="ghead">
					<span>{t.project.section}</span>
					<button
						bind:this={projectAddEl}
						type="button"
						class="add"
						title={t.project.add}
						aria-haspopup="menu"
						aria-expanded={projectMenuOpen}
						onclick={() => (projectMenuOpen = !projectMenuOpen)}
					>+</button>
				</div>
			{/if}
			<ProjectAddMenu
				{t}
				anchor={projectAddEl}
				bind:open={projectMenuOpen}
				label={t.project.add}
				picksFolder
				onNew={(agent) => void newProjectInFolder(runtime, t, agent)}
				onImport={() => runtime.openCreateProject('import')}
			/>
			<ProjectAddMenu
				{t}
				anchor={dirMenuFor?.anchor ?? null}
				point={dirMenuFor?.point ?? null}
				bind:open={dirMenuOpen}
				label={dirMenuFor ? t.project.newHere(dirMenuFor.label) : t.project.add}
				picksFolder={false}
				onNew={(agent) => {
					if (dirMenuFor) void newProjectIn(runtime, dirMenuFor.dir, agent);
				}}
				onOpenDir={onOpenProjectDir ? openDirOfMenu : undefined}
				onOpenTerminal={() => {
					if (dirMenuFor) void runtime.openTerminalAt(dirMenuFor.dir);
				}}
			/>
			{#each projectGroups as group (group.dir)}
				{@const open = dirOpen(group.dir)}
				{@const dirLive = group.sessions.some((row) => isLiveRun(snapshot.agentRuns[row.id]))}
				<div class="project-dir" data-project-dir={group.dir}>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="project-dir-row"
						oncontextmenu={(event) => {
							event.preventDefault();
							const anchor = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.project-dir-head');
							if (!anchor) return;
							dirMenuFor = { dir: group.dir, label: group.label, anchor, point: { x: event.clientX, y: event.clientY } };
							dirMenuOpen = true;
						}}
					>
						<button
							type="button"
							class="project-dir-head"
							title={group.dir}
							aria-expanded={open}
							aria-label={t.project.toggleDir(group.label)}
							onclick={() => toggleDir(group.dir)}
						>
							<Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
							<Icon name="folder" size={16} />
							<span class="project-dir-name">{group.label}</span>
							{#if !open && dirLive}<span class="project-dir-live" aria-hidden="true"></span>{/if}
						</button>
						<!-- A new session right here, as in the agents' own apps: the directory is already the answer; which agent is the one question left. -->
						<button
							type="button"
							class="project-dir-add"
							title={t.project.newHere(group.label)}
							aria-label={t.project.newHere(group.label)}
							aria-haspopup="menu"
							aria-expanded={dirMenuOpen && dirMenuFor?.dir === group.dir && !dirMenuFor.point}
							data-project-dir-add
							onclick={(event) => {
								const anchor = event.currentTarget as HTMLElement;
								const again = dirMenuOpen && dirMenuFor?.dir === group.dir && !dirMenuFor.point;
								dirMenuFor = { dir: group.dir, label: group.label, anchor };
								dirMenuOpen = !again;
							}}
						>
							<Icon name="plus" size={16} />
						</button>
					</div>
					{#if open}
						<div class="project-sessions">
							{#each group.sessions as session (session.id)}
								<ProjectSessionRow
									{t}
									on={runtime.selectedId === session.id}
									contextOpen={contextMenuSessionId === session.id}
									title={session.name || t.project.untitled}
									agent={projectAgentOf(session)}
									name={session.name}
									renaming={renamingSessionId === session.id}
									onRename={onRenameSession ? (name) => onRenameSession(session.id, name) : undefined}
									time={timeOf(session)}
									live={isLiveRun(snapshot.agentRuns[session.id])}
									unread={unreadOf(session)}
									onSelect={() => void runtime.selectSession(session.id)}
									onContextMenu={(e) => onOpenContextMenu(e, session)}
									onPointerDown={pressOf(session)}
								/>
							{/each}
						</div>
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
			{#if projectsEmpty}
				<EmptyState size="inline" level={3} title={t.project.emptyList} hint={t.project.emptyListHint}>
					{#each PROJECT_AGENTS as agent, index (agent)}
						<button type="button" class="roster-empty-btn" class:is-primary={index === 0} data-project-add="new" data-project-agent={agent} onclick={() => void newProjectInFolder(runtime, t, agent)}>{t.project.newWith(t.project.agentNames[agent])}…</button>
					{/each}
					<button type="button" class="roster-empty-btn" data-project-add="import" onclick={() => runtime.openCreateProject('import')}>{t.project.importSession}</button>
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
			roles: viewingRoles,
			terminal: !workbench && runtime.terminalOpen,
			screen: runtime.screenOpen,
			workspace: phone && runtime.workspaceOpen,
			archived: viewingArchived
		}}
		{onOpenRoutines}
		{onOpenSpend}
		onOpenUsage={() => {
			if (!phone) return runtime.openUsage();
			runtime.openListPage('usage');
		}}
		onOpenRoles={() => runtime.openRoles()}
		onOpenTerminal={() => (workbench ? onNewTerminal() : runtime.openTerminal())}
		onOpenScreen={runtime.screenOffered ? () => runtime.openRemoteScreen() : null}
		onOpenWorkspace={phone ? onToggleWorkspace : null}
		screenHost={runtime.screenHost}
		onOpenArchived={openArchived}
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
		<Icon name="sidebar-close" />
	</button>
{/snippet}

<!--
	Creating on a phone: one button that floats over the list rather than a + in each group header.
	The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	there are two of them saying the same kind of thing; this asks which once, where your thumb is.
-->
{#if phone && !selected && !searchOpen && !viewingArchived && !viewingUsage && !viewingRoles && !workspaceOpen && !runtime.settingsOpen && !runtime.routinesOpen && !runtime.spendOpen && !runtime.terminalOpen && !runtime.screenOpen}
	<CreateFab
		{t}
		bind:createMenuOpen
		bind:wrapEl={fabEl}
		onCreateBot={showBots ? onCreateBot : undefined}
		onCreateGroup={showBots ? onCreateGroup : undefined}
		onNewProject={showProjects ? () => void newProjectInFolder(runtime, t) : undefined}
		onImportProject={showProjects ? () => runtime.openCreateProject('import') : undefined}
	/>
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
		container: brand-row / inline-size;
	}

	/* On macOS the window's traffic lights take the start of the row (`window-chrome.ts`). */
	:global(:root[data-chrome='mac']) .brand-row {
		padding-left: 84px;
	}

	/*
	 * Behind the traffic lights, a list dragged near its narrowest has no room for the mark and its
	 * three buttons (22 + 3 × 30 + gaps = 136px past the lights' padding): the name has already
	 * gone, so the mark goes too.
	 */
	@container brand-row (max-width: 135px) {
		:global(:root[data-chrome='mac']) .brand-row > :global(.brand-mark) {
			display: none;
		}
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

	/* Beside the content card the shell's ground shows through (the window's material on macOS). */
	@media (min-width: 681px) {
		.side {
			background: transparent;
		}
	}

	/*
	 * Dark on a window with material (macOS, Windows 11) the ground lets most of the glass through
	 * (`--ground-tint` 20%), and the glass is lighter than the dark ground was: on macOS from about
	 * (33,40,49) to (70,76,80) when a light window is behind; Mica takes the desktop's colour. The
	 * quiet greys go up a step so a preview line keeps 4:1 at the bright end and the search icon
	 * stays legible.
	 */
	:global(:root[data-material='glass'][data-theme='dark']) .side {
		--muted: #a8b3b8;
		--muted-light: #8b989e;
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

	/* One row per directory, its sessions indented under it; its + starts one more there. */
	.project-dir-row {
		display: flex;
		align-items: center;
	}

	.project-dir-add {
		flex: none;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		margin-right: 6px;
		border-radius: var(--radius-sm);
		color: var(--muted);
	}

	.project-dir-add:hover {
		background: var(--line-subtle);
		color: var(--accent);
	}

	/* With a pointer it shows on the row it is over; a touch screen has no hover, so it stays. */
	@media (hover: hover) {
		.project-dir-add {
			opacity: 0;
		}

		.project-dir-row:hover .project-dir-add,
		.project-dir-add:focus-visible {
			opacity: 1;
		}
	}

	.project-dir-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		width: 100%;
		/* A press or a double press opens and folds it; it never selects its name. */
		user-select: none;
		-webkit-user-select: none;
		min-height: 32px;
		padding: 4px 10px;
		border-radius: var(--radius-md);
		color: var(--ink-secondary);
		font-size: 13px;
		font-weight: 600;
		text-align: left;
	}

	.project-dir-head:hover {
		background: var(--row-hover);
	}

	.project-dir-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A folded directory still says that something inside it is at work. */
	.project-dir-live {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}

	.project-sessions {
		padding-left: 14px;
	}

	@media (max-width: 680px) {
		.project-dir-head {
			min-height: 44px;
			padding-left: 14px;
		}

		.project-dir-add {
			width: 40px;
			height: 40px;
		}
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
		border-color: var(--field-focus-border);
		box-shadow: var(--field-focus-ring);
	}

	/* On the ground beside the content card the search is a tinted well, not a white field. */
	@media (min-width: 681px) {
		.search:not(:focus) {
			border-color: transparent;
			background: color-mix(in srgb, var(--ink) 5.5%, transparent);
			box-shadow: none;
		}

		.search-trigger:hover:not(:focus) {
			background: color-mix(in srgb, var(--ink) 8%, transparent);
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
		.ghead {
			padding: 12px 14px 4px;
		}

		/* Creating is the floating + now, so the headers are labels. */
		.ghead :global(.add) {
			display: none;
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
