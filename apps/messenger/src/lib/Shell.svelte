<script lang="ts">
	import {
		USER_MEMBER,
		type Attachment,
		type Bot,
		type SessionSummary
	} from '@real-bot/protocol';
	import { composerLocked } from './composer-mode.ts';
	import { copyFor } from './copy.ts';
	import {
		modelSelectValue,
		type ProviderEditorState
	} from './provider-form.ts';
	import SessionAvatar from './SessionAvatar.svelte';
	import { routeLogRows } from './route-log.ts';
	import RouteLog from './RouteLog.svelte';
	import { presentBotIds } from './group-edit.ts';
	import {
		cleanPinnedIds,
		isSessionPinned,
		loadPinnedIds,
		savePinnedIds,
		togglePinnedId
	} from './pinned-sessions.ts';
	import { themeManager } from './theme.ts';
	import {
		classifySession,
		youBotPeer
	} from './session-groups.ts';
	import { sessionTitle } from './session-title.ts';
		import type { MessengerRuntime } from './runtime.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import Select from './Select.svelte';
	import SessionContextMenu from './SessionContextMenu.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import ArtifactPreview from './ArtifactPreview.svelte';
	import WorkspaceExplorer from './WorkspaceExplorer.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import {
		clampPreviewWidth,
		loadPreviewWidth,
		savePreviewWidth
	} from './preview-width.ts';
	import {
		clampSidebarWidth,
		loadSidebarWidth,
		saveSidebarWidth
	} from './sidebar-width.ts';
	import DangerDialog from './overlays/DangerDialog.svelte';
	import CreateBotSheet from './sidebar/CreateBotSheet.svelte';
	import GroupPane, { type GroupDetailDraft } from './panels/GroupPane.svelte';
	import ProfilePane from './panels/ProfilePane.svelte';
	import Sidebar from './sidebar/Sidebar.svelte';
	import ChatHeader from './chat/ChatHeader.svelte';
	import ChatStage from './chat/ChatStage.svelte';
	import SettingsModal from './settings/SettingsModal.svelte';

	let { runtime }: { runtime: MessengerRuntime } = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const t = $derived(copyFor(locale));
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	let pinnedSessionIds = $state<string[]>(loadPinnedIds());

	const validSessionIds = $derived(new Set(snapshot.sessions.map((s) => s.id)));

	$effect(() => {
		const cleaned = cleanPinnedIds(pinnedSessionIds, validSessionIds);
		if (cleaned.length !== pinnedSessionIds.length) {
			pinnedSessionIds = cleaned;
			savePinnedIds(cleaned);
		}
	});

	$effect(() => {
		if (snapshot.settings.theme) {
			themeManager.syncFromSnapshot(snapshot.settings.theme);
		}
	});

	/** Owned here because Escape closes it before anything else; the sidebar renders it. */
	let themeMenuOpen = $state(false);

	function togglePin(sessionId: string): void {
		const next = togglePinnedId(pinnedSessionIds, sessionId);
		pinnedSessionIds = next;
		savePinnedIds(next);
	}

	let contextMenu = $state<{
		session: SessionSummary;
		x: number;
		y: number;
	} | null>(null);
	let artifactPreview = $state<{
		relpath: string;
		attachment: Attachment | null;
		siblings: Attachment[];
	} | null>(null);
	let workspaceOpen = $state(false);
	let workspaceSelected = $state('');
	let workspacePane = $state<{ requestCloseFromParent: () => void; closeFind: () => boolean } | null>(null);
	let previewWidth = $state(loadPreviewWidth());
	let previewDragging = $state(false);
	let sidebarWidth = $state(loadSidebarWidth());
	let sidebarDragging = $state(false);
	let shellEl = $state<HTMLElement | null>(null);

	function openContextMenu(e: MouseEvent, session: SessionSummary): void {
		e.preventDefault();
		e.stopPropagation();
		contextMenu = {
			session,
			x: e.clientX,
			y: e.clientY
		};
	}

	function closeContextMenu(): void {
		contextMenu = null;
	}

	function handleMenuTogglePin(sessionId: string): void {
		togglePin(sessionId);
	}

	async function handleMenuViewInfo(session: SessionSummary): Promise<void> {
		if (runtime.selectedId !== session.id) {
			await runtime.selectSession(session.id);
		}
		const kind = classifySession(session);
		if (kind === 'you-bot') {
			const peer = youBotPeer(session);
			if (peer) {
				openProfile(peer);
				return;
			}
		}
		runtime.openSessionSettings();
	}

	async function handleMenuClearHistory(session: SessionSummary): Promise<void> {
		if (runtime.selectedId !== session.id) {
			await runtime.selectSession(session.id);
		}
		openClearHistoryConfirm();
	}

	async function handleMenuToggleArchive(session: SessionSummary): Promise<void> {
		if (session.kind === 'group') {
			if (session.archived_at) {
				await runtime.restoreSession(session.id);
			} else {
				await runtime.archiveSession(session.id);
			}
			return;
		}
		const peerId = youBotPeer(session);
		if (!peerId) return;
		const bot = botsById.get(peerId);
		if (!bot) return;
		if (bot.archived_at) {
			await runtime.restoreBot(bot.id);
		} else {
			await runtime.archiveBot(bot.id);
		}
	}

	async function handleMenuDelete(session: SessionSummary): Promise<void> {
		const kind = classifySession(session);
		if (kind === 'group') {
			if (runtime.selectedId !== session.id) {
				await runtime.selectSession(session.id);
			}
			openDeleteGroupConfirm();
			return;
		}
		if (kind === 'you-bot') {
			const peerId = youBotPeer(session);
			if (!peerId) return;
			if (runtime.selectedId !== session.id) {
				await runtime.selectSession(session.id);
			}
			runtime.profileBotId = peerId;
			openDeleteBotConfirm();
		}
	}



	const selected = $derived(snapshot.sessions.find((s) => s.id === runtime.selectedId) ?? null);
	const connected = $derived(runtime.connection === 'connected');
	let composer = $state<{ focus: () => void } | null>(null);
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(
		selectedPeer ? (botsById.get(selectedPeer) ?? null) : null
	);
	const lockedComposer = $derived(composerLocked(selected, botsById));
	const availableModelOptions = $derived(
		snapshot.providers.flatMap((provider) =>
			provider.models.map((model) => ({
				value: modelSelectValue(provider.id, model),
				label: model,
				hint: snapshot.providers.length > 1 ? provider.name : undefined
			}))
		)
	);
	const profileBot = $derived(
		runtime.profileBotId
			? (snapshot.bots.find((bot) => bot.id === runtime.profileBotId) ?? null)
			: null
	);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
	const sessionSettingsTitle = $derived(
		selectedKind === 'group' ? t.detail.titleGroup : t.detail.titleBot
	);
	const nestedProfile = $derived(
		Boolean(runtime.profileBotId && selectedKind !== 'you-bot')
	);
	const nestedBackLabel = $derived(
		selectedKind === 'group' ? t.detail.backToGroup : t.detail.backToBot
	);
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);
	const routeRows = $derived(
		selected
			? routeLogRows(
					snapshot.routes.filter((route) => route.session_id === selected.id),
					{
						bots: snapshot.bots,
						providers: snapshot.providers,
						reviews: snapshot.routeReviews,
						labels: {
							outcome: t.routes.outcome,
							fault: t.routes.fault,
							direction: t.routes.direction,
							signature: t.routes.signature,
							failReason: t.routes.failReason,
							thinking: t.routes.thinking,
							unknownBot: t.top.deleted
						}
					}
				)
			: []
	);

	function jumpToRouteTrigger(messageId: string): void {
		if (!selected) return;
		void runtime.selectSession(selected.id, { messageId });
	}
	let saveFailed = $state(false);
	let dismissedOnboarding = $state(false);
	const showOnboarding = $derived(!snapshot.settings.wizard_complete && !dismissedOnboarding);
	/** The settings modal owns what is in the endpoint editor; the shell only needs to know it is up. */
	let providerEditor = $state<ProviderEditorState | null>(null);
	/** The pane owns the rest of the profile draft; the shell's delete still writes this. */
	let profileFailed = $state(false);
	/**
	 * One confirm at a time. These used to be five booleans that each cleared the other four on the
	 * way up; every opener, every close path and the window handler had to keep that list in sync.
	 */
	type DangerConfirm = {
		/** Picks the copy, and says which close paths drop this confirm. */
		kind: 'bot' | 'group' | 'history' | 'skill' | 'provider';
		/** What the confirm button does. Whoever opens the dialog knows; the shell does not. */
		run: () => Promise<void>;
		/** The endpoint this is about, so the confirm goes when someone else deletes it. */
		providerId?: string;
	};
	let dangerConfirm = $state<DangerConfirm | null>(null);

	/** Drop the confirm only when it is one of these kinds, as the per-flag resets used to. */
	function clearDanger(...kinds: DangerConfirm['kind'][]): void {
		if (dangerConfirm && kinds.includes(dangerConfirm.kind)) dangerConfirm = null;
	}
	/** A group or history confirm stops showing once the session it belonged to is gone. */
	const dangerConfirmKind = $derived(
		dangerConfirm === null
			? null
			: dangerConfirm.kind === 'group'
				? (selected?.kind === 'group' ? 'group' : null)
				: dangerConfirm.kind === 'history'
					? (selected ? 'history' : null)
					: dangerConfirm.kind
	);
	/** Escape has never dismissed the skill confirm; it closes the drawer behind it instead. */
	const escapeDismissesDanger = $derived(dangerConfirm !== null && dangerConfirm.kind !== 'skill');
	/** The session drawer's backdrop refuses to close while one of its own confirms is up. */
	const drawerHasDanger = $derived(
		dangerConfirm?.kind === 'bot' ||
			dangerConfirm?.kind === 'group' ||
			dangerConfirm?.kind === 'history'
	);
	const dangerConfirmCopy = $derived(
		dangerConfirmKind === 'bot'
			? {
					title: t.sidebar.delete,
					body: t.sidebar.deleteBody,
					confirm: t.sidebar.confirmDelete,
					cancel: t.sidebar.cancel
				}
			: dangerConfirmKind === 'group'
				? {
						title: t.detail.deleteGroup,
						body: t.detail.deleteGroupBody,
						confirm: t.detail.confirmDeleteGroup,
						cancel: t.detail.cancel
					}
				: dangerConfirmKind === 'history'
					? {
							title: t.detail.clearHistory,
							body: t.detail.clearHistoryBody,
							confirm: t.detail.confirmClearHistory,
							cancel: t.detail.cancel
						}
					: dangerConfirmKind === 'skill'
						? {
								title: t.sidebar.skillDelete,
								body: t.sidebar.skillDeleteBody,
								confirm: t.sidebar.skillConfirmDelete,
								cancel: t.sidebar.skillCancel
							}
						: dangerConfirmKind === 'provider'
							? {
									title: t.settings.providerDelete,
									body: t.settings.providerDeleteBody,
									confirm: t.settings.providerConfirmDelete,
									cancel: t.settings.providerCancel
								}
							: null
	);
	/**
	 * The group pane's draft. It lives here, not in the pane: the reset below runs on every session
	 * change whether or not the drawer is open, so an unsaved name survives closing and reopening
	 * the drawer on the same session, as it always has.
	 */
	let groupDetail = $state<GroupDetailDraft>({
		sessionId: null,
		name: '',
		nameError: undefined,
		failed: false,
		pullPick: ''
	});














	$effect(() => {
		document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';
	});

	$effect(() => {
		const session = selected;
		if (!session) {
			groupDetail.sessionId = null;
			clearDanger('group', 'history');
			return;
		}
		if (groupDetail.sessionId === session.id) return;
		groupDetail = {
			sessionId: session.id,
			name: session.kind === 'group' ? (session.name ?? '') : '',
			nameError: undefined,
			failed: false,
			pullPick: ''
		};
		clearDanger('group', 'history');
	});

	$effect(() => {
		if (!runtime.sessionSettingsOpen) {
			clearDanger('bot', 'group', 'history');
		}
	});

	$effect(() => {
		if (!runtime.settingsOpen) {
			providerEditor = null;
			clearDanger('provider');
			return;
		}
		// A Bot or another window can delete the endpoint out from under an open confirm.
		const pending = dangerConfirm;
		if (pending?.providerId && !snapshot.providers.some((row) => row.id === pending.providerId)) {
			dangerConfirm = null;
		}
	});

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}



	function openBot(bot: Bot): void {
		const session = snapshot.sessions.find(
			(s) =>
				s.kind === 'direct' &&
				s.participants.some((p) => p.member === USER_MEMBER && p.left_at === null) &&
				s.participants.some((p) => p.member === bot.id && p.left_at === null)
		);
		if (session) void runtime.selectSession(session.id);
	}


	function findAttachmentByPath(relpath: string): Attachment | null {
		for (const message of snapshot.messages) {
			const att = message.attachments.find((row) => row.workspace_relpath === relpath);
			if (att) return att;
		}
		return null;
	}

	function siblingsForPath(relpath: string, att?: Attachment | null): Attachment[] {
		if (att) {
			const owner = snapshot.messages.find((message) => message.id === att.message_id);
			if (owner && owner.attachments.length > 0) return owner.attachments;
		}
		for (const message of snapshot.messages) {
			if (message.attachments.some((row) => row.workspace_relpath === relpath)) {
				return message.attachments;
			}
		}
		return att ? [att] : [];
	}

	function openArtifactPath(relpath: string, att?: Attachment): void {
		const attachment = att ?? findAttachmentByPath(relpath);
		artifactPreview = {
			relpath,
			attachment,
			siblings: siblingsForPath(relpath, attachment),
		};
	}

	function toggleWorkspaceExplorer(): void {
		if (!snapshot.settings.workspace_path) return;
		if (workspaceOpen) {
			workspacePane?.requestCloseFromParent();
			return;
		}
		runtime.createGroupOpen = false;
		workspaceOpen = true;
		if (artifactPreview) workspaceSelected = artifactPreview.relpath;
	}

	function closeWorkspaceExplorer(): void {
		workspaceOpen = false;
	}

	function openWorkspaceFile(path: string): void {
		workspaceSelected = path;
	}

	let previewPane = $state<{ requestCloseFromParent: () => void; closeFind: () => boolean } | null>(null);

	function closeArtifactPreview(): void {
		artifactPreview = null;
	}

	function startPreviewResize(ev: PointerEvent): void {
		if (!artifactPreview) return;
		ev.preventDefault();
		previewDragging = true;
		const originX = ev.clientX;
		const originW = previewWidth;
		const onMove = (move: PointerEvent) => {
			const shellW = shellEl?.clientWidth ?? 1200;
			previewWidth = clampPreviewWidth(originW - (move.clientX - originX), shellW);
		};
		const onUp = () => {
			previewDragging = false;
			savePreviewWidth(previewWidth);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function startSidebarResize(ev: PointerEvent): void {
		if (ev.button !== 0) return;
		ev.preventDefault();
		const handle = ev.currentTarget as HTMLElement;
		handle.setPointerCapture(ev.pointerId);
		sidebarDragging = true;
		const originX = ev.clientX;
		const originW = sidebarWidth;
		const onMove = (move: PointerEvent) => {
			const shellW = shellEl?.clientWidth ?? 1200;
			sidebarWidth = clampSidebarWidth(originW + (move.clientX - originX), shellW);
		};
		const onUp = () => {
			sidebarDragging = false;
			saveSidebarWidth(sidebarWidth);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}


	function closeSettings(): void {
		providerEditor = null;
		clearDanger('provider');
		runtime.settingsOpen = false;
	}

	function openDeleteProviderConfirm(id: string): void {
		dangerConfirm = { kind: 'provider', run: () => deleteProvider(id), providerId: id };
	}

	async function deleteProvider(id: string): Promise<void> {
		saveFailed = false;
		const error = await runtime.deleteProvider(id);
		if (error) {
			saveFailed = true;
			dangerConfirm = null;
			return;
		}
		dangerConfirm = null;
	}

	async function patchImmediate(patch: {
		locale?: 'zh' | 'en';
		theme?: 'system' | 'light' | 'dark';
		launch_at_login?: boolean;
	}): Promise<void> {
		saveFailed = false;
		const error = await runtime.patchSettings(patch);
		if (error) saveFailed = true;
	}

































	function openProfile(botId: string): void {
		if (!botsById.has(botId)) return;
		clearDanger('bot');
		profileFailed = false;
		// The pane is keyed on the Bot, so opening or switching remounts it with a fresh draft.
		runtime.openProfile(botId);
	}

	function toggleSessionSettings(): void {
		if (runtime.sessionSettingsOpen) {
			runtime.closeSessionSettings();
			return;
		}
		if (selectedKind === 'you-bot' && selectedPeerBot) {
			openProfile(selectedPeerBot.id);
			return;
		}
		runtime.openSessionSettings();
	}

	function closeNestedProfile(): void {
		// Unmounting the pane flushes its pending autosave and drops its drafts.
		runtime.profileBotId = null;
		clearDanger('bot');
		profileFailed = false;
	}

	function dismissDangerConfirm(): void {
		requestAnimationFrame(() => {
			dangerConfirm = null;
		});
	}

	function openDeleteBotConfirm(): void {
		dangerConfirm = { kind: 'bot', run: deleteProfile };
	}

	function openDeleteGroupConfirm(): void {
		dangerConfirm = { kind: 'group', run: deleteGroupSession };
	}

	function openClearHistoryConfirm(): void {
		dangerConfirm = { kind: 'history', run: clearGroupHistory };
	}

	async function deleteProfile(): Promise<void> {
		if (!runtime.profileBotId) return;
		profileFailed = false;
		const error = await runtime.deleteBot(runtime.profileBotId);
		if (error) {
			profileFailed = true;
			return;
		}
		dangerConfirm = null;
		if (selectedKind === 'you-bot') runtime.closeSessionSettings();
		else closeNestedProfile();
	}

	async function deleteGroupSession(): Promise<void> {
		if (!selected || selected.kind !== 'group') return;
		groupDetail.failed = false;
		const error = await runtime.deleteSession(selected.id);
		if (error) {
			groupDetail.failed = true;
			return;
		}
		dangerConfirm = null;
		runtime.closeSessionSettings();
	}

	async function clearGroupHistory(): Promise<void> {
		if (!selected) return;
		groupDetail.failed = false;
		const error = await runtime.clearSessionHistory(selected.id);
		if (error) {
			groupDetail.failed = true;
			return;
		}
		dangerConfirm = null;
	}

	function openCreateBot(): void {
		workspaceOpen = false;
		runtime.openCreateBot();
	}

	function openCreateGroup(): void {
		workspaceOpen = false;
		runtime.openCreateGroup();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (themeMenuOpen) {
				themeMenuOpen = false;
			} else if (escapeDismissesDanger) {
				dismissDangerConfirm();
			} else if (runtime.createBotOpen) {
				runtime.createBotOpen = false;
			} else if (providerEditor) {
				e.stopPropagation();
				providerEditor = null;
			} else if (runtime.settingsOpen) {
				closeSettings();
			} else if (runtime.sessionSettingsOpen && nestedProfile) {
				closeNestedProfile();
			} else if (runtime.sessionSettingsOpen) {
				runtime.closeSessionSettings();
			} else if (runtime.routeLogOpen) {
				runtime.closeRouteLog();
			} else if (workspaceOpen) {
				if (workspacePane?.closeFind()) {
					e.preventDefault();
					e.stopPropagation();
				} else if (workspacePane) {
					workspacePane.requestCloseFromParent();
				} else {
					workspaceOpen = false;
				}
			} else if (artifactPreview) {
				const target = e.target as HTMLElement | null;
				if (previewPane?.closeFind()) {
					e.preventDefault();
					e.stopPropagation();
				} else if (target?.closest('.monaco-editor, .editor-widget.find-widget, .artifact-cm')) {
					return;
				} else if (previewPane) previewPane.requestCloseFromParent();
				else closeArtifactPreview();
			}
		}
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
			const target = e.target as HTMLElement | null;
			if (target && (target.closest('input, textarea, [contenteditable="true"], .monaco-editor, .editor-widget.find-widget, .composer-input'))) {
				return;
			}
			if (!snapshot.settings.workspace_path) return;
			e.preventDefault();
			toggleWorkspaceExplorer();
		}
	}}
