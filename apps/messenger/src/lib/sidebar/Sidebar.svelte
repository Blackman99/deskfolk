<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import CreateGroupSheet from './CreateGroupSheet.svelte';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc } from '../avatar.ts';
	import { botAvatarColor } from '../chat/chat-view.ts';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { isSessionPinned } from './pinned-sessions.ts';
	import { rosterLetter } from './roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { scrollTopToRevealRect } from '../chat/mention-popup.ts';
	import { searchHitView, searchJump } from './search-jump.ts';
	import { groupSessions, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { sessionTitle } from './session-title.ts';
	import { themeManager } from '../theme.ts';
	import { latestPreview } from '../chat/transcript.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import { updateChecker } from '../update-checker.svelte.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		pinnedSessionIds: string[];
		/** The shell's Escape cascade closes this before anything else. */
		themeMenuOpen: boolean;
		workspaceOpen: boolean;
		/** Marks the row the context menu belongs to. */
		contextMenuSessionId: string | null;
		onOpenContextMenu: (e: MouseEvent, session: SessionSummary) => void;
		onToggleWorkspace: () => void;
		onOpenSettings: () => void;
		onCreateBot: () => void;
		onCreateGroup: () => void;
		onOpenArtifact: (path: string) => void;
		onPatchTheme: (theme: 'system' | 'light' | 'dark') => Promise<boolean>;
	};

	let {
		runtime,
		t,
		selected,
		pinnedSessionIds,
		themeMenuOpen = $bindable(false),
		workspaceOpen,
		contextMenuSessionId,
		onOpenContextMenu,
		onToggleWorkspace,
		onOpenSettings,
		onCreateBot,
		onCreateGroup,
		onOpenArtifact,
		onPatchTheme
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const aliveBotIds = $derived(new Set(snapshot.bots.map((b) => b.id)));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		idle: t.sidebar.statusIdle
	});
	const searchKindLabels = $derived({
		bot: t.sidebar.searchKindBot,
		session: t.sidebar.searchKindSession,
		message: t.sidebar.searchKindMessage,
		routine: t.sidebar.searchKindRoutine,
		file: t.sidebar.searchKindFile
	});

	const grouped = $derived(groupSessions(snapshot.sessions, pinnedSessionIds, aliveBotIds, botsById));
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

	let searchFocused = $state(false);
	let searchHighlightIndex = $state(-1);
	let searchWrapEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let searchDropEl = $state<HTMLElement | null>(null);

	let themeMenuEl = $state<HTMLElement | null>(null);
	let themeToggleBtnEl = $state<HTMLButtonElement | null>(null);
	let themePreference = $state(themeManager.preference);
	const currentTheme = $derived(snapshot.settings.theme || themePreference);

	$effect(() => {
		void runtime.searchHits;
		searchHighlightIndex = -1;
	});

	$effect(() => themeManager.subscribe(() => (themePreference = themeManager.preference)));

	$effect(() => {
		if (themeMenuOpen && themeMenuEl) {
			const activeItem =
				themeMenuEl.querySelector<HTMLButtonElement>('.theme-menu-item.is-selected') ??
				themeMenuEl.querySelector<HTMLButtonElement>('.theme-menu-item');
			activeItem?.focus();
		}
	});

	/** Two popups that close on a click elsewhere. Escape order is the shell's; this is not. */
	function onWindowClick(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (themeMenuOpen && isOutside(target, themeMenuEl, themeToggleBtnEl)) {
			themeMenuOpen = false;
		}
		if (searchFocused && isOutside(target, searchWrapEl)) {
			searchFocused = false;
		}
	}

	/**
	 * The theme is applied at once so the menu feels immediate, but the failure flag it sets lives
	 * in the settings modal. If the save does not land, put the applied theme back rather than
	 * leave the sidebar showing something the daemon never accepted.
	 */
	async function selectTheme(theme: 'system' | 'light' | 'dark'): Promise<void> {
		const previous = snapshot.settings.theme || themeManager.preference;
		themeManager.setTheme(theme);
		themeMenuOpen = false;
		const ok = await onPatchTheme(theme);
		if (!ok) themeManager.setTheme(previous);
	}

	function onThemeMenuKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			themeMenuOpen = false;
			themeToggleBtnEl?.focus();
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!themeMenuEl) return;
			const items = Array.from(themeMenuEl.querySelectorAll<HTMLButtonElement>('.theme-menu-item'));
			const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
			let nextIndex = 0;
			if (e.key === 'ArrowDown') {
				nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
			} else {
				nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1;
			}
			items[nextIndex]?.focus();
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
			snapshot.pendingJudgements
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

	function unreadOf(session: SessionSummary): number {
		return sessionUnreadCount(session, runtime.selectedId);
	}

	function previewOf(session: SessionSummary): string {
		return latestPreview(snapshot.messages, session.id, session, snapshot.turns);
	}

	function archivedSuffix(session: SessionSummary): string {
		if (session.archived_at) return ` · ${t.top.archived}`;
		const peer = youBotPeer(session);
		if (!peer) return '';
		return botsById.get(peer)?.archived_at ? ` · ${t.top.archived}` : '';
	}

	function onSearchInput(ev: Event): void {
		searchHighlightIndex = -1;
		void runtime.runSearch((ev.currentTarget as HTMLInputElement).value);
	}

	function scrollSearchHighlightIntoView(index = searchHighlightIndex): void {
		const drop = searchDropEl;
		if (!drop) return;
		const item = drop.querySelectorAll<HTMLElement>('.search-hit')[index];
		if (!item) return;
		const dropRect = drop.getBoundingClientRect();
		const itemRect = item.getBoundingClientRect();
		drop.scrollTop = scrollTopToRevealRect(
			drop.scrollTop,
			dropRect.top,
			dropRect.bottom,
			itemRect.top,
			itemRect.bottom
		);
	}

	function onSearchKeyDown(e: KeyboardEvent): void {
		if (e.isComposing) return;
		if (e.key === 'Escape') {
			searchFocused = false;
			searchHighlightIndex = -1;
			searchInputEl?.blur();
			return;
		}
		if (!searchFocused || !runtime.searchQuery.trim() || runtime.searchHits.length === 0) {
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const count = runtime.searchHits.length;
			searchHighlightIndex = searchHighlightIndex < count - 1 ? searchHighlightIndex + 1 : 0;
			scrollSearchHighlightIntoView(searchHighlightIndex);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			const count = runtime.searchHits.length;
			searchHighlightIndex = searchHighlightIndex > 0 ? searchHighlightIndex - 1 : count - 1;
			scrollSearchHighlightIntoView(searchHighlightIndex);
			return;
		}
		if (e.key === 'Enter') {
			const targetIndex = searchHighlightIndex >= 0 ? searchHighlightIndex : 0;
			const hit = runtime.searchHits[targetIndex];
			if (hit) {
				e.preventDefault();
				onHit(hit);
			}
			return;
		}
	}

	function onHit(hit: (typeof runtime.searchHits)[number]): void {
		searchFocused = false;
		searchHighlightIndex = -1;
		searchInputEl?.blur();
		if (hit.kind === 'file' && hit.path) {
			runtime.closeSearch();
			onOpenArtifact(hit.path);
			return;
		}
		const jump = searchJump(hit, snapshot.sessions);
		if (!jump) return;
		runtime.closeSearch();
		void runtime.selectSession(jump.sessionId, { messageId: jump.messageId });
	}
