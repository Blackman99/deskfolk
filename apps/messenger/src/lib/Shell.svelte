<script lang="ts">
	import {
		USER_MEMBER,
		type Bot,
		type SessionSummary,
		type SearchHit
	} from '@real-bot/protocol';
	import { onMount, tick, untrack } from 'svelte';
	import { composerLocked } from './chat/composer-mode.ts';
	import { copyFor } from './copy.ts';
	import ImageCopy from './ImageCopy.svelte';
	import WorkspaceDragGhost from './WorkspaceDragGhost.svelte';
	import { dangerCopy, shouldDropConfirm } from './overlays/danger-confirm.ts';
	import { ShellDangerConfirm } from './overlays/danger-confirm.svelte.ts';
	import {
		modelSelectValue,
		type ProviderEditorState
	} from './settings/provider-form.ts';
	import { endpointModelOptions } from './model-source.ts';
	import TerminalPane from './overlays/TerminalPane.svelte';
	// TaskTrace.svelte (the flow board) drags in @dagrejs/dagre and its own graph-layout code;
	// it is only ever seen after `runtime.traceOpen` fires, so it is loaded with the same
	// `{#await import(...)}` lazy-mount pattern as the other panels below.
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
		isFileDropSession,
		youBotPeer
	} from './sidebar/session-groups.ts';
	import { sessionTitle } from './sidebar/session-title.ts';
	import { backdropClick } from './click-outside.ts';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import SessionContextMenu from './sidebar/SessionContextMenu.svelte';
	import WorkspaceExplorer from './overlays/WorkspaceExplorer.svelte';
	import ShellPreview from './overlays/ShellPreview.svelte';
	import {
		clampSidebarWidth,
		loadSidebarCollapsed,
		loadSidebarWidth,
		saveSidebarCollapsed,
		saveSidebarWidth,
		SIDEBAR_RAIL
	} from './sidebar/sidebar-width.ts';
	import DangerDialog from './overlays/DangerDialog.svelte';
	import CreateBotSheet from './sidebar/CreateBotSheet.svelte';
	import CreateGroupSheet from './sidebar/CreateGroupSheet.svelte';
	import SessionSettingsDrawer from './panels/SessionSettingsDrawer.svelte';
	import type { GroupDetailDraft } from './panels/group-edit.ts';
	import Sidebar from './sidebar/Sidebar.svelte';
	import SidebarRail from './sidebar/SidebarRail.svelte';
	import GlobalSearch from './search/GlobalSearch.svelte';
	import { matchesSearchShortcut } from './search/shortcuts.ts';
	import { searchJump } from './sidebar/search-jump.ts';
	import MobileNavigation from './MobileNavigation.svelte';
	import { topLayer, type MobileDestination } from './mobile-route.ts';
	import { closeEnlargedImage, imageEnlarged } from './chat/enlarged-images.ts';
	import { closeMessageText, messageTextOpen } from './chat/message-text-pages.ts';
	import { closeFullscreenPreview, fullscreenPreviewOpen } from './overlays/fullscreen-preview.ts';
	import { pageSlide } from './mobile-page-slide.ts';
	import { updateChecker } from './update-checker.svelte.ts';
	import { spendCopyFor } from './spend/spend-copy.ts';
	// RoutineCalendar.svelte pulls in svelte5plus-calendar; it is loaded lazily below, only once
	// `runtime.routinesOpen` is true.
	import Workbench from './workbench/Workbench.svelte';
	import PaneContentHost from './workbench/PaneContentHost.svelte';
	import PaneTabLabel from './workbench/PaneTabLabel.svelte';
	import NewPaneMenu from './workbench/NewPaneMenu.svelte';
	import { isWorkbenchSurface, sidebarFolds, watchNarrow } from './workbench/surface.ts';
	import { paneMin } from './workbench/pane-mins.ts';
	import { contentOfTab, contentToParams } from './workbench/pane-content.ts';
	import { closeChatSide, settingsSide, toggleChatSide } from './workbench/pane-open.ts';
	import { isTypingTarget, matchesCloseTab, matchesSidebarToggle, matchWorkbenchKey } from './workbench/workbench-commands.ts';
	import { isTauri } from './tauri.ts';
	import { activateTab, focusLeaf, replaceTabParams } from './workbench/layout-tree.ts';
	import type { TabAction, WorkbenchTab } from './workbench/layout-types.ts';
	import { ShellWorkbench } from './workbench/shell-workbench.svelte.ts';
	import { ShellSessionMenu } from './sidebar/session-menu-actions.svelte.ts';
	import { ShellArtifact } from './overlays/shell-artifact.svelte.ts';
	import ChatHeader from './chat/ChatHeader.svelte';
	import ChatTabLabel from './chat/ChatTabLabel.svelte';
	import ChatStage from './chat/ChatStage.svelte';
	import { trackPointerDrag } from './pointer-drag.ts';
	// SettingsModal.svelte (with its tabs, provider/MCP/notification sub-panels and editor flyout) is
	// loaded lazily below on first `runtime.settingsOpen`, and stays mounted after that — its own
	// template is already gated on `runtime.settingsOpen` (an `{#if runtime.settingsOpen}` inside
	// that file), so deferring the mount changes nothing but when the bytes are fetched.
	import type SettingsModal from './settings/SettingsModal.svelte';

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
			artifact.guardNotificationNavigation(() => {
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

	/** Escape and Back close the sidebar tools menu first. */
	let toolsMenuOpen = $state(false);
	let searchOpen = $state(false);
	let searchDialog = $state<GlobalSearch>();
	let searchOpener = $state<HTMLElement | null>(null);

	function searchBlocked(): boolean {
		return Boolean(showOnboarding || danger.dangerConfirm || runtime.createBotOpen || runtime.createGroupOpen || providerEditor || danger.confirmingIndependent || document.querySelector('dialog[open], .skill-modal-backdrop, .memory-modal-backdrop'));
	}

	function openGlobalSearch(): void {
		if (searchOpen) { searchDialog?.focusQuery(); return; }
		if (searchBlocked()) return;
		searchOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		toolsMenuOpen = false;
		createMenuOpen = false;
		sessionMenu.contextMenu = null;
		runtime.closeSearch();
		searchOpen = true;
	}

	function closeGlobalSearch(): boolean {
		if (!searchOpen) return false;
		searchOpen = false;
		runtime.closeSearch();
		return true;
	}

	function selectSearchHit(hit: SearchHit): void {
		const jump = searchJump(hit, snapshot.sessions, snapshot.routines, snapshot.bots);
		const path = hit.kind === 'file' ? hit.path : null;
		if (!path && !jump) return;
		closeGlobalSearch();
		const open = () => {
			closeSettings();
			if (!wide) { runtime.closeSessionSettings(); runtime.closeTerminal(); runtime.closeRemoteScreen(); runtime.closeTrace(); runtime.threadOpen = false; }
			if (path) artifact.openArtifactPath(path);
			else if (jump && 'routineId' in jump) void runtime.openRoutine(jump.botId, jump.routineId);
			else if (jump) void runtime.selectSession(jump.sessionId, { messageId: jump.messageId });
			void tick().then(() => {
				if (searchOpen || document.querySelector('dialog[open]')) return;
				const target = shellEl?.querySelector<HTMLElement>('.wb-leaf.is-focused .wb-body, .wb-float.is-focused .wb-body') ?? shellEl?.querySelector<HTMLElement>('.main');
				if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
			});
		};
		if (wide) open();
		else artifact.guardNotificationNavigation(open);
	}

	onMount(() => {
		const searchKey = (event: KeyboardEvent) => {
			if (!matchesSearchShortcut(event)) return;
			if (!searchOpen && searchBlocked()) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			openGlobalSearch();
		};
		window.addEventListener('keydown', searchKey, true);
		return () => window.removeEventListener('keydown', searchKey, true);
	});
	/** The phone's floating + menu, held here for the same reasons. */
	let createMenuOpen = $state(false);
	let sidebar = $state<Sidebar>();
	let mobileSettingsDetail = $state(false);
	let settingsModal = $state<SettingsModal>();
	/**
	 * Settings is opened far more often than once, but its module is only worth fetching the
	 * first time it is. Once true this never goes back to false, so the lazy-loaded
	 * `<SettingsModal>` below stays mounted across opens/closes exactly as the old, always-mounted
	 * import did (its own template already no-ops while `runtime.settingsOpen` is false).
	 */
	let settingsEverOpened = $state(false);
	$effect(() => {
		if (runtime.settingsOpen) settingsEverOpened = true;
	});
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
	 * What ✕ closes. A section of the drawer's own screen steps out one level. A Bot opened from a
	 * group is that Bot's settings page, so its ✕ leaves settings for the conversation.
	 */
	function closeCurrentDrawerScreen(): void {
		if (nestedProfile && narrow) {
			runtime.closeSessionSettings();
			return;
		}
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
		if (closeFullscreenPreview()) return true;
		switch (topLayer({
			imageOpen: imageEnlarged(),
			messageTextOpen: messageTextOpen(),
			toolsMenuOpen,
			createMenuOpen,
			dangerConfirm: danger.dangerConfirm !== null,
			createBotOpen: runtime.createBotOpen,
			createGroupOpen: runtime.createGroupOpen,
			providerEditor: providerEditor !== null,
			confirmingIndependent: danger.confirmingIndependent,
			searchOpen,
			settingsOpen: runtime.settingsOpen,
			sessionSettingsOpen: runtime.sessionSettingsOpen,
			terminalOpen: runtime.terminalOpen,
			screenOpen: runtime.screenOpen,
			traceOpen: runtime.traceOpen,
			routinesOpen: runtime.routinesOpen,
			spendOpen: runtime.spendOpen,
			threadOpen: runtime.threadOpen,
			workspaceOpen: runtime.workspaceOpen,
			artifactPreview: artifact.artifactPreview !== null
		})) {
			case 'image':
				// Not a screen: it goes back into the picture it grew out of, and the page stays.
				return closeEnlargedImage();
			case 'message-text':
				// Not a screen either: the conversation it was opened from is still under it.
				return closeMessageText();
			case 'tools-menu':
				toolsMenuOpen = false;
				return true;
			case 'create-menu':
				createMenuOpen = false;
				return true;
			case 'danger':
				// A running action is not dismissible; swallowing Back is the point.
				if (danger.escapeDismissesDanger) danger.dismissDangerConfirm();
				return true;
			case 'create-bot':
				runtime.createBotOpen = false;
				return true;
			case 'create-group':
				runtime.createGroupOpen = false;
				return true;
			case 'provider-editor':
				settingsModal?.backFromProviderEditor();
				return true;
			case 'independent-confirm':
				return true;
			case 'search':
				return closeGlobalSearch();
			case 'settings':
				// Only its inner pages are ours to unwind; settings itself is an entry in history.
				return settingsModal?.backWithinSettings() ?? false;
			case 'session-settings':
				// The skill sheet and the section list are not in the URL, so they close here one
				// at a time — on a Bot opened from a group too. What is left is history's: the
				// drawer, or that Bot's page, which Back leaves for the conversation.
				if (profilePane?.backFromEditor()) return true;
				if (paneMobileDetail) {
					paneMobileDetail = false;
					return true;
				}
				return false;
			case 'terminal':
				// A history entry, like the calendar: the page's button closes it, and Back walks
				// the URL. Answering true here would pop nothing and leave the page open.
				return false;
			case 'screen':
				// The same: Back leaves the Mac's screen by walking the URL.
				return false;
			case 'trace':
				// The flow is one entry in history, and nothing done on it adds another. A file opened
				// from a card lies over the page without an entry of its own, so Back puts it away here,
				// the way Escape does, and only the next Back leaves the flow for the conversation.
				if (artifact.artifactPreview) {
					if (!previewPane?.closeFind()) {
						if (previewPane) previewPane.requestCloseFromParent();
						else artifact.closeArtifactPreview();
					}
					return true;
				}
				return false;
			case 'routines':
				return false;
			case 'spend':
				// A history entry, like the calendar: the page's button closes it, and Back walks
				// the URL. Answering true here would pop nothing and leave the page open.
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
			toolsMenuOpen = false;
			createMenuOpen = false;
			closeGlobalSearch();
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

	/** The session context menu and its items. See `sidebar/session-menu-actions.svelte.ts`. */
	const sessionMenu = new ShellSessionMenu({
		runtime: () => runtime,
		botsById: () => botsById,
		danger: () => danger,
		togglePin,
		openProfile
	});
	let workspacePane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null>(null);
	/**
	 * The artifact preview and the workspace explorer: what the preview shows, opening and closing
	 * both, the preview column's width, and the ways out that ask them first. See
	 * `overlays/shell-artifact.svelte.ts`.
	 */
	const artifact = new ShellArtifact({
		runtime: () => runtime,
		selected: () => selected,
		wide: () => wide,
		shellEl: () => shellEl,
		shellWidth: () => shellWidth,
		workspacePane: () => workspacePane,
		previewPane: () => previewPane
	});
	let sidebarPreferred = $state(loadSidebarWidth());
	let sidebarDragging = $state(false);
	let shellEl = $state<HTMLElement | null>(null);
	let shellWidth = $state(Number.POSITIVE_INFINITY);
	const sidebarWidth = $derived(clampSidebarWidth(sidebarPreferred, shellWidth));
	const isMobile = $derived(shellWidth <= 680);
	/**
	 * The desktop workbench. Above the narrow breakpoint the main column is a tree of panes; at or
	 * below it the app is what it has always been, one screen at a time with a back stack, and
	 * none of this renders.
	 */
	let narrow = $state(false);
	$effect(() => watchNarrow((value) => (narrow = value)));
	const wide = $derived(isWorkbenchSurface(narrow));
	/**
	 * The session list folded down to a rail of avatars. Anywhere the list is a column of the shell
	 * it can fold: the desktop workbench, and the paired client on a tablet, which keeps the columns
	 * but not the panes. At or below the breakpoint the list is a screen of its own, and there is
	 * nothing to fold.
	 */
	let sidebarCollapsed = $state(loadSidebarCollapsed());
	const sidebarColumn = $derived(sidebarFolds(narrow));
	const sidebarHidden = $derived(sidebarColumn && sidebarCollapsed);

	/**
	 * The list and the rail each carry the button to become the other. Focus that was on either
	 * follows to the button that replaces it, rather than falling to the page.
	 */
	/** The rail's menu asked for the archived list, which only the full list has: open the list on it. */
	function openArchivedFromRail(): void {
		if (!sidebarCollapsed) return;
		toggleSidebar();
		void tick().then(() => sidebar?.showArchived());
	}

	function toggleSidebar(): void {
		const next = !sidebarCollapsed;
		const refocus = Boolean(shellEl?.querySelector(':scope > .side, :scope > .rail')?.contains(document.activeElement));
		// Either side's tools menu hangs off a button that is about to go.
		toolsMenuOpen = false;
		sidebarCollapsed = next;
		saveSidebarCollapsed(next);
		if (refocus) {
			void tick().then(() => shellEl?.querySelector<HTMLElement>(next ? '.rail-expand' : '.side-collapse')?.focus());
		}
	}
	/**
	 * The desktop workbench cluster: the pane tree, its persistence, and the effects and pane-open
	 * plumbing that keep it in step with the selected conversation and the live snapshot. See
	 * `workbench/shell-workbench.svelte.ts`.
	 */
	const workbench = new ShellWorkbench({
		runtime: () => runtime,
		wide: () => wide,
		shellWidth: () => shellWidth,
		shellEl: () => shellEl,
		sessionsById: () => sessionsById,
		titleOf,
		t: () => t
	});

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

	const selected = $derived(snapshot.sessions.find((s) => s.id === runtime.selectedId) ?? null);
	const connected = $derived(runtime.connection === 'connected');
	let composer = $state<{ focus: () => void } | null>(null);
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(
		selectedPeer ? (botsById.get(selectedPeer) ?? null) : null
	);
	const lockedComposer = $derived(composerLocked(selected, botsById));
	const availableModelOptions = $derived(endpointModelOptions(snapshot.providers, t, modelSelectValue));
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
	const nestedProfile = $derived(
		Boolean(runtime.profileBotId && selectedKind !== 'you-bot')
	);
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);
	function jumpToTrace(sessionId: string, messageId: string): void {
		void runtime.selectSession(sessionId, { messageId });
	}
	/**
	 * The flow page covers the conversation, so a card's message is shown by leaving the page for
	 * it: back to the conversation it was opened from, or in place of the page when the card lives
	 * in another one. Either way the jump adds no entry of its own.
	 */
	function jumpFromTracePage(sessionId: string, messageId: string): void {
		runtime.closeTrace();
		jumpToTrace(sessionId, messageId);
	}
	let saveFailed = $state(false);
	let dismissedOnboarding = $state(false);
	/** The wizard's last step, the first Bot, comes after setup is complete; it holds itself up for it. */
	let onboardingHeld = $state(false);
	const showOnboarding = $derived(
		(!snapshot.settings.wizard_complete || onboardingHeld) && !dismissedOnboarding
	);
	/** The settings modal owns what is in the endpoint editor; the shell only needs to know it is up. */
	let providerEditor = $state<ProviderEditorState | null>(null);
	/** The pane owns the rest of the profile draft; the shell's delete still writes this. */
	let profileFailed = $state(false);
	/** The profile drawer closes on a click outside it, not on the tail of a text-selection drag. */
	const profileBackdrop = backdropClick();
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	/**
	 * One confirm at a time, and the open/delete actions that arm it. These used to be five
	 * booleans that each cleared the other four on the way up; every opener, every close path and
	 * the window handler had to keep that list in sync. See `overlays/danger-confirm.svelte.ts`.
	 */
	const danger = new ShellDangerConfirm({
		runtime: () => runtime,
		selected: () => selected,
		sessionsById: () => sessionsById,
		groupDetail: () => groupDetail,
		setProfileFailed: (value) => {
			profileFailed = value;
		},
		setSaveFailed: (value) => {
			saveFailed = value;
		},
		closeNestedProfile
	});
	const dangerConfirmCopy = $derived(danger.dangerConfirmKind ? dangerCopy(danger.dangerConfirmKind, t) : null);
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

	/** The conversation whose settings are open beside it on the workbench, if any. */
	const settingsBeside = $derived(wide ? settingsSide(workbench.layout) : null);
	/**
	 * Whose settings the draft is for. On the workbench that is the conversation they are open
	 * beside, which need not be the one the keyboard is in: clicking into another pane must not
	 * swap the group name being edited for that pane's.
	 */
	const draftSession = $derived(
		settingsBeside ? (sessionsById.get(settingsBeside.sessionId) ?? null) : selected
	);

	$effect(() => {
		const session = draftSession;
		if (!session) {
			groupDetail.sessionId = null;
			untrack(() => {
				if (shouldDropConfirm('no-session', danger.dangerConfirm)) danger.clearDanger('group', 'history');
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
			if (shouldDropConfirm('session-changed', danger.dangerConfirm)) danger.clearDanger('group', 'history');
		});
	});

	$effect(() => {
		if (!runtime.sessionSettingsOpen && !settingsBeside) {
			untrack(() => {
				if (shouldDropConfirm('session-settings-closed', danger.dangerConfirm)) {
					danger.clearDanger('bot', 'group', 'history');
				}
			});
		}
	});

	$effect(() => {
		if (!runtime.settingsOpen) {
			providerEditor = null;
			untrack(() => {
				if (shouldDropConfirm('settings-closed', danger.dangerConfirm)) danger.clearDanger('provider');
			});
			return;
		}
		// A Bot or another window can delete the endpoint out from under an open confirm.
		const pending = untrack(() => danger.dangerConfirm);
		if (pending?.providerId && !snapshot.providers.some((row) => row.id === pending.providerId)) {
			danger.dangerConfirm = null;
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


	let previewPane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null>(null);

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
		};
		trackPointerDrag(handle, { move: onMove, end: onUp });
	}


	function closeSettings(): void {
		providerEditor = null;
		danger.clearDanger('provider');
		runtime.settingsOpen = false;
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

	/**
	 * `sessionId` is the conversation the profile opens beside on the workbench — the one it was
	 * asked for from, rather than whichever conversation the keyboard happens to be in.
	 */
	function openProfile(botId: string, sessionId?: string): void {
		if (!botsById.has(botId)) return;
		if (danger.dangerConfirm?.source !== 'menu') danger.clearDanger('bot');
		profileFailed = false;
		// The pane is keyed on the Bot, so opening or switching remounts it with a fresh draft.
		if (sessionId && runtime.paneOpener) {
			runtime.paneOpener({ kind: 'chat', sessionId, side: { kind: 'settings', botId } });
			return;
		}
		runtime.openProfile(botId);
	}

	/** A pane header's settings button: slide the conversation's settings over it, or close them. */
	function togglePaneSettings(sessionId: string): void {
		if (danger.dangerConfirm?.source !== 'menu') danger.clearDanger('bot');
		profileFailed = false;
		workbench.commitLayout(
			toggleChatSide(workbench.layout, sessionId, { kind: 'settings', botId: null }, { id: workbench.freshPaneId })
		);
	}

	function closePaneSide(sessionId: string): void {
		workbench.commitLayout(closeChatSide(workbench.layout, sessionId));
	}

	/**
	 * What a conversation's tab offers: the actions its header used to hold, under the tab's ⋯
	 * while the pointer is on the tab, and first in a right-click on the tab. Each acts on that
	 * tab's own conversation, which need not be the one in front: settings bring the tab forward
	 * first, since they slide over its transcript.
	 */
	function chatTabActions(leafId: string, tab: WorkbenchTab): TabAction[] {
		const content = contentOfTab(tab);
		if (content?.kind !== 'chat') return [];
		const session = sessionsById.get(content.sessionId);
		if (!session || isFileDropSession(session)) return [];
		const pinned = isSessionPinned(pinnedSessionIds, session.id);
		return [
			{
				id: 'pin',
				label: pinned ? t.top.unpin : t.top.pin,
				icon: pinned ? pinnedIcon : pinIcon,
				active: pinned,
				run: () => togglePin(session.id)
			},
			// The latest job's trace, board and plan, each a tab of its own.
			...([
				['trace', t.plan.segmentTrace, traceIcon],
				['board', t.plan.segmentBoard, boardIcon],
				['spec', t.plan.segmentSpec, specIcon]
			] as const).map(([view, label, icon]) => ({
				id: view,
				label,
				icon,
				run: () =>
					workbench.openGuarded({ kind: 'trace', sessionId: session.id, taskId: null, view, focus: null, focusNonce: null })
			})),
			{
				id: 'settings',
				label: classifySession(session) === 'group' ? t.top.groupSettings : t.top.botSettings,
				icon: settingsIcon,
				// A Bot opened from a group's member list is not the group's own settings.
				active: Boolean(content.side && !content.side.botId),
				run: () => {
					workbench.commitLayout(activateTab(focusLeaf(workbench.layout, leafId), leafId, tab.id));
					togglePaneSettings(session.id);
				}
			}
		];
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
		if (danger.dangerConfirm?.source !== 'menu') danger.clearDanger('bot');
		profileFailed = false;
	}

	function openCreateBot(): void {
		runtime.openCreateBot();
	}

	function openCreateGroup(): void {
		runtime.openCreateGroup();
	}

	const mobileNavigationVisible = $derived(
		!searchOpen &&
		!runtime.routinesOpen &&
		!runtime.spendOpen &&
		// The terminal is a full screen here, and the bar would sit on top of its key row.
		!runtime.terminalOpen &&
		// So is the Mac's screen, with its own key row.
		!runtime.screenOpen &&
		!runtime.createBotOpen && !runtime.createGroupOpen && !runtime.sessionSettingsOpen &&
		!runtime.profileBotId && !danger.dangerConfirm &&
		(runtime.settingsOpen ? !mobileSettingsDetail && !providerEditor : runtime.workspaceOpen || (!selected && !artifact.artifactPreview))
	);
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && !e.isComposing && fullscreenPreviewOpen()) {
			// Escape typed into a file's editor is the editor's, as in the conversation's preview.
			if ((e.target as HTMLElement | null)?.closest?.('.monaco-editor, .editor-widget.find-widget, .artifact-cm')) return;
			closeFullscreenPreview();
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}
		if (searchOpen) {
			if (e.key === 'Escape' && !e.isComposing) closeGlobalSearch();
			return;
		}
		if (e.key === 'Escape') {
			if (toolsMenuOpen) {
				toolsMenuOpen = false;
			} else if (createMenuOpen) {
				createMenuOpen = false;
			} else if (danger.escapeDismissesDanger) {
				danger.dismissDangerConfirm();
			} else if (runtime.createBotOpen) {
				runtime.createBotOpen = false;
			} else if (runtime.createGroupOpen) {
				runtime.createGroupOpen = false;
			} else if (providerEditor) {
				e.stopPropagation();
				settingsModal?.backFromProviderEditor();
			} else if (danger.confirmingIndependent) {
				e.stopPropagation();

			} else if (runtime.settingsOpen) {
				closeSettings();
			} else if (runtime.sessionSettingsOpen && nestedProfile) {
				closeNestedProfile();
			} else if (runtime.sessionSettingsOpen && profilePane?.backFromEditor()) {
				// The routine page (or a skill sheet) closes before the drawer does.
			} else if (runtime.sessionSettingsOpen) {
				runtime.closeSessionSettings();
			} else if (runtime.terminalOpen) {
				runtime.closeTerminal();
			} else if (runtime.screenOpen) {
				runtime.closeRemoteScreen();
			} else if (runtime.traceOpen && !artifact.artifactPreview) {
				// A file opened from the flow lies over it, so the preview below closes first.
				runtime.closeTrace();
			} else if (runtime.routinesOpen) {
				runtime.closeRoutines();
			} else if (runtime.spendOpen) {
				runtime.closeSpend();
			} else if (runtime.workspaceOpen) {
				if (workspacePane?.closeFind()) {
					e.preventDefault();
					e.stopPropagation();
				} else if (workspacePane) {
					workspacePane.requestCloseFromParent();
				} else {
					runtime.closeWorkspace();
				}
			} else if (artifact.artifactPreview) {
				const target = e.target as HTMLElement | null;
				if (previewPane?.closeFind()) {
					e.preventDefault();
					e.stopPropagation();
				} else if (target?.closest('.monaco-editor, .editor-widget.find-widget, .artifact-cm')) {
					return;
				} else if (previewPane) previewPane.requestCloseFromParent();
				else artifact.closeArtifactPreview();
			}
		}
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
			const target = e.target as HTMLElement | null;
			if (isTypingTarget(target)) return;
			if (!snapshot.settings.workspace_path) return;
			e.preventDefault();
			artifact.toggleWorkspaceExplorer();
			return;
		}
		// From anywhere, typing included, but not out of a terminal off the Mac (see matchesSidebarToggle).
		if (sidebarColumn && matchesSidebarToggle(e)) {
			e.preventDefault();
			toggleSidebar();
			return;
		}
		// Off the Mac the window's menu never sees Ctrl+W while the page has focus; see matchesCloseTab.
		if (wide && isTauri() && matchesCloseTab(e)) {
			e.preventDefault();
			workbench.runMenuCommand('pane-close-tab');
			return;
		}
		// After the Escape chain and ⌘O, so neither can be taken out from under them.
		if (wide) {
			const command = matchWorkbenchKey(e);
			if (command) {
				e.preventDefault();
				workbench.runWorkbenchCommand(command);
			}
		}
	}}
/>

<!-- The pictures of a conversation tab's actions, the same ones its header draws. -->
{#snippet pinIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<line x1="12" y1="17" x2="12" y2="22"></line>
		<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
	</svg>
{/snippet}
{#snippet pinnedIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<line x1="12" y1="17" x2="12" y2="22"></line>
		<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
	</svg>
{/snippet}
{#snippet traceIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<rect x="8" y="2" width="8" height="6" rx="1.5"></rect>
		<path d="M12 8v3"></path>
		<path d="M5.5 14v-3h13v3"></path>
		<rect x="2" y="14" width="7" height="6" rx="1.5"></rect>
		<rect x="15" y="14" width="7" height="6" rx="1.5"></rect>
	</svg>
{/snippet}
{#snippet boardIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<rect x="3" y="3" width="5" height="18" rx="1"></rect>
		<rect x="10" y="3" width="5" height="12" rx="1"></rect>
		<rect x="17" y="3" width="4" height="8" rx="1"></rect>
	</svg>
{/snippet}
{#snippet specIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
		<polyline points="14 2 14 8 20 8"></polyline>
		<line x1="16" y1="13" x2="8" y2="13"></line>
		<line x1="16" y1="17" x2="8" y2="17"></line>
	</svg>
{/snippet}
{#snippet settingsIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"></circle>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
	</svg>
{/snippet}

<!--
	A conversation's settings, sliding over its transcript on the workbench. Drawn here rather than
	in the pane host because they run on state this file holds one copy of — the unsaved draft,
	which danger confirm is armed — which is also why only one conversation has them open at a time.
	With no Bot named, a direct conversation shows its Bot and a group its own settings. A Bot
	picked from a group is simply that Bot's settings: no way back to the group's, the ✕ or the
	scrim closes it.
-->
{#snippet paneSettings(sessionId: string, botId: string | null)}
	{@render sessionSettings({ sessionId, botId })}
{/snippet}

<!-- The drawer over the shell when `beside` is null; see `panels/SessionSettingsDrawer.svelte`. -->
{#snippet sessionSettings(beside: { sessionId: string; botId: string | null } | null)}
	<SessionSettingsDrawer
		{beside}
		{runtime}
		{t}
		{narrow}
		{botsById}
		{sessionsById}
		{availableModelOptions}
		{danger}
		{openProfile}
		{closePaneSide}
		{selected}
		{selectedKind}
		{nestedProfile}
		{profileBot}
		{profileBackdrop}
		{closeNestedProfile}
		{closeCurrentDrawerScreen}
		bind:profilePane
		bind:profileFailed
		bind:paneMobileDetail
		bind:groupDetail
	/>
{/snippet}

{#if showOnboarding}
	<Onboarding {runtime} bind:holding={onboardingHeld} onDismiss={() => (dismissedOnboarding = true)} />
{:else}
<ImageCopy {t} />
<WorkspaceDragGhost />
{#if searchOpen}
	<GlobalSearch bind:this={searchDialog} {runtime} {t} opener={searchOpener} onClose={closeGlobalSearch} onSelect={selectSearchHit} />
{/if}
<div
	class="shell"
	class:has-mobile-navigation={mobileNavigationVisible}
	class:is-thread={runtime.threadOpen}
	class:has-session={Boolean(selected)}
	class:has-routines={runtime.routinesOpen}
	class:has-spend={runtime.spendOpen}
	class:has-terminal={runtime.terminalOpen}
	class:has-screen={runtime.screenOpen}
	class:is-preview={Boolean(artifact.artifactPreview)}
	class:is-preview-dragging={artifact.previewDragging}
	class:is-layered={!wide}
	class:is-sidebar-dragging={sidebarDragging}
	class:is-sidebar-collapsed={sidebarHidden}
	bind:this={shellEl}
	style:--preview-width="{artifact.previewWidth}px"
	style:--sidebar-width="{sidebarHidden ? SIDEBAR_RAIL : sidebarWidth}px"
	style:--sidebar-split={sidebarHidden ? '0px' : undefined}
>
	{#if sidebarHidden}
		<SidebarRail
			{runtime}
			{t}
			{pinnedSessionIds}
			bind:toolsMenuOpen
			workspaceOpen={runtime.workspaceOpen}
			contextMenuSessionId={sessionMenu.contextMenu?.session.id ?? null}
			onOpenContextMenu={sessionMenu.openContextMenu}
			onExpand={toggleSidebar}
			onOpenSearch={openGlobalSearch}
			onToggleWorkspace={artifact.toggleWorkspaceExplorer}
			onOpenRoutines={artifact.openRoutinesFromUi}
			onOpenSpend={artifact.openSpendFromUi}
			workbench={wide}
			onNewTerminal={() => void workbench.openNewTerminal(null)}
			onOpenArchived={openArchivedFromRail}
			onOpenSettings={() => runtime.openSettings()}
		/>
	{:else}
		<Sidebar
			bind:this={sidebar}
			{runtime}
			{t}
			{selected}
			{pinnedSessionIds}
			bind:toolsMenuOpen
			{searchOpen}
			onOpenSearch={openGlobalSearch}
			bind:createMenuOpen
			workspaceOpen={runtime.workspaceOpen}
			contextMenuSessionId={sessionMenu.contextMenu?.session.id ?? null}
			onOpenContextMenu={sessionMenu.openContextMenu}
			onToggleWorkspace={artifact.toggleWorkspaceExplorer}
			onOpenRoutines={artifact.openRoutinesFromUi}
			onOpenSpend={artifact.openSpendFromUi}
			workbench={wide}
			onNewTerminal={() => void workbench.openNewTerminal(null)}
			onOpenSettings={() => runtime.openSettings()}
			onCreateBot={openCreateBot}
			onCreateGroup={openCreateGroup}
			onCollapse={sidebarColumn ? toggleSidebar : undefined}
		/>
	{/if}
	<button
		type="button"
		class="sidebar-split"
		aria-label={t.sidebar.resize}
		onpointerdown={startSidebarResize}
	></button>
	<section class="main flex flex-col min-w-0 min-h-0 bg-pane relative">
		{#if wide}
			<Workbench
				layout={workbench.layout}
				mins={paneMin}
				{t}
				wide={true}
				tabName={workbench.paneTitle}
				tabActions={chatTabActions}
				onLayout={workbench.commitLayout}
				onViewport={workbench.setViewport}
				onFloatAdjusted={workbench.rememberFloat}
				onActivate={(leafId, tabId) => workbench.commitLayout(activateTab(workbench.layout, leafId, tabId))}
				onCloseTab={workbench.onPaneCloseTab}
				onCloseTabs={workbench.onPaneCloseTabs}
				onClosePane={workbench.onPaneClose}
			>
				{#snippet tabBody(tab: WorkbenchTab, leafId: string)}
					<PaneContentHost
						{tab}
						{leafId}
						{runtime}
						{t}
						onOpenProfile={openProfile}
						onOpenArtifact={artifact.openArtifactPath}
						onRemoveTab={workbench.onPaneCloseTab}
						onBindTerminal={workbench.bindTerminalTab}
						onUpdateContent={(content) =>
							workbench.commitLayout(replaceTabParams(workbench.layout, leafId, tab.id, contentToParams(content)))}
						onOpenContent={workbench.openGuarded}
						onPreviewPane={workbench.trackPreviewPane}
						onJump={jumpToTrace}
						onCloseSide={closePaneSide}
						settingsSide={paneSettings}
					/>
				{/snippet}
				{#snippet tabLabel(tab: WorkbenchTab)}
					{@const tabContent = contentOfTab(tab)}
					{@const tabSession = tabContent?.kind === 'chat' ? sessionsById.get(tabContent.sessionId) : undefined}
					{#if tabSession}
						<ChatTabLabel {runtime} {t} session={tabSession} title={workbench.paneTitle(tab)} />
					{:else}
						<PaneTabLabel
							kind={tabContent?.kind ?? null}
							traceView={tabContent?.kind === 'trace' ? tabContent.view : undefined}
							title={workbench.paneTitle(tab)}
						/>
					{/if}
				{/snippet}
				{#snippet emptyActions(leafId: string)}
					<button type="button" class="pane-open" onclick={() => void workbench.openNewTerminal(leafId)}>
						{t.terminal.newTab}
					</button>
					{#each workbench.untabbedTerminals as row (row.id)}
						<button
							type="button"
							class="pane-open is-reattach"
							title={row.cwd}
							onclick={() => workbench.openInPane(leafId, { kind: 'terminal', terminalId: row.id })}
						>
							{t.terminal.reattach(workbench.terminalName(row))}
						</button>
					{/each}
					<button
						type="button"
						class="pane-open"
						disabled={!snapshot.settings.workspace_path}
						onclick={() => workbench.openInPane(leafId, { kind: 'workspace', selected: null })}
					>
						{t.sidebar.workspace}
					</button>
					<button type="button" class="pane-open" onclick={() => workbench.openInPane(leafId, { kind: 'routines' })}>
						{t.routines.title}
					</button>
					<button type="button" class="pane-open" onclick={() => workbench.openInPane(leafId, { kind: 'spend' })}>
						{spendCopyFor(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh').title}
					</button>
				{/snippet}
				{#snippet menuActions(leafId: string, query: string)}
					<NewPaneMenu {runtime} {t} {workbench} {leafId} {query} />
				{/snippet}
			</Workbench>
		{:else if runtime.routinesOpen}
			{#await import('./calendar/RoutineCalendar.svelte') then { default: RoutineCalendar }}
				<RoutineCalendar {runtime} {t} />
			{/await}
		{:else if runtime.spendOpen}
			{#await import('./spend/SpendOverlay.svelte') then { default: SpendOverlay }}
				<SpendOverlay {runtime} backLabel={t.common.back} />
			{/await}
		{:else if runtime.terminalOpen}
			<!--
				Keyed so the page that is walking out is a different block from the one that
				arrives. Without it, Svelte reuses the leaving page, its outro never finishes,
				and the terminal stays on screen after Back.
			-->
			{#key runtime.terminalOpen}
			<div class="terminal-page" transition:pageSlide>
				<TerminalPane
					api={runtime.client}
					workspacePath={snapshot.settings.workspace_path}
					rows={runtime.terminals}
					{t}
					onStream={(id, sink) => runtime.onStream(id, sink)}
					onChanged={() => runtime.refreshTerminals()}
					onClose={() => runtime.closeTerminal()}
				/>
			</div>
			{/key}
		{:else if runtime.screenOpen && runtime.client?.kind === 'remote'}
			{#key runtime.screenOpen}
			<div class="screen-page" transition:pageSlide>
				{#await import('./overlays/RemoteScreenPane.svelte') then { default: RemoteScreenPane }}
					<RemoteScreenPane api={runtime.client} {t} onClose={() => runtime.closeRemoteScreen()} />
				{/await}
			</div>
			{/key}
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
			onOpenArtifact={artifact.openArtifactPath}
			onCreateBot={openCreateBot}
		/>
		</div>
		{:else if wide}
		<!--
			The empty column is the desktop's "pick a session". A phone's home screen is the
			roster, and mounting this beside the page that is walking out flashes it through.
		-->
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
			onOpenArtifact={artifact.openArtifactPath}
			onCreateBot={openCreateBot}
		/>
		{/if}
	</section>
	<ShellPreview {runtime} {t} {wide} {locale} {botsById} {artifact} bind:previewPane />
	{#if runtime.traceOpen && selected}
		{#await import('./overlays/TaskTrace.svelte') then { default: TaskTraceView }}
			<TaskTraceView
				api={runtime.client}
				taskId={runtime.traceTaskId || null}
				focus={runtime.traceFocus}
				focusToken={runtime.traceFocusToken}
				sessionId={runtime.traceSessionId || selected.id}
				activeSessionId={selected.id}
				sessions={snapshot.sessions}
				bots={snapshot.bots}
				providers={snapshot.providers}
				youLabel={t.common.you}
				deletedLabel={t.top.deleted}
				workspacePath={snapshot.settings.workspace_path}
				{t}
				reloadToken={runtime.traceReload}
				onClose={() => runtime.closeTrace()}
				onJump={jumpFromTracePage}
				onOpenArtifact={artifact.openArtifactPath}
				holds={snapshot.holdsOn ? snapshot.holds : null}
				onStop={(choice) => runtime.stopScope(choice.scope, choice.id, runtime.traceSessionId || selected.id)}
				onLift={(hold) => runtime.liftHold(hold.id)}
				controlsDisabled={runtime.connection !== 'connected'}
				onTask={(id) => {
					if (runtime.traceTaskId !== id) runtime.traceTaskId = id;
				}}
			/>
		{/await}
	{/if}
	{#if runtime.workspaceOpen}
		<WorkspaceExplorer
			bind:this={workspacePane}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			selected={runtime.workspaceSelected}
			{t}
			onClose={artifact.closeWorkspaceExplorer}
			onOpenSettings={() => navigateMobile('settings')}
			onOpenTerminal={artifact.openTerminalFromWorkspace}
			onSelect={artifact.openWorkspaceFile}
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
	{@render sessionSettings(null)}
	{#if dangerConfirmCopy}
		<DangerDialog
			copy={dangerConfirmCopy}
			{t}
			onDismiss={() => danger.dismissDangerConfirm()}
			busy={Boolean(danger.dangerConfirm?.running)}
			optionChecked={danger.dangerConfirm?.eraseQuotes ?? false}
			onOptionChange={(checked) => danger.setDangerOption(checked)}
			onConfirm={() => void danger.confirmDanger()}
		/>
	{/if}
	{#if mobileNavigationVisible}
		<MobileNavigation active={mobileDestination} {t} updateAvailable={updateChecker.updateVisible} onNavigate={navigateMobile} />
	{/if}
	{#if settingsEverOpened}
		{#await import('./settings/SettingsModal.svelte') then { default: SettingsModal }}
			<SettingsModal
				bind:this={settingsModal}
				bind:mobileSettingsDetail
				{runtime}
				{t}
				bind:saveFailed
				bind:providerEditor
				confirmingProvider={danger.dangerConfirm?.kind === 'provider'}
				bind:confirmingIndependent={danger.confirmingIndependent}
				{patchImmediate}
				openDeleteProviderConfirm={(id) => danger.openDeleteProviderConfirm(id)}
				{closeSettings}
				workbench={wide}
			/>
		{/await}
	{/if}
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

	{#if sessionMenu.contextMenu}
		{@const activeMenu = sessionMenu.contextMenu}
		<SessionContextMenu
			session={activeMenu.session}
			{botsById}
			isPinned={isSessionPinned(pinnedSessionIds, activeMenu.session.id)}
			x={activeMenu.x}
			y={activeMenu.y}
			{t}
			onClose={sessionMenu.closeContextMenu}
			onTogglePin={() => sessionMenu.handleMenuTogglePin(activeMenu.session.id)}
			onViewInfo={() => void sessionMenu.handleMenuViewInfo(activeMenu.session)}
			onClearHistory={() => sessionMenu.handleMenuClearHistory(activeMenu.session)}
			onToggleArchive={() => void sessionMenu.handleMenuToggleArchive(activeMenu.session)}
			onDelete={() => sessionMenu.handleMenuDelete(activeMenu.session)}
			onShowJobView={(view) => void sessionMenu.handleMenuShowJobView(activeMenu.session, view)}
		/>
	{/if}
</div>
{/if}

<style>
	@media (max-width: 680px) {
		.shell.has-mobile-navigation > :global(.side) { padding-bottom: calc(60px + env(safe-area-inset-bottom)); }

	}

	.pane-open {
		min-height: 32px;
		padding: 6px 14px;
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--line);
		cursor: pointer;
	}
	.pane-open:disabled {
		color: var(--muted);
		cursor: default;
	}
	.pane-open:not(:disabled):hover {
		background: var(--row-hover);
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
		border-radius: var(--radius-full);
	}

	.sidebar-split:hover::before,
	.shell.is-sidebar-dragging .sidebar-split::before {
		background: var(--accent);
		inset: 0 2px;
	}

	/* The rail has its own edge and nothing to drag. */
	.shell.is-sidebar-collapsed .sidebar-split {
		visibility: hidden;
		pointer-events: none;
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
		box-shadow: -4px 0 16px rgba(18, 28, 32, 0.04);
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

	/*
	 * The column's own width, not the window's, decides when a conversation takes the phone
	 * layout (see `.pane-conversation` for a pane of the workbench). A size query only: unlike
	 * `contain`, it does not re-anchor the `fixed` menus placed from `clientX` / `clientY`.
	 */
	.main {
		container: conversation / inline-size;
	}

	/* Shell Layout */
	.shell {
		height: 100%;
		display: grid;
		grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 0fr;
		background: var(--bg);
		color: var(--ink);
		position: relative;
		transition: grid-template-columns 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.shell.is-thread {
		grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 320px;
	}

	.shell.is-preview {
		grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 8px var(--preview-width, 420px) 0fr;
	}

	.shell.is-preview.is-thread {
		grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 8px var(--preview-width, 420px) 320px;
	}

	/*
	 * The layered shell — a narrow window, or the hosted messenger at any width — has no workbench,
	 * so its artifact pane is a screen of its own like the phone's, not a column beside the chat.
	 * These sit in a min-width media query on purpose: below 680px the phone block further down
	 * already does all of this, and it wins by being later in the file only while these cannot
	 * match, since a class here is the more specific selector.
	 */
	@media (min-width: 681px) {
		.shell.is-layered.is-preview,
		.shell.is-layered.is-preview.is-thread {
			grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 0fr;
		}

		.shell.is-layered.is-preview.is-thread {
			grid-template-columns: var(--sidebar-width, 260px) var(--sidebar-split, 8px) minmax(0, 1fr) 320px;
		}

		/* Without this the thread would sit in the sixth column the rules above just removed. */
		.shell.is-layered.is-preview .thread {
			grid-column: 4;
		}

		/* Over everything, the way the phone block below lays it: a layer, not a row of the grid. */
		.shell.is-layered.is-preview :global(.artifact-pane) {
			position: fixed;
			inset: 0;
			z-index: 80;
		}
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
		 * column then would cancel that walk before it painted. Below the tab bar (z 105) while
		 * the conversation is open.
		 */
		.shell:has(.conversation) .main,
		.shell:has(.terminal-page) .main,
		.shell:has(.screen-page) .main,
		.shell.has-routines .main,
		.shell.has-spend .main,
		.shell.has-terminal .main,
		.shell.has-screen .main {
			position: fixed;
			inset: 0;
			z-index: 30;
			display: flex;
			min-width: 0;
		}

		/*
		 * Leaving: the page is position:fixed, so it no longer needs this column. Keeping the
		 * column would leave an empty layer over the list. `contents` drops that layer; the
		 * page below paints on its own, over the tab bar only where it still is.
		 */
		.shell:not(.has-session):has(.conversation) .main {
			display: contents;
		}

		/*
		 * The page fills the column. `inset` would pin it to the column it was measured in, and
		 * a percentage translate then slides a box that is shorter than the screen.
		 */
		.conversation {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: 1;
			display: flex;
			flex-direction: column;
			min-width: 0;
			min-height: 0;
			background: var(--pane);
		}

		/* Over the tab bar (z 105) for the walk out, fixed to the viewport so it stays full screen. */
		.shell:not(.has-session) .conversation,
		.shell:not(.has-terminal) .terminal-page {
			position: fixed;
			z-index: 106;
		}

		.shell.has-routines .main,
		.shell.has-spend .main,
		.shell.has-terminal .main {
			background: var(--pane);
		}

		.terminal-page {
			position: absolute;
			inset: 0;
			z-index: 2;
			display: flex;
			flex-direction: column;
			min-width: 0;
			min-height: 0;
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
			z-index: 80;
		}
	}

	/*
	 * The Mac's screen takes the whole viewport at every width: over the tab bar on a phone,
	 * and over both columns on a tablet, where every pixel of the Mac is worth having.
	 */
	.screen-page {
		position: fixed;
		inset: 0;
		z-index: 106;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--pane);
	}
</style>