/>

{#if showOnboarding}
	<Onboarding {runtime} onDismiss={() => (dismissedOnboarding = true)} />
{:else}
<div
	class="shell"
	class:is-thread={runtime.threadOpen}
	class:has-session={Boolean(selected)}
	class:is-preview={Boolean(artifactPreview)}
	class:is-preview-dragging={previewDragging}
	class:is-sidebar-dragging={sidebarDragging}
	bind:this={shellEl}
	style:--preview-width="{previewWidth}px"
	style:--sidebar-width="{sidebarWidth}px"
>
	<Sidebar
		{runtime}
		{t}
		{selected}
		{pinnedSessionIds}
		bind:themeMenuOpen
		{workspaceOpen}
		contextMenuSessionId={contextMenu?.session.id ?? null}
		onOpenContextMenu={openContextMenu}
		onToggleWorkspace={toggleWorkspaceExplorer}
		onOpenSettings={() => {
			workspaceOpen = false;
			runtime.openSettings();
		}}
		onCreateBot={openCreateBot}
		onCreateGroup={openCreateGroup}
		onOpenArtifact={openArtifactPath}
		onPatchTheme={(theme) => void patchImmediate({ theme })}
	/>
	<button
		type="button"
		class="sidebar-split"
		aria-label={t.sidebar.resize}
		onpointerdown={startSidebarResize}
	></button>
	<section class="main">
		<ChatHeader
			{runtime}
			{t}
			{selected}
			{pinnedSessionIds}
			onTogglePin={togglePin}
			onToggleSessionSettings={toggleSessionSettings}
			onCreateBot={openCreateBot}
			onShowOnboarding={() => (dismissedOnboarding = false)}
		/>
		<ChatStage
			{runtime}
			{t}
			{selected}
			onOpenProfile={openProfile}
			onOpenArtifact={openArtifactPath}
			onCreateBot={openCreateBot}
		/>
	</section>
	{#if artifactPreview}
		<button
			type="button"
			class="preview-split"
			aria-label={t.stream.artifactResize}
			onpointerdown={startPreviewResize}
		></button>
		<ArtifactPreview
			bind:this={previewPane}
			attachment={artifactPreview.attachment}
			relpath={artifactPreview.relpath}
			siblings={artifactPreview.siblings}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			{t}
			onClose={closeArtifactPreview}
			onSelect={(att) => openArtifactPath(att.workspace_relpath, att)}
		/>
	{/if}
	{#if runtime.routeLogOpen && selected}
		<RouteLog
			rows={routeRows}
			sessionTitle={titleOf(selected)}
			loading={runtime.routesLoading}
			showEndpoint={snapshot.providers.length > 1}
			{t}
			onClose={() => runtime.closeRouteLog()}
			onJump={jumpToRouteTrigger}
		/>
	{/if}
	{#if workspaceOpen}
		<WorkspaceExplorer
			bind:this={workspacePane}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			selected={workspaceSelected}
			{t}
			onClose={closeWorkspaceExplorer}
			onSelect={openWorkspaceFile}
		/>
	{/if}
	<aside class="thread">
		<header>
			{t.thread.title}
			<button type="button" onclick={() => (runtime.threadOpen = false)}>{t.common.close}</button>
		</header>
		<div class="body">
			<p class="muted">{t.thread.none}</p>
		</div>
	</aside>
	{#if runtime.sessionSettingsOpen && selected}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="profile-backdrop"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => {
				if (drawerHasDanger) return;
				if (e.target === e.currentTarget) runtime.closeSessionSettings();
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					if (drawerHasDanger) dismissDangerConfirm();
					else if (nestedProfile) closeNestedProfile();
					else runtime.closeSessionSettings();
				}
			}}
		>
			<div class="sheet is-right session-settings">
				<div class="sheet-head">
					{#if nestedProfile}
						<button
							type="button"
							class="sheet-back"
							onclick={closeNestedProfile}
						>
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
							<span>{nestedBackLabel}</span>
						</button>
					{:else}
						<div class="panel-header-title-wrap">
							<div class="panel-header-icon" aria-hidden="true">
								{#if selectedKind === 'group'}
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
										<circle cx="9" cy="7" r="4"></circle>
										<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
										<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
									</svg>
								{:else}
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<circle cx="12" cy="12" r="3"></circle>
										<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
									</svg>
								{/if}
							</div>
							<h2>{sessionSettingsTitle}</h2>
						</div>
					{/if}
					<button
						type="button"
						class="sheet-close"
						title={t.common.close}
						onclick={() => runtime.closeSessionSettings()}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>

				<div class="panel-scroll-content">
					{#if profileBot}
						{#key profileBot.id}
							<ProfilePane
								{runtime}
								bot={profileBot}
								{t}
								modelOptions={availableModelOptions}
								{selectedKind}
								bind:profileFailed
								openDangerConfirm={(kind, run) => (dangerConfirm = { kind, run })}
								{clearDanger}
								onDeleteBot={openDeleteBotConfirm}
								onClearHistory={openClearHistoryConfirm}
							/>
						{/key}
					{:else}
					<GroupPane
						{runtime}
						{selected}
						{t}
						bind:detail={groupDetail}
						onOpenProfile={openProfile}
						onDeleteGroup={openDeleteGroupConfirm}
						onClearHistory={openClearHistoryConfirm}
					/>
					{/if}
				</div>
			</div>
		</div>
	{/if}
	{#if dangerConfirmCopy}
		<DangerDialog
			copy={dangerConfirmCopy}
			{t}
			onDismiss={dismissDangerConfirm}
			onConfirm={() => void dangerConfirm?.run()}
		/>
	{/if}
	<SettingsModal
		{runtime}
		{t}
		bind:saveFailed
		bind:providerEditor
		confirmingProvider={dangerConfirm?.kind === 'provider'}
		{patchImmediate}
		{openDeleteProviderConfirm}
		{closeSettings}
	/>
	{#if runtime.createBotOpen}
		<CreateBotSheet
			{runtime}
			modelOptions={availableModelOptions}
			{t}
			onClose={() => (runtime.createBotOpen = false)}
		/>
	{/if}

	{#if contextMenu}
		{@const activeMenu = contextMenu}
		<SessionContextMenu
			session={activeMenu.session}
			{botsById}
			isPinned={isSessionPinned(pinnedSessionIds, activeMenu.session.id)}
			x={activeMenu.x}
			y={activeMenu.y}
			{t}
			onClose={closeContextMenu}
			onTogglePin={() => handleMenuTogglePin(activeMenu.session.id)}
			onViewInfo={() => void handleMenuViewInfo(activeMenu.session)}
			onClearHistory={() => void handleMenuClearHistory(activeMenu.session)}
			onToggleArchive={() => void handleMenuToggleArchive(activeMenu.session)}
			onDelete={() => void handleMenuDelete(activeMenu.session)}
		/>
	{/if}
</div>
{/if}