</script>

<svelte:window onclick={onWindowClick} />

<aside class="side">
	<div class="roster-panel">
		<div class="roster" class:is-expanded={pinnedExpanded} title={t.sidebar.pinned}>
			{#if pinnedSessions.length === 0}
				<span class="roster-empty-hint">{t.sidebar.pinnedEmpty}</span>
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
						<span class="pinned-avatar-wrap">
							<SessionAvatar session={pSession} bots={botsById} botStatus={botStatusOf} />
							{#if pStatus.count}
								<span class="pinned-badge">{pStatus.count}</span>
							{:else if pUnread > 0}
								<span class="pinned-unread" title={t.sidebar.unread}>{unreadBadge(pUnread)}</span>
							{/if}
						</span>
						<span class="pinned-session-name">{titleOf(pSession)}</span>
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
	<div class="side-body">
	<div class="search-wrap" bind:this={searchWrapEl}>
		<span class="search-icon-badge" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="11" cy="11" r="8"></circle>
				<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
			</svg>
		</span>
		<input
			bind:this={searchInputEl}
			class="search"
			placeholder={t.sidebar.search}
			value={runtime.searchQuery}
			role="combobox"
			aria-expanded={searchFocused && Boolean(runtime.searchQuery.trim())}
			aria-controls="search-dropdown-list"
			aria-activedescendant={searchHighlightIndex >= 0 ? `search-hit-${searchHighlightIndex}` : undefined}
			oninput={onSearchInput}
			onfocus={() => {
				searchFocused = true;
			}}
			onblur={(e) => {
				const next = e.relatedTarget as Node | null;
				if (searchWrapEl && next && searchWrapEl.contains(next)) {
					return;
				}
				searchFocused = false;
				searchHighlightIndex = -1;
			}}
			onkeydown={onSearchKeyDown}
		/>
		{#if runtime.searchQuery.trim()}
			<button
				type="button"
				class="search-clear"
				title="清除"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => {
					void runtime.runSearch('');
					searchFocused = true;
					searchHighlightIndex = -1;
					searchInputEl?.focus();
				}}
			>✕</button>
		{/if}
		{#if searchFocused && runtime.searchQuery.trim()}
			<div
				bind:this={searchDropEl}
				id="search-dropdown-list"
				class="search-drop"
				role="listbox"
				tabindex="-1"
				onmousedown={(e) => {
					e.preventDefault();
				}}
			>
				{#if runtime.searchHits.length === 0}
					<p class="muted">{t.sidebar.emptySearch}</p>
				{:else}
					{#each runtime.searchHits as hit, i (hit.id ?? hit.path ?? i)}
						{@const view = searchHitView(hit, searchKindLabels)}
						<button
							type="button"
							id={`search-hit-${i}`}
							class="search-hit"
							class:is-highlighted={searchHighlightIndex === i}
							class:is-selected={searchHighlightIndex === i}
							role="option"
							aria-selected={searchHighlightIndex === i}
							title={view.sessionTitle ? `${view.kindLabel} · ${view.sessionTitle}` : view.kindLabel}
							onmouseenter={() => {
								searchHighlightIndex = i;
							}}
							onclick={() => onHit(hit)}
						>
							{#if hit.kind === 'bot'}
								{@const bot = hit.id ? botsById.get(hit.id) : null}
								{@const botName = bot?.name ?? hit.snippet ?? ''}
								{@const pal = botAvatarColor(hit.id ?? botName)}
								{@const src = avatarSrc(bot?.avatar ?? hit.avatar)}
								<span class="row-avatar size-sm search-hit-avatar" aria-hidden="true">
									<span
										class="row-avatar-bot"
										style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
										title={botName}
									>
										{#if src}
											<img src={src} alt={botName} class="avatar-img" />
										{:else}
											{botName ? rosterLetter(botName) : '?'}
										{/if}
									</span>
								</span>
							{:else if hit.kind === 'session'}
								{@const session = hit.id ? sessionsById.get(hit.id) : null}
								{#if session}
									<SessionAvatar {session} bots={botsById} size="sm" class="search-hit-avatar" />
								{:else}
									<span class="row-avatar size-sm is-group layout-empty search-hit-avatar" aria-hidden="true">
										<span class="row-avatar-bot is-empty">
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
												<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
												<circle cx="9" cy="7" r="4" />
												<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
											</svg>
										</span>
									</span>
								{/if}
							{/if}
							<span class="search-hit-body">
								<span class="search-hit-meta">
									<span class="search-hit-kind">{view.kindLabel}</span>
									{#if view.sessionTitle}
										<span class="search-hit-session">{view.sessionTitle}</span>
									{/if}
								</span>
								{#if view.snippet && view.snippet !== view.sessionTitle}
									<span class="search-hit-snippet">{view.snippet}</span>
								{/if}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
	<div class="groups">
		{#if viewingArchived}
			<div class="ghead archived-ghead">
				<span>{t.sidebar.archivedSessions}</span>
				<button type="button" class="btn-back-sessions" onclick={() => (viewingArchived = false)}>
					{t.sidebar.backToSessions}
				</button>
			</div>
			{#if archivedSessions.length === 0}
				<p class="muted archived-empty-hint">{t.sidebar.archivedEmpty}</p>
			{:else}
				{#each archivedSessions as session (session.id)}
					{@const status = statusOf(session)}
					{@const unread = unreadOf(session)}
					<button
						type="button"
						class="row is-archived-row"
						class:is-on={runtime.selectedId === session.id}
						class:is-context-open={contextMenuSessionId === session.id}
						class:is-unread={unread > 0}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => onOpenContextMenu(e, session)}
					>
						<SessionAvatar {session} bots={botsById} botStatus={botStatusOf} />
						<span class="t">{titleOf(session)}{archivedSuffix(session)}</span>
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
			<div class="ghead">{t.sidebar.botBot}</div>
			{#each grouped.botBot as session (session.id)}
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
	</div>
	</div>
	<div class="foot">
		<div class="foot-left">
			<button
				type="button"
				class="foot-icon-btn"
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
			</button>
			<button
				type="button"
				class="foot-icon-btn"
				class:is-active={viewingArchived}
				title={t.sidebar.archivedSessions}
				aria-label={t.sidebar.archivedSessions}
				onclick={() => (viewingArchived = !viewingArchived)}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="21 8 21 21 3 21 3 8"></polyline>
					<rect x="1" y="3" width="22" height="5"></rect>
					<line x1="10" y1="12" x2="14" y2="12"></line>
				</svg>
				{#if archivedSessions.length > 0}
					<span class="foot-badge">{archivedSessions.length}</span>
				{/if}
			</button>
		</div>
		<div class="foot-right">
			<div class="theme-menu-wrap">
			<button
				bind:this={themeToggleBtnEl}
				type="button"
				class="foot-icon-btn theme-toggle-btn"
				class:is-active={themeMenuOpen}
				title="{t.settings.theme}: {currentTheme === 'system' ? t.settings.themeSystem : (currentTheme === 'dark' ? t.settings.themeDark : t.settings.themeLight)}"
				aria-label={t.settings.theme}
				aria-haspopup="menu"
				aria-expanded={themeMenuOpen}
				onclick={() => {
					themeMenuOpen = !themeMenuOpen;
				}}
			>
				{#if currentTheme === 'system'}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
						<line x1="8" y1="21" x2="16" y2="21"></line>
						<line x1="12" y1="17" x2="12" y2="21"></line>
					</svg>
				{:else if currentTheme === 'dark'}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
					</svg>
				{:else}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="5"></circle>
						<line x1="12" y1="1" x2="12" y2="3"></line>
						<line x1="12" y1="21" x2="12" y2="23"></line>
						<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
						<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
						<line x1="1" y1="12" x2="3" y2="12"></line>
						<line x1="21" y1="12" x2="23" y2="12"></line>
						<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
						<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
					</svg>
				{/if}
			</button>
			{#if themeMenuOpen}
				<div
					bind:this={themeMenuEl}
					class="theme-menu"
					role="menu"
					aria-label={t.settings.theme}
					tabindex="-1"
					onkeydown={onThemeMenuKeyDown}
				>
					<button
						type="button"
						class="theme-menu-item"
						class:is-selected={currentTheme === 'system'}
						role="menuitem"
						onclick={() => void selectTheme('system')}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
							<line x1="8" y1="21" x2="16" y2="21"></line>
							<line x1="12" y1="17" x2="12" y2="21"></line>
						</svg>
						<span class="theme-menu-label">{t.settings.themeSystem}</span>
						{#if currentTheme === 'system'}
							<svg class="theme-menu-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
						{/if}
					</button>
					<button
						type="button"
						class="theme-menu-item"
						class:is-selected={currentTheme === 'light'}
						role="menuitem"
						onclick={() => void selectTheme('light')}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="5"></circle>
							<line x1="12" y1="1" x2="12" y2="3"></line>
							<line x1="12" y1="21" x2="12" y2="23"></line>
							<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
							<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
							<line x1="1" y1="12" x2="3" y2="12"></line>
							<line x1="21" y1="12" x2="23" y2="12"></line>
							<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
							<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
						</svg>
						<span class="theme-menu-label">{t.settings.themeLight}</span>
						{#if currentTheme === 'light'}
							<svg class="theme-menu-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
						{/if}
					</button>
					<button
						type="button"
						class="theme-menu-item"
						class:is-selected={currentTheme === 'dark'}
						role="menuitem"
						onclick={() => void selectTheme('dark')}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
						</svg>
						<span class="theme-menu-label">{t.settings.themeDark}</span>
						{#if currentTheme === 'dark'}
							<svg class="theme-menu-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="20 6 9 17 4 12"></polyline>
							</svg>
						{/if}
					</button>
				</div>
			{/if}
		</div>
			<button
				type="button"
				class="foot-icon-btn"
				class:is-active={runtime.settingsOpen}
				title={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
				aria-label={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
				onclick={onOpenSettings}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="3"></circle>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
				</svg>
				{#if updateChecker.updateVisible}
					<span class="foot-badge is-dot" aria-hidden="true"></span>
				{/if}
			</button>
		</div>
	</div>
	{#if runtime.createGroupOpen}
		<CreateGroupSheet
			{runtime}
			bots={visibleBots}
			{t}
			onClose={() => (runtime.createGroupOpen = false)}
		/>
	{/if}
</aside>

<style>
	.pinned-session-btn.is-context-open {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}
</style>
