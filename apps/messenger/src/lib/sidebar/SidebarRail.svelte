<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import BrandMark from '../BrandMark.svelte';
	import { dragRegion } from '../window-chrome.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { formatShortcut } from '../keymap.ts';
	import { searchShortcutLabel } from '../search/shortcuts.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import RailTooltip from './RailTooltip.svelte';
	import { groupSessions, isFileDropSession, isSessionArchived } from './session-groups.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { directElsewhere } from './bot-elsewhere.ts';
	import { sessionTitle } from './session-title.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import ToolsMenu from './ToolsMenu.svelte';
	import { usageWidget } from '../usage/usage-widget.svelte.ts';
	import { loadWorkingOnly, onlyWorking, saveWorkingOnly, workingOrUnreadIds } from './working-only.ts';

	/**
	 * The session list put away: every conversation it shows, as its avatar alone, in the same
	 * order and sections. Enough to see who is talking and to switch; names are in the tooltips.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		pinnedSessionIds: string[];
		/** Marks the avatar the context menu belongs to. */
		contextMenuSessionId: string | null;
		/** Escape closes the tools menu before anything else, so the shell holds it. */
		toolsMenuOpen?: boolean;
		workspaceOpen: boolean;
		onOpenContextMenu: (e: MouseEvent, session: SessionSummary) => void;
		onExpand: () => void;
		onToggleWorkspace: () => void;
		onOpenRoutines: () => void;
		onOpenSpend: () => void;
		/** Whether the workbench is on screen; a tablet on a remote connection folds its list without one. */
		workbench: boolean;
		onNewTerminal: () => void;
		/** The archived list is a view of the full list; this opens the list already on it. */
		onOpenArchived: () => void;
		onOpenSettings: () => void;
		/** The folded list has no search field; this opens the same search the field does. */
		onOpenSearch: () => void;
		/** A press on an avatar that may become a drag into the workbench: only where there is one. */
		onDragSession?: (event: PointerEvent, session: SessionSummary) => void;
	};

	let {
		runtime,
		t,
		pinnedSessionIds,
		contextMenuSessionId,
		toolsMenuOpen = $bindable(false),
		workspaceOpen,
		onOpenContextMenu,
		onExpand,
		onToggleWorkspace,
		onOpenRoutines,
		onOpenSpend,
		workbench,
		onNewTerminal,
		onOpenArchived,
		onOpenSettings,
		onOpenSearch,
		onDragSession
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
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

	/** The list's "working and unread" switch, the same stored one, so folding the list keeps its view. */
	let workingOnly = $state(loadWorkingOnly());
	function toggleWorkingOnly(): void {
		workingOnly = !workingOnly;
		saveWorkingOnly(workingOnly);
	}
	const workingIds = $derived(
		workingOnly
			? workingOrUnreadIds(snapshot.sessions, snapshot.turns, snapshot.approvals, snapshot.pendingJudgements)
			: null
	);
	const listed = $derived(onlyWorking(grouped, workingIds, runtime.selectedId));

	/**
	 * The list's sections, empty ones dropped so no two dividers meet. A Bot↔Bot direct is not one:
	 * it opens from the message it hangs under, in a popup (ADR 0091).
	 */
	const sections = $derived(
		[
			listed.pinned,
			listed.fileDrop ? [listed.fileDrop] : [],
			listed.groups,
			listed.youBot
		].filter((section) => section.length > 0)
	);

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
		return botWorkStatus(botId, snapshot.turns, snapshot.approvals, statusLabels, snapshot.pendingJudgements);
	}

	/*
	 * The list's footer, as icons: workspace, tools and settings in the same order, the names in
	 * the tooltips like everything else here. The tools menu is the list's own, flown out beside the
	 * rail so it covers none of these.
	 */
	const archivedCount = $derived(snapshot.sessions.filter((session) => isSessionArchived(session, botsById)).length);
	let toolsTip = $state<RailTooltip | null>(null);
	let toolsBtnEl = $state<HTMLButtonElement | null>(null);
	let toolsFocusLast = $state(false);

	// `bind:this` on the tip lands in an effect; the button inside it is there on the next one.
	$effect(() => {
		toolsBtnEl = toolsTip?.anchor() ?? null;
	});

	function onToolsKeyDown(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		toolsFocusLast = e.key === 'ArrowUp';
		toolsMenuOpen = true;
	}

	/** A control's tip: what it does, then the shortcut. The accessible name stays the function. */
	function shortcutTip(label: string, shortcut: string): string[] {
		return [label, shortcut];
	}

	/**
	 * The full title, then a short line of whatever the avatar already shows: what is waiting, or
	 * how many are unread. Idle and a clean badge say nothing more.
	 */
	function sessionTip(session: SessionSummary, title: string, status: ReturnType<typeof statusOf>, unread: number): string[] {
		const lines = [title];
		if (status.kind === 'waiting_approval' && status.count) {
			lines.push(`${status.label} ${status.count}`);
		} else if (status.kind !== 'idle') {
			lines.push(status.label);
		} else {
			// Your direct, quiet here while its Bot's face says it is busy: where it is.
			const elsewhere = directElsewhere(session, false, snapshot, botsById, statusLabels, rosterLabels, t.sidebar.elsewhere);
			if (elsewhere) lines.push(elsewhere);
		}
		if (unread > 0) lines.push(`${t.sidebar.unread} ${unread}`);
		return lines;
	}

	const searchShortcut = $derived(searchShortcutLabel());
	const workspaceSet = $derived(Boolean(snapshot.settings.workspace_path));
	const settingsTip = $derived(
		updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings
	);
