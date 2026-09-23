<script lang="ts">
	import {
		USER_MEMBER,
		type Attachment,
		type Bot,
		type SessionSummary
	} from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import { composerLocked } from './chat/composer-mode.ts';
	import { copyFor } from './copy.ts';
	import {
		dangerCopy,
		shouldDropConfirm,
		visibleDangerKind,
		type DangerKind,
		type DangerSource,
		type DangerAction
	} from './overlays/danger-confirm.ts';
	import {
		modelSelectValue,
		type ProviderEditorState
	} from './settings/provider-form.ts';
	import { routeLogRows } from './overlays/route-log.ts';
	import RouteLog from './overlays/RouteLog.svelte';
	import TerminalPane from './overlays/TerminalPane.svelte';
	import TaskTraceView from './overlays/TaskTrace.svelte';
	import { presentBotIds } from './sidebar/session-groups.ts';
	import {
		cleanPinnedIds,
		isSessionPinned,
		loadPinnedIds,
		savePinnedIds,
		togglePinnedId
	} from './sidebar/pinned-sessions.ts';
	import { themeManager } from './theme.ts';
	import {
		classifySession,
		youBotPeer
	} from './sidebar/session-groups.ts';
	import { sessionTitle } from './sidebar/session-title.ts';
	import { sanitizePreviewPath } from './session-url.ts';
	import { backdropClick } from './click-outside.ts';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import SessionContextMenu from './sidebar/SessionContextMenu.svelte';
	import { deriveSessionContextMenu } from './sidebar/session-context-menu.ts';
	import { handedOverPaths } from './overlays/artifacts.ts';
	import ArtifactPreview from './overlays/ArtifactPreview.svelte';
	import { targetFor } from './annotations/model.ts';
	import WorkspaceExplorer from './overlays/WorkspaceExplorer.svelte';
	import {
		clampPreviewWidth,
		loadPreviewWidth,
		savePreviewWidth
	} from './overlays/preview-width.ts';
	import {
		clampSidebarWidth,
		loadSidebarWidth,
		saveSidebarWidth
	} from './sidebar/sidebar-width.ts';
	import DangerDialog from './overlays/DangerDialog.svelte';
	import CreateBotSheet from './sidebar/CreateBotSheet.svelte';
	import CreateGroupSheet from './sidebar/CreateGroupSheet.svelte';
	import GroupPane, { type GroupDetailDraft } from './panels/GroupPane.svelte';
	import ProfilePane from './panels/ProfilePane.svelte';
	import Sidebar from './sidebar/Sidebar.svelte';
	import MobileNavigation from './MobileNavigation.svelte';
	import { topLayer, type MobileDestination } from './mobile-route.ts';
	import { pageSlide } from './mobile-page-slide.ts';
	import { updateChecker } from './update-checker.svelte.ts';
	import RoutineCalendar from './calendar/RoutineCalendar.svelte';
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

	onMount(() => {
		runtime.setNotificationIntentHandler((intent) => {
			guardNotificationNavigation(() => {
				runtime.applyNotificationIntent(intent);
			});
		});
		if (runtime.isDesktopShell) {
			void runtime.pollDesktopNativeState();
			const onFocus = () => void runtime.pollDesktopNativeState();
			window.addEventListener('focus', onFocus);
			return () => {
				runtime.setNotificationIntentHandler(null);
				window.removeEventListener('focus', onFocus);
			};
		}
		return () => runtime.setNotificationIntentHandler(null);
	});

	/** Owned here because Escape closes it before anything else; the sidebar renders it. */
	let themeMenuOpen = $state(false);
	/** The phone's tools menu beside the search field; Escape and Back close it first. */
	let toolsMenuOpen = $state(false);
	/**
	 * Searching on a phone is a screen, not a dropdown. The sidebar renders it; the flag lives
	 * here because Back and Escape have to close it, and because the bar at the bottom steps out
	 * of the way while it is up.
	 */
	let searchPageOpen = $state(false);
	/** The phone's floating + menu, held here for the same reasons. */
	let createMenuOpen = $state(false);
	let sidebar = $state<Sidebar>();
	let mobileSettingsDetail = $state(false);
	let settingsModal = $state<SettingsModal>();
	/**
	 * The Bot and group drawers are two screens on a phone, the same way settings is: the list of
	 * sections, then one section. The shell holds which one is showing because the drawer's own
	 * chrome changes with it, and because Back has to unwind the section before it closes.
	 */
	let paneMobileDetail = $state(false);
	let profilePane = $state<{ backFromEditor: () => boolean } | undefined>();

	/**
	 * One step out of whatever is on top. The phone's Back calls this first and only navigates
	 * when it says no; the order is `topLayer` in mobile-route.ts, which is also the order the
	 * Escape chain below walks.
	 *
	 * True means "handled here": either a layer closed, or it refused to (a confirmation that is
	 * already running owns the keyboard until it finishes). Screens the URL carries answer false
	 * — for those Back is a real navigation, except where closing has to go through a pane that
	 * may still have unsaved work.
	 */
	/**
	 * What ✕ closes in the Bot and group drawers: the screen it sits on. A section or a Bot's
	 * profile opened inside the drawer steps out one level; on the drawer's own screen there is
	 * nothing above it, so it closes.
	 */
	function closeCurrentDrawerScreen(): void {
		if (paneMobileDetail) {
			paneMobileDetail = false;
			return;
		}
		if (nestedProfile) {
			closeNestedProfile();
			return;
		}
		runtime.closeSessionSettings();
	}

	export function backMobileLayer(): boolean {
		switch (topLayer({
			themeMenuOpen,
			toolsMenuOpen,
			createMenuOpen,
			dangerConfirm: dangerConfirm !== null,
			createBotOpen: runtime.createBotOpen,
			createGroupOpen: runtime.createGroupOpen,
			providerEditor: providerEditor !== null,
			confirmingIndependent,
			searchPageOpen,
			settingsOpen: runtime.settingsOpen,
			sessionSettingsOpen: runtime.sessionSettingsOpen,
			terminalOpen: runtime.terminalOpen,
			routeLogOpen: runtime.routeLogOpen,
			traceOpen: runtime.traceOpen,
			routinesOpen: runtime.routinesOpen,
			threadOpen: runtime.threadOpen,
			workspaceOpen: runtime.workspaceOpen,
			artifactPreview: artifactPreview !== null
		})) {
			case 'theme-menu':
				themeMenuOpen = false;
				return true;
			case 'tools-menu':
				toolsMenuOpen = false;
				return true;
			case 'create-menu':
				createMenuOpen = false;
				return true;
			case 'danger':
				// A running action is not dismissible; swallowing Back is the point.
				if (escapeDismissesDanger) dismissDangerConfirm();
				return true;
			case 'create-bot':
				runtime.createBotOpen = false;
				return true;
			case 'create-group':
				runtime.createGroupOpen = false;
				return true;
			case 'provider-editor':
				providerEditor = null;
				return true;
			case 'independent-confirm':
				return true;
			case 'search-page':
				return sidebar?.closeSearchPage() ?? false;
			case 'settings':
				// Only its inner pages are ours to unwind; settings itself is an entry in history.
				return settingsModal?.backWithinSettings() ?? false;
			case 'session-settings':
				// Same split: the skill sheet and the section list are not in the URL, the drawer
				// and a Bot's profile inside it are.
				if (profilePane?.backFromEditor()) return true;
				if (paneMobileDetail) {
					paneMobileDetail = false;
					return true;
				}
				return false;
			case 'terminal':
				runtime.closeTerminal();
				return true;
			case 'route-log':
				runtime.closeRouteLog();
				return true;
			case 'trace':
				// Full screen over the flow is a page; the flow itself is an entry in history.
				return tracePane?.backFromFullOutput() ?? false;
			case 'routines':
				return false;
			case 'thread':
				runtime.threadOpen = false;
				return true;
			case 'workspace':
				// The find bar is ours. The screen itself is history's, unless an unsaved file has
				// to be asked about first — then the pane takes over and answers later.
				if (workspacePane?.closeFind()) return true;
				if (workspacePane?.blocksClose()) {
					workspacePane.requestCloseFromParent();
					return true;
				}
				return false;
			case 'preview':
				if (previewPane?.closeFind()) return true;
				if (previewPane?.blocksClose()) {
					previewPane.requestCloseFromParent();
					return true;
				}
				return false;
			default:
				return false;
		}
	}
	$effect(() => {
		// A different Bot or session, or a closed drawer: start again at the list of sections.
		void runtime.profileBotId;
		void runtime.selectedId;
		void runtime.sessionSettingsOpen;
		untrack(() => { paneMobileDetail = false; });
	});

	const mobileDestination = $derived<MobileDestination>(
		runtime.settingsOpen ? 'settings' : runtime.workspaceOpen ? 'workspace' : 'sessions'
	);
	function navigateMobile(destination: MobileDestination): void {
		if (destination === mobileDestination) return;
		// The three tab-bar pages replace one another. No slide: selecting a destination is not
		// pushing a page.
		const navigate = () => {
			themeMenuOpen = false;
			toolsMenuOpen = false;
			createMenuOpen = false;
			sidebar?.closeSearchPage();
			if (destination === 'settings') {
				runtime.openSettings();
			} else if (destination === 'workspace') {
				runtime.openWorkspace();
			}
			else {
				closeSettings();
				runtime.closeWorkspace();
				runtime.selectedId = null;
			}
		};
		if (runtime.workspaceOpen && workspacePane) {
			workspacePane.requestCloseFromParent(navigate);
		} else navigate();
	}

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
	let contextMenuEpoch = 0;
	let workspacePane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null>(null);
	let previewPreferred = $state(loadPreviewWidth());
	let previewDragging = $state(false);
	let sidebarPreferred = $state(loadSidebarWidth());
	let sidebarDragging = $state(false);
	let shellEl = $state<HTMLElement | null>(null);
	let shellWidth = $state(Number.POSITIVE_INFINITY);
	const previewWidth = $derived(clampPreviewWidth(previewPreferred, shellWidth));
	const sidebarWidth = $derived(clampSidebarWidth(sidebarPreferred, shellWidth));
	const isMobile = $derived(shellWidth <= 680);

	$effect(() => {
		const el = shellEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const apply = () => {
			shellWidth = el.clientWidth || Number.POSITIVE_INFINITY;
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(el);
		return () => observer.disconnect();
	});

	function openContextMenu(e: MouseEvent, session: SessionSummary): void {
		e.preventDefault();
		e.stopPropagation();
		contextMenuEpoch += 1;
		contextMenu = {
			session,
			x: e.clientX,
			y: e.clientY
		};
	}

	/**
	 * Deferred so the click that picked a menu item does not fall through onto the session row
	 * underneath once the menu unmounts. The epoch ignores a stale close after a new menu opens.
	 */
	function closeContextMenu(): void {
		const epoch = contextMenuEpoch;
		setTimeout(() => {
			if (contextMenuEpoch === epoch) contextMenu = null;
		}, 0);
	}

	function closeContextMenuNow(): void {
		contextMenuEpoch += 1;
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

	function handleMenuClearHistory(session: SessionSummary): void {
		closeContextMenuNow();
		openClearHistoryConfirm(session.id, 'menu');
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

	function handleMenuDelete(session: SessionSummary): void {
		closeContextMenuNow();
		const data = deriveSessionContextMenu(session, false, botsById);
		if (data.delete.kind === 'group' && data.delete.targetId) {
			openDeleteGroupConfirm(data.delete.targetId, 'menu');
			return;
		}
		if (data.delete.kind === 'bot' && data.delete.targetId) {
			openDeleteBotConfirm(data.delete.targetId, 'menu');
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
			: selectedKind === 'you-bot' && runtime.sessionSettingsOpen
				? selectedPeerBot
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
						learnings: snapshot.routeLearnings,
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

	function jumpToTrace(sessionId: string, messageId: string): void {
		void runtime.selectSession(sessionId, { messageId });
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
		kind: DangerKind;
		/** What the confirm button does. Whoever opens the dialog knows; the shell does not. */
		run: DangerAction;
		running?: boolean;
		/** The session this group / history confirm acts on. Independent of the open chat. */
		sessionId?: string;
		/** The Bot this confirm acts on, so it goes when that Bot leaves the roster. */
		botId?: string;
		/** The endpoint this is about, so the confirm goes when someone else deletes it. */
		providerId?: string;
		/** Drawer/settings confirms go when that surface closes. A sidebar menu confirm does not. */
		source?: DangerSource;
	};
	let dangerConfirm = $state<DangerConfirm | null>(null);
	let confirmingIndependent = $state(false);
	/** The profile drawer closes on a click outside it, not on the tail of a text-selection drag. */
	const profileBackdrop = backdropClick();

	async function confirmDanger(): Promise<void> {
		const pending = dangerConfirm;
		if (!pending || pending.running) return;
		pending.running = true;
		try {
			await pending.run(() => dangerConfirm === pending);
		} finally {
			pending.running = false;
		}
	}

	/** Drop the confirm only when it is one of these kinds, as the per-flag resets used to. */
	function clearDanger(...kinds: DangerKind[]): void {
		if (dangerConfirm && kinds.includes(dangerConfirm.kind)) dangerConfirm = null;
	}
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	const botIdSet = $derived(new Set(snapshot.bots.map((b) => b.id)));
	const providerIdSet = $derived(new Set(snapshot.providers.map((p) => p.id)));
	/** A group or history confirm follows the session it named, not whichever chat is open. */
	const dangerConfirmKind = $derived(
		visibleDangerKind(dangerConfirm, {
			selectedId: selected?.id ?? null,
			sessions: sessionsById,
			botIds: botIdSet,
			providerIds: providerIdSet
		})
	);
	/** The native confirmation consumes its own keyboard events before this fallback. */
	const escapeDismissesDanger = $derived(
		dangerConfirmKind !== null && dangerConfirmKind !== 'skill' && dangerConfirmKind !== 'memory'
	);
	/** The session drawer's backdrop refuses to close while one of its own confirms is up. */
	const drawerHasDanger = $derived(
		dangerConfirmKind === 'bot' ||
			dangerConfirmKind === 'group' ||
			dangerConfirmKind === 'history'
	);
	const dangerConfirmCopy = $derived(dangerConfirmKind ? dangerCopy(dangerConfirmKind, t) : null);
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
			untrack(() => {
				if (shouldDropConfirm('no-session', dangerConfirm)) clearDanger('group', 'history');
			});
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
		untrack(() => {
			if (shouldDropConfirm('session-changed', dangerConfirm)) clearDanger('group', 'history');
		});
	});

	$effect(() => {
		if (!runtime.sessionSettingsOpen) {
			untrack(() => {
				if (shouldDropConfirm('session-settings-closed', dangerConfirm)) {
					clearDanger('bot', 'group', 'history');
				}
			});
		}
	});

	$effect(() => {
		if (!runtime.settingsOpen) {
			providerEditor = null;
			untrack(() => {
				if (shouldDropConfirm('settings-closed', dangerConfirm)) clearDanger('provider');
			});
			return;
		}
		// A Bot or another window can delete the endpoint out from under an open confirm.
		const pending = untrack(() => dangerConfirm);
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

	function findAttachmentById(id: string): Attachment | null {
		for (const message of snapshot.messages) {
			const att = message.attachments.find((row) => row.id === id);
			if (att) return att;
		}
		return null;
	}

	function siblingsForPath(
		relpath: string,
		att?: Attachment | null,
		messageId?: string | null
	): Attachment[] {
		if (messageId) {
			const owner = snapshot.messages.find((message) => message.id === messageId);
			if (owner) {
				// The same list the bubble's entry counts, so the file tree and the entry cannot
				// disagree about what this message handed over. The context menu's looser reading
				// belongs to a menu, where a stray `1/3` out of prose costs nothing; in a file tree
				// it is a file that does not exist.
				const associated = handedOverPaths(
					owner.body ?? '',
					owner.attachments.map((row) => row.workspace_relpath)
				);
				if (associated.length > 0) {
					return associated.map((path) => {
						const existing = owner.attachments.find((a) => a.workspace_relpath === path);
						if (existing) return existing;
						return {
							id: `virtual-${owner.id}-${path}`,
							message_id: owner.id,
							workspace_relpath: path,
							original_filename: path.split('/').pop() ?? path,
							created_at: owner.created_at
						};
					});
				}
			}
		}
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

	const artifactPreview = $derived.by(() => {
		if (runtime.hosted) {
			const id = runtime.previewAttachmentId;
			if (!id) return null;
			const attachment = findAttachmentById(id);
			if (!attachment) return null;
			const owner = snapshot.messages.find((message) => message.id === attachment.message_id);
			return {
				relpath: attachment.workspace_relpath,
				attachment,
				siblings: siblingsForPath(attachment.workspace_relpath, attachment),
				target: targetFor(snapshot.messages, attachment.workspace_relpath, owner, { sessionId: runtime.selectedId }),
			};
		}
		const relpath = runtime.previewRelpath;
		if (!relpath) return null;
		const attachment = findAttachmentByPath(relpath);
		const owner = runtime.previewMessageId
			? snapshot.messages.find((message) => message.id === runtime.previewMessageId)
			: undefined;
		return {
			relpath,
			attachment,
			siblings: siblingsForPath(relpath, attachment, runtime.previewMessageId),
			forceTree: runtime.forceArtifactTree,
			// The entry opens the job's tree, not just this message's; older messages have none.
			taskId: owner?.task_id ?? null,
			// 挂到谁：the message this was opened from when it handed this very path over — the tree
			// keeps that message while you walk to other files — else the latest Bot message in this
			// conversation that did, in this job first.
			target: targetFor(snapshot.messages, relpath, owner, { sessionId: runtime.selectedId, taskId: owner?.task_id ?? null })
		};
	});

	function openArtifactPath(
		relpath: string,
		att?: Attachment,
		messageId?: string | null,
		forceTree = false
	): void {
		if (runtime.hosted) {
			// A remote URL never carries a file path, so the preview goes by attachment id.
			runtime.previewRelpath = null;
			runtime.previewAttachmentId = att?.id ?? findAttachmentByPath(relpath)?.id ?? null;
			return;
		}
		runtime.previewAttachmentId = null;
		runtime.previewRelpath = sanitizePreviewPath(relpath);
		runtime.previewMessageId = messageId ?? att?.message_id ?? null;
		runtime.forceArtifactTree = forceTree;
	}

	function closeArtifactPreview(): void {
		runtime.previewRelpath = null;
		runtime.previewAttachmentId = null;
		runtime.previewMessageId = null;
		runtime.forceArtifactTree = false;
		runtime.annotationFocusId = null;
	}

	function toggleWorkspaceExplorer(): void {
		if (!snapshot.settings.workspace_path) return;
		if (runtime.workspaceOpen) {
			workspacePane?.requestCloseFromParent();
			return;
		}
		runtime.openWorkspace(artifactPreview?.relpath ?? runtime.workspaceSelected);
		if (!artifactPreview?.relpath) void selectCurrentWorkDir();
	}

	/**
	 * Opening the explorer cold lands on this session's current work dir rather than wherever it
	 * was left days ago. Only the dir is known server-side, so it is a pull; a failure just leaves
	 * the previous selection, which is what the explorer did before.
	 */
	async function selectCurrentWorkDir(): Promise<void> {
		const client = runtime.client;
		const taskId = [...snapshot.messages].reverse().find((message) => message.task_id)?.task_id;
		if (!client || !taskId) return;
		try {
			const task = await client.taskArtifacts(taskId);
			if (runtime.workspaceOpen) runtime.workspaceSelected = task.dir;
		} catch {
			// the explorer keeps whatever it had
		}
	}

	function closeWorkspaceExplorer(): void {
		runtime.closeWorkspace();
	}

	function openWorkspaceFile(path: string): void {
		runtime.workspaceSelected = sanitizePreviewPath(path) ?? '';
	}

	let previewPane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null>(null);
	let tracePane = $state<{ backFromFullOutput: () => boolean } | null>(null);

	function startPreviewResize(ev: PointerEvent): void {
		if (!artifactPreview) return;
		ev.preventDefault();
		previewDragging = true;
		const originX = ev.clientX;
		const originW = previewWidth;
		const onMove = (move: PointerEvent) => {
			const shellW = shellEl?.clientWidth ?? 1200;
			previewPreferred = clampPreviewWidth(originW - (move.clientX - originX), shellW);
		};
		const onUp = () => {
			previewDragging = false;
			savePreviewWidth(previewPreferred);
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
			sidebarPreferred = clampSidebarWidth(originW + (move.clientX - originX), shellW);
		};
		const onUp = () => {
			sidebarDragging = false;
			saveSidebarWidth(sidebarPreferred);
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
		dangerConfirm = { kind: 'provider', run: () => deleteProvider(id), providerId: id, source: 'settings' };
	}

	async function deleteProvider(id: string): Promise<void> {
		const pending = dangerConfirm;
		saveFailed = false;
		const error = await runtime.deleteProvider(id);
		if (dangerConfirm !== pending) return;
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
	}): Promise<boolean> {
		saveFailed = false;
		const error = await runtime.patchSettings(patch);
		if (error) saveFailed = true;
		return !error;
	}

	function openProfile(botId: string): void {
		if (!botsById.has(botId)) return;
		if (dangerConfirm?.source !== 'menu') clearDanger('bot');
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
		runtime.closeProfile();
		if (dangerConfirm?.source !== 'menu') clearDanger('bot');
		profileFailed = false;
	}

	/**
	 * Deferred so the click that dismisses does not also reach the backdrop underneath. A timeout,
	 * not `requestAnimationFrame`: a window in the tray paints nothing, and a dismissal should not
	 * wait for the window to come back.
	 */
	function dismissDangerConfirm(): void {
		const pending = dangerConfirm;
		if (pending?.running) return;
		setTimeout(() => {
			if (dangerConfirm === pending) dangerConfirm = null;
		}, 0);
	}

	function openDeleteBotConfirm(botId?: string, source: DangerSource = 'drawer'): void {
		const id = botId ?? runtime.profileBotId ?? selectedPeer ?? null;
		if (!id) return;
		dangerConfirm = { kind: 'bot', run: () => deleteProfile(id), botId: id, source };
	}

	function openDeleteGroupConfirm(sessionId?: string, source: DangerSource = 'drawer'): void {
		const id = sessionId ?? selected?.id ?? null;
		if (!id) return;
		dangerConfirm = { kind: 'group', run: () => deleteGroupSession(id), sessionId: id, source };
	}

	function openClearHistoryConfirm(sessionId?: string, source: DangerSource = 'drawer'): void {
		const id = sessionId ?? selected?.id ?? null;
		if (!id) return;
		dangerConfirm = { kind: 'history', run: () => clearGroupHistory(id), sessionId: id, source };
	}

	async function deleteProfile(botId: string): Promise<void> {
		const pending = dangerConfirm;
		profileFailed = false;
		const error = await runtime.deleteBot(botId);
		if (dangerConfirm !== pending) return;
		if (error) {
			profileFailed = true;
			return;
		}
		dangerConfirm = null;
		if (runtime.profileBotId === botId || selectedPeer === botId) {
			if (selectedKind === 'you-bot') runtime.closeSessionSettings();
			else closeNestedProfile();
		}
	}

	async function deleteGroupSession(sessionId: string): Promise<void> {
		const pending = dangerConfirm;
		if (groupDetail.sessionId === sessionId) groupDetail.failed = false;
		const error = await runtime.deleteSession(sessionId);
		if (dangerConfirm !== pending) return;
		if (error) {
			if (groupDetail.sessionId === sessionId) groupDetail.failed = true;
			return;
		}
		dangerConfirm = null;
		if (runtime.selectedId === sessionId) runtime.closeSessionSettings();
	}

	async function clearGroupHistory(sessionId: string): Promise<void> {
		const pending = dangerConfirm;
		if (groupDetail.sessionId === sessionId) groupDetail.failed = false;
		const error = await runtime.clearSessionHistory(sessionId);
		if (dangerConfirm !== pending) return;
		if (error) {
			if (groupDetail.sessionId === sessionId) groupDetail.failed = true;
			return;
		}
		dangerConfirm = null;
	}

	function openCreateBot(): void {
		runtime.openCreateBot();
	}

	function openCreateGroup(): void {
		runtime.openCreateGroup();
	}

	function guardNotificationNavigation(perform: () => void): void {
		if (artifactPreview && previewPane?.requestCloseFromParent) {
			previewPane.requestCloseFromParent(() => {
				closeArtifactPreview();
				if (runtime.workspaceOpen && workspacePane?.requestCloseFromParent) {
					workspacePane.requestCloseFromParent(() => {
						closeWorkspaceExplorer();
						perform();
					});
					return;
				}
				perform();
			});
			return;
		}
		if (runtime.workspaceOpen && workspacePane?.requestCloseFromParent) {
			workspacePane.requestCloseFromParent(() => {
				closeWorkspaceExplorer();
				perform();
			});
			return;
		}
		perform();
	}

	const mobileNavigationVisible = $derived(
		!searchPageOpen &&
		!runtime.routinesOpen &&
		// The terminal is a full screen here, and the bar would sit on top of its key row.
		!runtime.terminalOpen &&
		!runtime.createBotOpen && !runtime.createGroupOpen && !runtime.sessionSettingsOpen &&
		!runtime.profileBotId && !dangerConfirm &&
		(runtime.settingsOpen ? !mobileSettingsDetail && !providerEditor : runtime.workspaceOpen || (!selected && !artifactPreview))
	);

	function openRoutinesFromUi(): void {
		const open = () => runtime.openRoutines();
		if (runtime.workspaceOpen && workspacePane) workspacePane.requestCloseFromParent(open);
		else open();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (themeMenuOpen) {
				themeMenuOpen = false;
			} else if (toolsMenuOpen) {
				toolsMenuOpen = false;
			} else if (createMenuOpen) {
				createMenuOpen = false;
			} else if (escapeDismissesDanger) {
				dismissDangerConfirm();
			} else if (runtime.createBotOpen) {
				runtime.createBotOpen = false;
			} else if (runtime.createGroupOpen) {
				runtime.createGroupOpen = false;
			} else if (providerEditor) {
				e.stopPropagation();
				providerEditor = null;
			} else if (confirmingIndependent) {
				e.stopPropagation();
			} else if (searchPageOpen) {
				sidebar?.closeSearchPage();
			} else if (runtime.settingsOpen) {
				closeSettings();
			} else if (runtime.sessionSettingsOpen && nestedProfile) {
				closeNestedProfile();
			} else if (runtime.sessionSettingsOpen) {
				runtime.closeSessionSettings();
			} else if (runtime.terminalOpen) {
				runtime.closeTerminal();
			} else if (runtime.routeLogOpen) {
				runtime.closeRouteLog();
			} else if (runtime.traceOpen) {
				runtime.closeTrace();
			} else if (runtime.routinesOpen) {
				runtime.closeRoutines();
			} else if (runtime.workspaceOpen) {
				if (workspacePane?.closeFind()) {
					e.preventDefault();
					e.stopPropagation();
				} else if (workspacePane) {
					workspacePane.requestCloseFromParent();
				} else {
					runtime.closeWorkspace();
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
	class:has-mobile-navigation={mobileNavigationVisible}
	class:is-thread={runtime.threadOpen}
	class:has-session={Boolean(selected)}
	class:has-routines={runtime.routinesOpen}
	class:is-preview={Boolean(artifactPreview)}
	class:is-preview-dragging={previewDragging}
	class:is-sidebar-dragging={sidebarDragging}
	bind:this={shellEl}
	style:--preview-width="{previewWidth}px"
	style:--sidebar-width="{sidebarWidth}px"
>
	<Sidebar
		bind:this={sidebar}
		{runtime}
		{t}
		{selected}
		{pinnedSessionIds}
		bind:themeMenuOpen
		bind:toolsMenuOpen
		bind:searchPageOpen
		bind:createMenuOpen
		workspaceOpen={runtime.workspaceOpen}
		contextMenuSessionId={contextMenu?.session.id ?? null}
		onOpenContextMenu={openContextMenu}
		onToggleWorkspace={toggleWorkspaceExplorer}
		onOpenRoutines={openRoutinesFromUi}
		onOpenSettings={() => runtime.openSettings()}
		onCreateBot={openCreateBot}
		onCreateGroup={openCreateGroup}
		onOpenArtifact={openArtifactPath}
		onPatchTheme={(theme) => patchImmediate({ theme })}
	/>
	<button
		type="button"
		class="sidebar-split"
		aria-label={t.sidebar.resize}
		onpointerdown={startSidebarResize}
	></button>
	<section class="main flex flex-col min-w-0 min-h-0 bg-pane relative">
		{#if runtime.routinesOpen}
			<RoutineCalendar {runtime} {t} />
		{:else if selected}
		<!--
			On a phone this is a page over the roster: it arrives from the right and Back walks
			it back out the same way. Wider windows keep both columns, and a zero-length slide
			there leaves the split exactly as the grid laid it out.
		-->
		<div class="conversation" transition:pageSlide>
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
		</div>
		{:else}
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
		{/if}
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
			forceTree={artifactPreview.forceTree}
			taskId={artifactPreview.taskId}
			target={artifactPreview.target}
			annotations={snapshot.annotations}
			annotationFocusId={runtime.annotationFocusId}
			annotationFileKey={runtime.annotationFileKeys[artifactPreview.relpath] ?? null}
			bots={botsById}
			{locale}
			sessions={snapshot.sessions}
			viewedSessionId={runtime.selectedId}
			onLoadAnnotations={(path) => void runtime.loadAnnotations({ relpath: path })}
			onCreateAnnotation={(input) => runtime.createAnnotation(input)}
			onPatchAnnotation={(id, patch) => runtime.patchAnnotation(id, patch)}
			onDeleteAnnotation={(id) => runtime.deleteAnnotation(id)}
			onSendAnnotations={(sessionId, summary, ids) => runtime.sendAnnotations(sessionId, summary, ids)}
			{t}
			onClose={closeArtifactPreview}
			onSelect={(att) =>
				openArtifactPath(
					att.workspace_relpath,
					att,
					runtime.previewMessageId,
					runtime.forceArtifactTree
				)}
			onSelectWorkspacePath={(path) =>
				openArtifactPath(
					path,
					undefined,
					runtime.previewMessageId,
					runtime.forceArtifactTree
				)}
		/>
	{/if}
	{#if runtime.traceOpen && selected}
		<TaskTraceView
			bind:this={tracePane}
			api={runtime.client}
			taskId={runtime.traceTaskId || null}
			sessionId={runtime.traceSessionId || selected.id}
			activeSessionId={selected.id}
			sessions={snapshot.sessions}
			bots={snapshot.bots}
			youLabel={t.common.you}
			deletedLabel={t.top.deleted}
			workspacePath={snapshot.settings.workspace_path}
			{t}
			reloadToken={runtime.traceReload}
			onClose={() => runtime.closeTrace()}
			onJump={jumpToTrace}
			onTask={(id) => {
				if (runtime.traceTaskId !== id) runtime.traceTaskId = id;
			}}
		/>
	{/if}
	{#if runtime.terminalOpen}
		<TerminalPane
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			rows={runtime.terminals}
			{t}
			onStream={(id, sink) => runtime.onStream(id, sink)}
			onChanged={() => runtime.refreshTerminals()}
			onClose={() => runtime.closeTerminal()}
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
	{#if runtime.workspaceOpen}
		<WorkspaceExplorer
			bind:this={workspacePane}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			selected={runtime.workspaceSelected}
			{t}
			onClose={closeWorkspaceExplorer}
			onOpenSettings={() => navigateMobile('settings')}
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
			onmousedowncapture={profileBackdrop.press}
			onclick={(e) => {
				if (drawerHasDanger) return;
				if (profileBackdrop.isOutside(e)) runtime.closeSessionSettings();
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					if (drawerHasDanger) dismissDangerConfirm();
					else if (nestedProfile) closeNestedProfile();
					else runtime.closeSessionSettings();
				}
			}}
		>
			<div class="sheet is-right session-settings" class:is-mobile-detail={paneMobileDetail}>
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
						<div class="panel-header-title-wrap flex items-center gap-5">
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
						onclick={closeCurrentDrawerScreen}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>

				{#if profileBot}
					{#key profileBot.id}
						<ProfilePane
							bind:this={profilePane}
							{runtime}
							bot={profileBot}
							{t}
							modelOptions={availableModelOptions}
							{selectedKind}
							bind:profileFailed
							bind:mobileDetail={paneMobileDetail}
							openDangerConfirm={(kind, run) => (dangerConfirm = { kind, run, source: 'drawer' })}
							{clearDanger}
							onDeleteBot={() => openDeleteBotConfirm()}
							onClearHistory={() => openClearHistoryConfirm()}
						/>
					{/key}
				{:else}
					<GroupPane
						{runtime}
						{selected}
						{t}
						bind:detail={groupDetail}
						bind:mobileDetail={paneMobileDetail}
						onOpenProfile={openProfile}
						onDeleteGroup={() => openDeleteGroupConfirm()}
						onClearHistory={() => openClearHistoryConfirm()}
					/>
				{/if}
			</div>
		</div>
	{/if}
	{#if dangerConfirmCopy}
		<DangerDialog
			copy={dangerConfirmCopy}
			{t}
			onDismiss={dismissDangerConfirm}
			busy={Boolean(dangerConfirm?.running)}
			onConfirm={() => void confirmDanger()}
		/>
	{/if}
	{#if mobileNavigationVisible}
		<MobileNavigation active={mobileDestination} {t} updateAvailable={updateChecker.updateVisible} onNavigate={navigateMobile} />
	{/if}
	<SettingsModal
		bind:this={settingsModal}
		bind:mobileSettingsDetail
		{runtime}
		{t}
		bind:saveFailed
		bind:providerEditor
		confirmingProvider={dangerConfirm?.kind === 'provider'}
		bind:confirmingIndependent
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
	{#if runtime.createGroupOpen}
		<CreateGroupSheet
			{runtime}
			bots={visibleBots}
			{t}
			onClose={() => (runtime.createGroupOpen = false)}
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
			onClearHistory={() => handleMenuClearHistory(activeMenu.session)}
			onToggleArchive={() => void handleMenuToggleArchive(activeMenu.session)}
			onDelete={() => handleMenuDelete(activeMenu.session)}
		/>
	{/if}
</div>
{/if}

<style>
	@media (max-width: 680px) {
		.shell.has-mobile-navigation > :global(.side) { padding-bottom: calc(60px + env(safe-area-inset-bottom)); }

	}

	.preview-split {
		width: 8px;
		padding: 0;
		border: 0;
		cursor: col-resize;
		position: relative;
		background: transparent;
		z-index: 2;
	}

	.preview-split::before {
		content: "";
		position: absolute;
		inset: 0 3px;
		background: var(--line);
		border-radius: 99px;
	}

	.preview-split:hover::before,
	.shell.is-preview-dragging .preview-split::before {
		background: var(--accent);
		inset: 0 2px;
	}

	.sidebar-split {
		width: 8px;
		padding: 0;
		border: 0;
		cursor: col-resize;
		position: relative;
		background: var(--sidebar-bg);
		z-index: 4;
		touch-action: none;
	}

	.sidebar-split::before {
		content: "";
		position: absolute;
		inset: 0 3px;
		background: var(--line);
		border-radius: 99px;
	}

	.sidebar-split:hover::before,
	.shell.is-sidebar-dragging .sidebar-split::before {
		background: var(--accent);
		inset: 0 2px;
	}

	/* Form Groups & Inputs in Panel */
	.sheet.session-settings :global(.form-group) {
		margin-bottom: 14px;
	}

	.sheet.session-settings :global(.form-group:last-child) {
		margin-bottom: 0;
	}

	.sheet.session-settings :global(.form-group) :global(label),

	.sheet.session-settings :global(.form-group) :global(.field-label) {
		display: block;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-secondary);
		margin-bottom: 6px;
		letter-spacing: 0.02em;
	}

	/* Group Members List */
	.sheet.session-settings :global(.members) {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0;
	}

	.sheet.session-settings :global(.member) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		border: 1px solid transparent;
		transition: all 0.15s ease;
	}

	.sheet.session-settings :global(.member:hover) {
		border-color: var(--line);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.sheet.session-settings :global(.deny) {
		background: var(--btn-secondary-bg);
		color: var(--danger);
		border: 1px solid var(--danger-line);
	}

	.sheet.session-settings :global(.deny:hover:not(:disabled)) {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	/* Thread drawer, sidebar flyouts, profile drawer, session details, panel cards. */
	/* Thread Drawer */
	.thread {
		background: var(--thread);
		border-left: 1px solid var(--line);
		display: none;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		box-shadow: -4px 0 16px rgba(15, 23, 42, 0.04);
	}

	.shell.is-thread .thread {
		display: flex;
	}

	.thread :global(header) {
		padding: 14px 16px;
		border-bottom: 1px solid var(--line);
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 14px;
		font-weight: 600;
		background: var(--pane);
	}

	.thread :global(header) :global(button) {
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		border-radius: var(--radius-sm);
		padding: 4px 10px;
		font-size: 12px;
		color: var(--muted);
	}

	.thread :global(header) :global(button:hover) {
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.thread :global(.body) {
		flex: 1;
		overflow-y: auto;
		padding: 16px;
	}

	/* Persona / Profile Drawer Backdrop & Right Sidebar */
	.profile-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.45);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		display: flex;
		justify-content: flex-end;
		z-index: 80;
		animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		overflow: hidden;
	}

	.sheet.is-right {
		position: relative;
		inset: auto;
		width: 340px;
		max-width: 90vw;
		height: 100%;
		border-right: none;
		border-left: 1px solid var(--line);
		box-shadow: -16px 0 36px -6px rgba(15, 23, 42, 0.18);
		z-index: auto;
		animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.sheet-back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		justify-content: flex-start;
		border: 0;
		background: transparent;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		box-shadow: none;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.sheet-back:hover {
		color: var(--accent-hover);
		background: var(--accent-tint);
	}

	.sheet.is-right.session-settings {
		width: 460px;
		max-width: 94vw;
		height: 100%;
		max-height: 100vh;
		box-sizing: border-box;
		padding: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
	}

	.sheet.session-settings :global(.sheet-head) {
		padding: 16px 20px;
		margin-bottom: 0;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		min-height: 56px;
		box-sizing: border-box;
	}

	.panel-header-icon {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--accent-border);
	}

	.sheet.session-settings :global(.sheet-head) :global(h2) {
		font-size: 15px;
		font-weight: 700;
		color: var(--ink);
		letter-spacing: -0.01em;
		margin: 0;
	}

	.sheet.session-settings :global(.profile-pane) {
		flex: 1 1 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/*
	 * The conversation is one column of the shell, so it has to fill that column and let the
	 * transcript scroll inside it. On a phone the media query below lifts it out of the flow.
	 */
	.conversation {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* Shell Layout */
	.shell {
		height: 100%;
		display: grid;
		grid-template-columns: var(--sidebar-width, 260px) 8px minmax(0, 1fr) 0fr;
		background: var(--bg);
		color: var(--ink);
		position: relative;
		transition: grid-template-columns 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.shell.is-thread {
		grid-template-columns: var(--sidebar-width, 260px) 8px minmax(0, 1fr) 320px;
	}

	.shell.is-preview {
		grid-template-columns: var(--sidebar-width, 260px) 8px minmax(0, 1fr) 8px var(--preview-width, 420px) 0fr;
	}

	.shell.is-preview.is-thread {
		grid-template-columns: var(--sidebar-width, 260px) 8px minmax(0, 1fr) 8px var(--preview-width, 420px) 320px;
	}

	.shell.is-preview-dragging,
	.shell.is-sidebar-dragging {
		transition: none;
		user-select: none;
		cursor: col-resize;
	}

	.shell.is-preview .thread {
		grid-column: 6;
	}

	/*
	 * Narrow: one column, and one thing in it. These override the grid above, so they have to come
	 * after it — a media query adds no specificity, and the desktop grid used to win at phone
	 * width, leaving a 200px list beside a dead strip.
	 */
	@media (max-width: 680px) {
		/* Bot and group settings are a page here, not a drawer peeking past a backdrop. */
		.profile-backdrop {
			background: var(--bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.sheet.is-right.session-settings {
			width: 100%;
			max-width: 100%;
			border-left: 0;
			box-shadow: none;
			animation: none;
		}

		.sheet.session-settings :global(.sheet-head) {
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 16px;
		}

		/* One header per screen: the section brings its own, with the way back in it. */
		.sheet.session-settings.is-mobile-detail :global(.sheet-head) {
			display: none;
		}

		.shell,
		.shell.is-thread,
		.shell.is-preview,
		.shell.is-preview.is-thread {
			grid-template-columns: 1fr;
		}

		/*
		 * The roster stays put. A conversation is a page laid over it, so Back has something to
		 * uncover while that page walks back out to the right. Until one is open the column is
		 * only there to receive that page, and it must not cover the list.
		 */
		.main {
			display: none;
		}

		/*
		 * `:has(.conversation)` rather than `.has-session`, because the two part ways for the
		 * 220ms the page spends walking back out: the session is already gone, and hiding the
		 * column then would cancel that walk before it painted.
		 */
		.shell:has(.conversation) .main,
		.shell.has-routines .main {
			position: fixed;
			inset: 0;
			z-index: 30;
			display: flex;
			min-width: 0;
		}

		.conversation {
			position: absolute;
			inset: 0;
			z-index: 1;
			display: flex;
			flex-direction: column;
			min-width: 0;
			min-height: 0;
			background: var(--pane);
		}

		.shell.has-routines .main {
			background: var(--pane);
		}

		/* The thread drawer would otherwise stack under the conversation as a second row. */
		.shell.is-thread .thread {
			position: fixed;
			inset: 0;
			width: 100%;
			z-index: 40;
		}

		/* Same for the artifact preview: it is a layer over the conversation, not a row of it. */
		.shell.is-preview :global(.artifact-pane) {
			position: fixed;
			inset: 0;
			z-index: 60;
		}
	}
</style>
