<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { isSessionPinned } from './pinned-sessions.ts';
	import { rosterLetter } from './roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { scrollTopToRevealRect } from '../chat/mention-popup.ts';
	import { searchHitView, searchJump } from './search-jump.ts';
	import { groupSessions, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { BOT_DM_VISIBLE, recentBotDms, resolveBotDmOrigin } from './bot-dm-source.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { sessionTitle } from './session-title.ts';
	import { themeManager } from '../theme.ts';
	import { latestPreview } from '../chat/transcript.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import { formatListTime, listTimeSource } from './list-time.ts';
	import { plainPreview } from './preview-text.ts';
	import { updateChecker } from '../update-checker.svelte.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		pinnedSessionIds: string[];
		/** The shell's Escape cascade closes this before anything else. */
		themeMenuOpen: boolean;
		/** Searching on a phone is a screen of its own; the shell's Back has to close it. */
		searchPageOpen?: boolean;
		/** What the phone's + button opens. A menu, so Back and Escape close it first. */
		createMenuOpen?: boolean;
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
		searchPageOpen = $bindable(false),
		createMenuOpen = $bindable(false),
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

	let searchFocused = $state(false);
	let searchHighlightIndex = $state(-1);
	let searchWrapEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let searchDropEl = $state<HTMLElement | null>(null);
	let searchPageInputEl = $state<HTMLInputElement | null>(null);

	/**
	 * A phone searches on a page of its own. A dropdown hanging under a field this narrow is a
	 * desktop idea: the keyboard covers the hits, two lines of snippet do not fit, and the list
	 * underneath stays half visible as if it were still the thing you were looking at. The width
	 * test matches the stylesheet's breakpoint.
	 */
	let phone = $state(false);
	$effect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const query = window.matchMedia('(max-width: 680px)');
		const apply = () => {
			phone = query.matches;
			// A window that grew back has the dropdown again, so the page has nothing left to be.
			if (!query.matches) searchPageOpen = false;
		};
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	/** Both ways of searching drive the same hits, so they share the keyboard handling. */
	const searchActive = $derived(searchFocused || searchPageOpen);

	$effect(() => {
		// The page exists to be typed into, so it opens with the caret already in the field.
		if (searchPageOpen && searchPageInputEl) searchPageInputEl.focus();
	});

	let fabEl = $state<HTMLElement | null>(null);

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
		if (createMenuOpen && isOutside(target, fabEl)) {
			createMenuOpen = false;
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
		if (session.archived_at) return ` · ${t.top.archived}`;
		const peer = youBotPeer(session);
		if (!peer) return '';
		return botsById.get(peer)?.archived_at ? ` · ${t.top.archived}` : '';
	}

	function openSearchPage(): void {
		searchHighlightIndex = -1;
		searchPageOpen = true;
	}

	/**
	 * Leaving the page clears the field. A page is somewhere you go and come back from, and a
	 * search you have walked out of is over — keeping the words would mean the next tap on the
	 * field reopens someone else's question. Answers whether there was a page to leave, so the
	 * shell's Back knows it was handled here.
	 */
	export function closeSearchPage(): boolean {
		if (!searchPageOpen) return false;
		searchPageOpen = false;
		searchFocused = false;
		searchHighlightIndex = -1;
		runtime.closeSearch();
		return true;
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
			if (closeSearchPage()) return;
			searchFocused = false;
			searchHighlightIndex = -1;
			searchInputEl?.blur();
			return;
		}
		if (!searchActive || !runtime.searchQuery.trim() || runtime.searchHits.length === 0) {
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
		// Where this hit leads is read before anything is cleared: closing the search empties the
		// list, and the row this came from is gone with it.
		const jump = searchJump(hit, snapshot.sessions, snapshot.routines, snapshot.bots);
		const filePath = hit.kind === 'file' ? hit.path : null;
		if (hit.kind === 'routine' && !jump) {
			searchFocused = true;
			searchInputEl?.focus();
			return;
		}
		searchFocused = false;
		searchHighlightIndex = -1;
		searchInputEl?.blur();
		// A hit ends the search whichever way it was made: the page goes with it.
		closeSearchPage();
		if (filePath) {
			runtime.closeSearch();
			onOpenArtifact(filePath);
			return;
		}
		if (!jump) return;
		runtime.closeSearch();
		if ('routineId' in jump) runtime.openRoutine(jump.botId, jump.routineId);
		else void runtime.selectSession(jump.sessionId, { messageId: jump.messageId });
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

{#snippet hitList()}
		{#if runtime.searchHits.length === 0}
			<p class="muted">{t.sidebar.emptySearch}</p>
		{:else}
			{#each runtime.searchHits as hit, i (hit.id ?? hit.path ?? i)}
				{@const view = searchHitView(hit, searchKindLabels)}
				{@const unavailable = hit.kind === 'routine' && !searchJump(hit, snapshot.sessions, snapshot.routines, snapshot.bots)}
				<button
					type="button"
					id={`search-hit-${i}`}
					class="search-hit"
					class:is-highlighted={searchHighlightIndex === i}
					class:is-selected={searchHighlightIndex === i}
					role="option"
					aria-selected={searchHighlightIndex === i}
					aria-disabled={unavailable}
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
					<span class="search-hit-body flex flex-col items-stretch gap-[3px] min-w-0 flex-1">
						<span class="search-hit-meta flex items-center gap-3 min-w-0">
							<span class="search-hit-kind shrink-0 text-10 font-bold tracking-[0.04em] text-muted">{view.kindLabel}</span>
							{#if view.sessionTitle}
								<span class="search-hit-session">{view.sessionTitle}</span>
							{/if}
						</span>
						{#if unavailable}<span class="search-unavailable">{t.sidebar.routineUnavailable}</span>{/if}
						{#if view.snippet && view.snippet !== view.sessionTitle}
							<span class="search-hit-snippet">{view.snippet}</span>
						{/if}
					</span>
				</button>
			{/each}
		{/if}
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
							<SessionAvatar session={pSession} bots={botsById} botStatus={botStatusOf} />
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
	<div class="search-wrap relative mt-5 mx-6 mb-3" bind:this={searchWrapEl}>
		{@render searchGlyph()}
		{#if phone}
			<!-- Looks like the field it replaces, so the list still reads as having a search box. -->
			<button type="button" class="search search-trigger" onclick={openSearchPage}>
				{t.sidebar.searchShort}
			</button>
		{:else}
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
					title={t.sidebar.searchClear}
					aria-label={t.sidebar.searchClear}
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
					{@render hitList()}
				</div>
			{/if}
		{/if}
	</div>
	<div class="mobile-session-tools" class:is-archived={viewingArchived}>
		<span>{viewingArchived ? t.sidebar.archivedSessions : t.sidebar.sessions}</span>
		<button type="button" aria-pressed={viewingArchived} onclick={() => (viewingArchived = !viewingArchived)}>
			{viewingArchived ? t.sidebar.backToSessions : t.sidebar.archivedSessions}
			{#if !viewingArchived && archivedSessions.length > 0}<span class="archive-count">{archivedSessions.length}</span>{/if}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
		</button>
	</div>
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
			<div class="theme-menu-wrap relative inline-flex">
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
</aside>

<!--
	Creating on a phone: one button that floats over the list rather than a + in each group header.
	The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	there are two of them saying the same kind of thing; this asks which once, where your thumb is.
-->
{#if phone && !selected && !searchPageOpen && !viewingArchived && !workspaceOpen && !runtime.settingsOpen}
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

<!--
	Search as a screen: the field in the header, the hits filling the rest, and the way back where
	every other phone page keeps it. It arrives and leaves by the same slide as the other pages.
-->
{#if searchPageOpen}
	<div class="search-page" transition:pageSlide>
		<div class="search-page-head">
			<button
				type="button"
				class="search-page-back"
				aria-label={t.sidebar.backToSessions}
				onclick={() => closeSearchPage()}
			>
				<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<div class="search-page-field">
				{@render searchGlyph()}
				<input
					bind:this={searchPageInputEl}
					class="search"
					placeholder={t.sidebar.search}
					aria-label={t.sidebar.searchShort}
					value={runtime.searchQuery}
					enterkeyhint="search"
					autocapitalize="off"
					autocomplete="off"
					spellcheck="false"
					oninput={onSearchInput}
					onkeydown={onSearchKeyDown}
				/>
				{#if runtime.searchQuery.trim()}
					<button
						type="button"
						class="search-clear"
						title={t.sidebar.searchClear}
						aria-label={t.sidebar.searchClear}
						onclick={() => {
							void runtime.runSearch('');
							searchHighlightIndex = -1;
							searchPageInputEl?.focus();
						}}
					>✕</button>
				{/if}
			</div>
		</div>
		{#if runtime.searchQuery.trim()}
			<div
				bind:this={searchDropEl}
				class="search-drop is-page"
				role="listbox"
				aria-label={t.sidebar.searchShort}
				tabindex="-1"
			>
				{@render hitList()}
			</div>
		{/if}
	</div>
{/if}

<style>
	.mobile-session-tools { display: none; }
	@media (max-width: 680px) {
		.side > .foot { display: none; }
		.mobile-session-tools { display: flex; align-items: center; justify-content: space-between; padding: 0 16px; flex-shrink: 0; min-height: 44px; font-size: 13px; color: var(--muted); }
		.mobile-session-tools button { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 4px 0 12px; border: 0; background: transparent; color: var(--ink-secondary); font-size: 12px; cursor: pointer; }
		.mobile-session-tools button:focus-visible { outline: 2px solid var(--accent); border-radius: var(--radius-sm); }
		.archive-count { font-variant-numeric: tabular-nums; color: var(--muted); }
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
	}

	.search-clear {
		position: absolute;
		right: 8px;
		background: transparent;
		border: 0;
		color: var(--muted-light);
		font-size: 13px;
		padding: 2px 6px;
		border-radius: 4px;
		cursor: pointer;
		line-height: 1;
	}

	.search-clear:hover {
		color: var(--ink);
		background: var(--line-subtle);
	}

	/* Not a field, but it has to look like one — it stands where the field stands. */
	.search-trigger {
		text-align: left;
		color: var(--muted-light);
		cursor: pointer;
	}

	/*
	 * The phone's search screen. Fixed over everything, including the bar at the bottom: while
	 * you are searching, the destinations are not where you are going, and the keyboard needs
	 * the room. The shell drops the bar for the same reason.
	 */
	.search-page {
		position: fixed;
		inset: 0;
		z-index: 120;
		display: flex;
		flex-direction: column;
		background: var(--pane);
		padding-top: env(safe-area-inset-top);
	}

	.search-page-head {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 8px 12px 8px 4px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--sidebar-bg);
	}

	.search-page-back {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.search-page-back:active {
		background: var(--line-subtle);
	}

	.search-page-field {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
	}

	/* Thumb-sized, and big enough that iOS does not zoom the page when the caret lands. */
	.search-page-field .search {
		padding: 9px 30px 9px 30px;
		font-size: 16px;
	}

	/* The same hits, filling a page instead of hanging under a field. */
	.search-drop.is-page {
		position: static;
		flex: 1;
		min-height: 0;
		max-height: none;
		border: 0;
		border-radius: 0;
		box-shadow: none;
		background: transparent;
		padding: 4px 6px calc(12px + env(safe-area-inset-bottom));
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.search-drop.is-page button.search-hit {
		gap: 11px;
		padding: 11px 10px;
		font-size: 13.5px;
	}

	.search-drop.is-page :global(p) {
		padding: 20px 12px;
		text-align: center;
	}

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
		animation: themeMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
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

	/* A page has the room to say which conversation a hit came from properly. */
	.search-drop.is-page .search-hit-kind {
		font-size: 11px;
	}

	.search-drop.is-page .search-hit-session {
		font-size: 12.5px;
	}



	.pinned-session-btn :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
		display: block;
	}

	/* Roster row, search, session groups, footer, theme menu. */
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

	.search-drop {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		max-height: 320px;
		overflow-y: auto;
		z-index: 10;
		padding: 4px;
	}

	.search-drop :global(button),
	.search-drop :global(p) {
		display: block;
		width: 100%;
		text-align: left;
		border-radius: var(--radius-sm);
		padding: 8px 10px;
		font-size: 12.5px;
		color: var(--ink);
	}

	.search-drop :global(p) {
		color: var(--muted);
	}

	.search-drop button.search-hit {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
	}

	.search-drop button.search-hit .search-hit-avatar {
		flex-shrink: 0;
		--avatar-ring: var(--pane);
	}

	.search-drop button.search-hit:hover .search-hit-avatar,
	.search-drop button.search-hit.is-highlighted .search-hit-avatar,
	.search-drop button.search-hit.is-selected .search-hit-avatar {
		--avatar-ring: var(--line-subtle);
	}

	.search-drop :global(button:hover),
	.search-drop button.search-hit.is-highlighted,
	.search-drop button.search-hit.is-selected {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.search-drop button.search-hit:hover,
	.search-drop button.search-hit.is-highlighted,
	.search-drop button.search-hit.is-selected {
		color: var(--ink);
	}

	.search-hit-session {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11.5px;
		font-weight: 650;
		color: var(--accent);
	}

	.search-unavailable { color: var(--muted); font-size: 11px; white-space: normal; }
	.search-hit[aria-disabled='true'] { cursor: default; }

	.search-hit-snippet {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		color: var(--ink-secondary);
		line-height: 1.35;
	}

	.search-drop button.search-hit:hover .search-hit-kind,
	.search-drop button.search-hit.is-highlighted .search-hit-kind,
	.search-drop button.search-hit.is-selected .search-hit-kind,
	.search-drop button.search-hit:hover .search-hit-session,
	.search-drop button.search-hit.is-highlighted .search-hit-session,
	.search-drop button.search-hit.is-selected .search-hit-session {
		color: var(--accent-hover);
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
		padding: 6px 10px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: var(--glass-footer);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		position: relative;
		z-index: 20;
	}

	.foot-left,
	.foot-right {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.foot-icon-btn {
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		position: relative;
		cursor: pointer;
		flex-shrink: 0;
	}

	.foot-icon-btn:hover {
		border-color: var(--line);
		color: var(--ink);
		background: var(--btn-secondary-hover);
		box-shadow: var(--shadow-xs);
	}

	.foot-icon-btn.is-active {
		border-color: var(--accent-border);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.foot-icon-btn:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.foot-icon-btn:disabled {
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

	.foot :global(.mono) {
		font-size: 11.5px;
		padding: 3px 8px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		border: 1px solid var(--chip-line);
	}

	.theme-menu {
		position: absolute;
		bottom: calc(100% + 8px);
		right: 0;
		min-width: 140px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		z-index: 100;
		user-select: none;
		animation: themeMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.theme-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		box-sizing: border-box;
		padding: 7px 10px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-align: left;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.theme-menu-item:hover,
	.theme-menu-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	.theme-menu-item.is-selected {
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.theme-menu-item :global(svg) {
		flex-shrink: 0;
		opacity: 0.75;
	}

	.theme-menu-item:hover :global(svg),
	.theme-menu-item:focus-visible :global(svg) {
		opacity: 1;
		stroke: var(--accent);
	}

	.theme-menu-item.is-selected :global(svg) {
		opacity: 1;
		stroke: var(--accent);
	}

	.theme-menu-label {
		flex: 1;
		white-space: nowrap;
	}

	.theme-menu-check {
		margin-left: 4px;
		stroke: var(--accent);
		flex-shrink: 0;
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

	.search::placeholder {
		color: var(--muted-light);
	}

	@keyframes themeMenuIn {
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
	:global(.shell.has-session) .side {
	display: none;
	}
	}

	@media (max-width: 680px) {
		/* 30px icons in the corners are neither hittable nor reachable one-handed. */
		.foot {
			padding: 6px 8px max(6px, env(safe-area-inset-bottom));
		}

		.foot-left,
		.foot-right {
			flex: 1;
			justify-content: space-evenly;
			gap: 0;
		}

		.foot-icon-btn {
			width: 44px;
			height: 44px;
		}

		.foot-icon-btn :global(svg) {
			width: 20px;
			height: 20px;
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
		 * Search and the archived entry share one 40px line. The label beside it said 会话, which
		 * is what the bar at the bottom of the screen already says, so it goes. Between this and
		 * the collapsed pinned rail the list starts about 140px higher — two more chats.
		 */
		.side-body {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-rows: auto minmax(0, 1fr);
		}

		/*
		 * One left edge for the whole screen. The list's own content starts at 22px (8px of
		 * `.groups` padding plus 14px of row padding), so the field and the group headers start
		 * there too instead of 10px further out.
		 */
		.search-wrap {
			grid-column: 1;
			grid-row: 1;
			margin: 6px 4px 6px 22px;
		}

		.search {
			padding: 7px 10px 7px 30px;
			font-size: 14px;
		}

		/* 18px + the button's own 4px puts the chevron on the same edge as the row times. */
		.mobile-session-tools {
			grid-column: 2;
			grid-row: 1;
			min-height: 40px;
			padding: 0 18px 0 0;
		}

		/* The label said 会话, which the bar at the bottom already says — but the archived view has
		   no other title, so it keeps its own. */
		.mobile-session-tools:not(.is-archived) > span {
			display: none;
		}

		.mobile-session-tools.is-archived {
			grid-column: 1 / -1;
			grid-row: 2;
			padding: 0 14px;
			border-bottom: 1px solid var(--line-subtle);
		}

		.mobile-session-tools.is-archived + .groups,
		.side-body:has(.mobile-session-tools.is-archived) .groups {
			grid-row: 3;
		}

		.side-body:has(.mobile-session-tools.is-archived) {
			grid-template-rows: auto auto minmax(0, 1fr);
		}

		.groups {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