</script>

<nav class="rail" aria-label={t.sidebar.sessions} data-tauri-drag-region={dragRegion}>
	<span class="rail-brand"><BrandMark size={26} /></span>
	<RailTooltip
		class="rail-action rail-expand"
		label={shortcutTip(t.sidebar.show, formatShortcut(['mod', 'B']))}
		describedBy="rail-tip-expand"
		aria-expanded="false"
		onclick={onExpand}
	>
		<Icon name="sidebar-open" />
	</RailTooltip>
	<RailTooltip
		class="rail-action rail-search"
		label={shortcutTip(t.sidebar.searchShort, searchShortcut)}
		describedBy="rail-tip-search"
		onclick={onOpenSearch}
	>
		<Icon name="search" />
	</RailTooltip>
	<RailTooltip
		class="rail-action rail-working {workingOnly ? 'is-active' : ''}"
		label={[workingOnly ? t.sidebar.workingOnlyOff : t.sidebar.workingOnly]}
		name={t.sidebar.workingOnly}
		describedBy="rail-tip-working"
		aria-pressed={workingOnly}
		onclick={toggleWorkingOnly}
	>
		<Icon name="activity" />
	</RailTooltip>
	<!-- It fills the rail below the actions, so its empty space is what moves the window. -->
	<div class="rail-list" data-tauri-drag-region={dragRegion}>
		{#each sections as section, index (index)}
			{#if index > 0}
				<div class="rail-divider" role="separator"></div>
			{/if}
			{#each section as session (session.id)}
				{@const title = sessionTitle(session, botsById, rosterLabels)}
				{@const status = statusOf(session)}
				{@const unread = sessionUnreadCount(session)}
				<RailTooltip
					class="rail-item {runtime.selectedId === session.id ? 'is-on' : ''} {contextMenuSessionId === session.id ? 'is-context-open' : ''}"
					label={sessionTip(session, title, status, unread)}
					name={unread > 0 ? `${title} · ${t.sidebar.unread} ${unread}` : title}
					describedBy="rail-tip-{session.id}"
					data-session={session.id}
					aria-current={runtime.selectedId === session.id ? 'true' : undefined}
					onclick={() => void runtime.selectSession(session.id)}
					oncontextmenu={(e) => onOpenContextMenu(e, session)}
					onpointerdown={onDragSession ? (e: PointerEvent) => onDragSession(e, session) : undefined}
				>
					{#if isFileDropSession(session)}
						<span class="row-avatar size-md" aria-hidden="true">
							<span class="row-avatar-bot rail-file-drop">
								<Icon name="file-down" />
							</span>
						</span>
					{:else}
						<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
					{/if}
					<!-- What waits on you comes before what is merely unread, as in the pinned row. -->
					{#if status.count}
						<span class="rail-badge is-waiting" aria-hidden="true">{status.count}</span>
					{:else if unread > 0}
						<span class="rail-badge" aria-hidden="true">{unreadBadge(unread)}</span>
					{/if}
				</RailTooltip>
			{/each}
		{/each}
	</div>
	<div class="rail-foot">
		<RailTooltip
			class="rail-action rail-workspace {workspaceOpen ? 'is-active' : ''}"
			label={workspaceSet ? shortcutTip(t.sidebar.workspace, formatShortcut(['mod', 'O'])) : [t.sidebar.workspace, t.sidebar.workspaceUnset]}
			name={t.sidebar.workspace}
			describedBy="rail-tip-workspace"
			enabled={workspaceSet}
			aria-expanded={workspaceOpen}
			onclick={onToggleWorkspace}
		>
			<Icon name="folder" />
		</RailTooltip>
		<RailTooltip
			bind:this={toolsTip}
			class="rail-action rail-tools {toolsMenuOpen ? 'is-active' : ''}"
			label={[t.sidebar.tools]}
			describedBy="rail-tip-tools"
			aria-haspopup="menu"
			aria-expanded={toolsMenuOpen}
			aria-controls={toolsMenuOpen ? 'sidebar-tools-menu' : undefined}
			onkeydown={onToolsKeyDown}
			onclick={() => (toolsMenuOpen = !toolsMenuOpen)}
		>
			<Icon name="grid" />
		</RailTooltip>
		<RailTooltip
			class="rail-action rail-settings {runtime.settingsOpen ? 'is-active' : ''}"
			label={[settingsTip]}
			describedBy="rail-tip-settings"
			onclick={onOpenSettings}
		>
			<Icon name="settings" />
			{#if updateChecker.updateVisible}
				<span class="rail-update-dot" aria-hidden="true"></span>
			{/if}
		</RailTooltip>
	</div>
</nav>

<ToolsMenu
	{t}
	locale={snapshot.settings.locale === 'en' ? 'en' : 'zh'}
	phone={false}
	pages={!workbench}
	anchor={toolsBtnEl}
	bind:open={toolsMenuOpen}
	bind:focusLast={toolsFocusLast}
	placement="flyout"
	{archivedCount}
	current={{
		routines: !workbench && runtime.routinesOpen,
		spend: !workbench && runtime.spendOpen,
		usage: !workbench && usageWidget.open,
		terminal: !workbench && runtime.terminalOpen
	}}
	{onOpenRoutines}
	{onOpenSpend}
	onOpenUsage={() => runtime.openUsage()}
	onOpenRoles={() => runtime.openRoles()}
	onOpenTerminal={() => (workbench ? onNewTerminal() : runtime.openTerminal())}
	{onOpenArchived}
/>

<style>
	/*
	 * The rail fills its column, which is wider than the rail for the moment the list is closing;
	 * everything in it keeps to the left 64px, so the avatars land where they are going to stay.
	 */
	.rail {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--sidebar-bg);
		border-right: 1px solid var(--line);
		user-select: none;
	}

	/* Beside the content card the rail is part of the ground, with no edge of its own. */
	@media (min-width: 681px) {
		.rail {
			background: transparent;
			border-right: 0;
		}
	}

	/*
	 * On macOS the traffic lights sit at the top of the rail (`window-chrome.ts`), which is 12px
	 * wider there to hold them; the mark gives them its place.
	 */
	:global(:root[data-chrome='mac']) .rail {
		padding: 40px 0 0 6px;
	}

	:global(:root[data-chrome='mac']) .rail-brand {
		display: none;
	}

	.rail-list {
		flex: 1 1 auto;
		min-height: 0;
		width: 64px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 4px 0 8px;
		overflow-y: auto;
		scrollbar-width: none;
	}

	.rail-list::-webkit-scrollbar {
		display: none;
	}

	.rail :global(.rail-action) {
		position: relative;
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 36px;
		margin: 0 12px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease;
	}

	/* The mark heads the folded list too, where the full one shows it beside the name. */
	.rail-brand {
		width: 64px;
		display: flex;
		justify-content: center;
		padding-top: 12px;
		flex-shrink: 0;
	}

	.rail :global(.rail-expand) {
		margin-top: 8px;
		margin-bottom: 4px;
	}

	.rail-foot {
		flex: 0 0 auto;
		width: 64px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 6px 0 8px;
		border-top: 1px solid var(--line);
	}

	.rail-foot :global(.rail-action) {
		margin: 0;
	}

	.rail :global(.rail-action[aria-disabled='true']:hover) {
		border-color: transparent;
		color: var(--muted);
	}

	.rail :global(.rail-action:hover) {
		border-color: var(--line);
		color: var(--ink);
	}

	.rail :global(.rail-action.is-active) {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.rail-update-dot {
		position: absolute;
		top: 5px;
		right: 7px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		/* An update is news, not an error: the same dot as the full sidebar's. */
		background: var(--accent);
	}

	.rail-divider {
		flex: 0 0 auto;
		width: 28px;
		height: 1px;
		margin: 3px 0;
		background: var(--line);
	}

	.rail :global(.rail-item) {
		position: relative;
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.rail :global(.rail-item .row-avatar) {
		--avatar-ring: var(--sidebar-bg);
	}

	@media (min-width: 681px) {
		.rail :global(.rail-item .row-avatar) {
			--avatar-ring: var(--ground);
		}
	}

	.rail :global(.rail-item:hover) {
		background: var(--row-hover);
	}

	.rail :global(.rail-item:hover .row-avatar) {
		--avatar-ring: var(--row-hover);
	}

	.rail :global(.rail-item.is-on),
	.rail :global(.rail-item.is-context-open) {
		background: var(--accent-tint);
		border-color: transparent;
	}

	.rail :global(.rail-item.is-on .row-avatar),
	.rail :global(.rail-item.is-context-open .row-avatar) {
		--avatar-ring: var(--accent-tint);
	}

	.rail-file-drop {
		background: var(--accent-tint);
		color: var(--accent);
		border-color: transparent;
	}

	.rail-badge {
		position: absolute;
		top: 1px;
		right: 1px;
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
		z-index: 3;
	}

	.rail-badge.is-waiting {
		background: var(--warn);
		color: var(--on-warn);
	}
</style>
