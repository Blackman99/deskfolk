<script lang="ts">
	import {
		USER_MEMBER,
		type Attachment,
		type Bot,
		type SessionSummary,
		type Terminal
	} from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import { composerLocked } from './chat/composer-mode.ts';
	import { copyFor } from './copy.ts';
	import ImageCopy from './ImageCopy.svelte';
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
	import TerminalPane from './overlays/TerminalPane.svelte';
	import { orderTerminals, statusLabel, terminalNames } from './overlays/terminals.ts';
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
	import { sanitizePreviewPath } from './session-url.ts';
	import { backdropClick } from './click-outside.ts';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import SessionContextMenu from './sidebar/SessionContextMenu.svelte';
	import { deriveSessionContextMenu } from './sidebar/session-context-menu.ts';
	import { handedOverPaths } from './overlays/artifacts.ts';
	// ArtifactPreview.svelte is lazy-loaded below (see the artifactPreview block): it only
	// mounts once a file is actually opened.
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
	import GroupIdentity from './panels/GroupIdentity.svelte';
	import GroupPane from './panels/GroupPane.svelte';
	import type { GroupDetailDraft } from './panels/group-edit.ts';
	import ProfilePane from './panels/ProfilePane.svelte';
	import Sidebar from './sidebar/Sidebar.svelte';
	import MobileNavigation from './MobileNavigation.svelte';
	import { topLayer, type MobileDestination } from './mobile-route.ts';
	import { pageSlide } from './mobile-page-slide.ts';
	import { updateChecker } from './update-checker.svelte.ts';
	// RoutineCalendar.svelte pulls in svelte5plus-calendar; it is loaded lazily below, only once
	// `runtime.routinesOpen` is true.
	import Workbench from './workbench/Workbench.svelte';
	import PaneContentHost from './workbench/PaneContentHost.svelte';
	import { isWorkbenchSurface, watchNarrow } from './workbench/surface.ts';
	import { paneMin } from './workbench/pane-mins.ts';
	import { contentOfTab } from './workbench/pane-content.ts';
	import {
		activeSessionId,
		closeChatSide,
		dropDuplicateBoundTabs,
		existingTarget,
		findKind,
		openContent,
		settingsSide,
		toggleChatSide
	} from './workbench/pane-open.ts';
	import type { PreviewHandle } from './workbench/preview-context.ts';
	import type { PaneContent } from './workbench/pane-content.ts';
	import {
		MENU_COMMANDS,
		applyCommand,
		isTypingTarget,
		matchWorkbenchKey,
		type CommandContext,
		type WorkbenchCommand
	} from './workbench/workbench-commands.ts';
	import { hideDesktopWindow, listenToWindow } from './tauri.ts';
	import { allLeaves, emptyLayout as freshLayout } from './workbench/layout-tree.ts';
	import {
		closeTab as closeWorkbenchTab,
		activateTab,
		emptyLayout,
		focusLeaf,
		leafById,
		replaceTabParams,
		splitLeaf
	} from './workbench/layout-tree.ts';
	import { healLayout, loadWorkbenchLayout, saveWorkbenchLayout } from './workbench/workbench-layout.ts';
	import { contentsEqual, contentToParams, PANE_KIND_SET } from './workbench/pane-content.ts';
	import { WB_FALLBACK_MIN } from './workbench/pane-mins.ts';
	import type { WorkbenchLayout, WorkbenchTab } from './workbench/layout-types.ts';
	import ChatHeader from './chat/ChatHeader.svelte';
	import ChatStage from './chat/ChatStage.svelte';
	// SettingsModal.svelte (~3.5k lines, plus its provider/MCP/notification sub-panels) is
	// loaded lazily below on first `runtime.settingsOpen`, and stays mounted after that — its own
	// template is already gated on `runtime.settingsOpen` (see settingsHead/`{#if runtime.settingsOpen}`
	// inside that file), so deferring the mount changes nothing but when the bytes are fetched.
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
				settingsModal?.backFromProviderEditor();
				return true;
			case 'independent-confirm':
				return true;
			case 'search-page':
				return sidebar?.closeSearchPage() ?? false;
			case 'settings':
				// Only its inner pages are ours to unwind; settings itself is an entry in history.
				return settingsModal?.backWithinSettings() ?? false;
			case 'session-settings':
				// The skill sheet and the section list are not in the URL. A Bot opened from a
				// group is its own settings page, so Back leaves for the conversation.
				if (nestedProfile) return false;
				if (profilePane?.backFromEditor()) return true;
				if (paneMobileDetail) {
					paneMobileDetail = false;
					return true;
				}
				return false;
			case 'terminal':
				runtime.closeTerminal();
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
	/**
	 * The desktop workbench. Above the narrow breakpoint the main column is a tree of panes; at or
	 * below it the app is what it has always been, one screen at a time with a back stack, and
	 * none of this renders.
	 */
	let narrow = $state(false);
	$effect(() => watchNarrow((value) => (narrow = value)));
	const wide = $derived(isWorkbenchSurface(narrow));
	let layout = $state<WorkbenchLayout>(loadWorkbenchLayout() ?? emptyLayout('wb-root'));
	let paneSeq = 0;
	const freshPaneId = () => `wb-${Date.now().toString(36)}-${++paneSeq}`;

	function commitLayout(next: WorkbenchLayout): void {
		if (next === layout) return;
		layout = next;
		saveWorkbenchLayout(next);
	}

	/**
	 * The two directions the conversation and the arrangement follow each other.
	 *
	 * Each tracks only its own side. Tracking both makes them fight — the same shape of bug the
	 * URL effects in `+page.svelte` carry a comment about — and each is a no-op once the two
	 * already agree, so they settle rather than ping-pong.
	 */
	$effect(() => {
		if (!wide) return;
		const id = runtime.selectedId;
		if (!id) return;
		untrack(() => {
			if (activeSessionId(layout) === id) return;
			commitLayout(
				openContent(layout, { kind: 'chat', sessionId: id }, { id: freshPaneId, replaceActive: true })
			);
		});
	});

	/**
	 * Terminal tabs name sessions the snapshot does not carry, so the list is read as soon as the
	 * workbench is connected — and again after a reconnect — rather than when a terminal opens.
	 */
	$effect(() => {
		if (!wide || runtime.connection !== 'connected') return;
		untrack(() => void runtime.refreshTerminals());
	});

	/** Drop tabs whose conversation or terminal has gone, the way pinned rows are cleaned. */
	$effect(() => {
		const live = {
			sessionIds: new Set(snapshot.sessions.map((row) => row.id)),
			terminalIds: runtime.terminalsLoaded ? new Set(runtime.terminals.map((row) => row.id)) : null,
			knownKinds: PANE_KIND_SET
		};
		const viewport = { x: 0, y: 0, width: shellWidth, height: 800 };
		untrack(() => {
			const healed = dropDuplicateBoundTabs(
				healLayout(layout, live, viewport, WB_FALLBACK_MIN, freshPaneId()),
				freshPaneId
			);
			if (healed !== layout) commitLayout(healed);
		});
	});

	/** What a tab is called. The layout carries ids; the names come from what they point at. */
	function paneTitle(tab: WorkbenchTab): string {
		const content = contentOfTab(tab);
		if (!content) return t.pane.title;
		switch (content.kind) {
			case 'chat':
				return sessionName(content.sessionId);
			case 'terminal': {
				const row = runtime.terminals.find((candidate) => candidate.id === content.terminalId);
				return row ? (terminalNamesById.get(row.id) ?? row.title) : t.terminal.title;
			}
			case 'workspace':
				return content.selected ? (content.selected.split('/').pop() ?? t.sidebar.workspace) : t.sidebar.workspace;
			case 'routines':
				return t.routines.title;
			case 'trace':
				return t.pane.flowOf(sessionName(content.sessionId));
			case 'preview':
				return content.sessionId ? t.pane.artifactsOf(sessionName(content.sessionId)) : t.pane.title;
		}
	}

	/** The conversation's own name, the same words its chat tab uses. */
	function sessionName(sessionId: string): string {
		const session = snapshot.sessions.find((row) => row.id === sessionId);
		return session ? titleOf(session) : t.top.deleted;
	}

	/**
	 * While the workbench is on, every "open this" in the app lands in a pane rather than in a
	 * full-screen layer. Cleared below the breakpoint, where those layers are still the app.
	 */
	$effect(() => {
		if (!wide) {
			runtime.paneOpener = null;
			return;
		}
		runtime.paneOpener = (content) => {
			untrack(() => {
				// "The terminal", asked for without naming one, is the one you have if there is one.
				if (content.kind === 'terminal' && !content.terminalId) void showTerminal();
				else openGuarded(ownSettings(content));
			});
		};
		return () => {
			runtime.paneOpener = null;
		};
	});

	/**
	 * A direct conversation's own settings are its Bot's profile, however they were asked for — the
	 * header's button or the Bot's avatar in the transcript. One spelling, so the header can tell
	 * they are open and toggling them finds them.
	 */
	function ownSettings(content: PaneContent): PaneContent {
		if (content.kind !== 'chat' || content.side?.kind !== 'settings' || !content.side.botId) return content;
		const session = sessionsById.get(content.sessionId);
		if (!session || classifySession(session) !== 'you-bot' || youBotPeer(session) !== content.side.botId) return content;
		return { ...content, side: { kind: 'settings', botId: null } };
	}

	/** The previews on screen, by tab, so one holding an unsaved edit can be asked before it turns. */
	const previewPanes = new Map<string, PreviewHandle>();

	function trackPreviewPane(tabId: string, pane: PreviewHandle | null): void {
		if (pane) previewPanes.set(tabId, pane);
		else previewPanes.delete(tabId);
	}

	/**
	 * Open through the layout, asking first when this would turn a conversation's preview away
	 * from a file with an unsaved edit. That preview is its conversation's only one, so "open
	 * beside it instead" is not on offer; its own save / discard / cancel question decides.
	 */
	function openGuarded(content: PaneContent): void {
		const open = () => commitLayout(openContent(layout, content, { id: freshPaneId }));
		const at = existingTarget(layout, content);
		const pane = at ? previewPanes.get(at.tab.id) : undefined;
		const current = at ? contentOfTab(at.tab) : null;
		if (at && pane?.blocksClose() && !(current && contentsEqual(current, content))) {
			// Bring the question to where the keyboard is, then turn only once it is answered.
			commitLayout(activateTab(focusLeaf(layout, at.leafId), at.leafId, at.tab.id));
			pane.requestLeaveFromParent(open);
			return;
		}
		open();
	}

	/** Fill a pane from its own empty state: whatever you pick lands in that pane, not elsewhere. */
	function openInPane(leafId: string, content: PaneContent): void {
		const focused = focusLeaf(layout, leafId);
		commitLayout(openContent(focused, content, { id: freshPaneId, replaceActive: true }));
	}

	/**
	 * A terminal tab is one shell. A new tab starts its own and is bound to it before it shows, so
	 * two tabs are never the same terminal. If it cannot start one it opens anyway and says why.
	 */
	async function openNewTerminal(leafId: string | null): Promise<void> {
		const created = await runtime.startTerminal();
		const content: PaneContent = {
			kind: 'terminal',
			terminalId: created?.id ?? null,
			cwd: created?.cwd ?? null
		};
		if (leafId && leafById(layout, leafId)) openInPane(leafId, content);
		else commitLayout(openContent(layout, content, { id: freshPaneId }));
	}

	/** The sidebar's terminal button: the terminal tab you have, nearest first, or a new one. */
	async function showTerminal(): Promise<void> {
		const open = findKind(layout, 'terminal');
		if (open) {
			commitLayout(activateTab(focusLeaf(layout, open.leafId), open.leafId, open.tab.id));
			return;
		}
		await openNewTerminal(null);
	}

	/**
	 * Sessions no tab shows. Closing a terminal tab never stops its shell, and a phone can start one,
	 * so what is still there has to be reachable from where you open things.
	 */
	const untabbedTerminals = $derived.by(() => {
		const shown = new Set(
			allLeaves(layout)
				.flatMap((leaf) => leaf.tabs)
				.filter((tab) => tab.kind === 'terminal')
				.map((tab) => tab.params.terminalId)
		);
		return orderTerminals(runtime.terminals.filter((row) => !shown.has(row.id)));
	});
	const terminalNamesById = $derived(terminalNames(runtime.terminals));

	/** A session's name, and how it ended when it has. */
	function terminalName(row: Terminal): string {
		const name = terminalNamesById.get(row.id) ?? row.title;
		const status = statusLabel(row, t);
		return status ? `${name} · ${status}` : name;
	}

	/** Write the session a terminal pane settled on back into its tab, so a restart comes back to it. */
	function bindTerminalTab(leafId: string, tabId: string, terminalId: string | null): void {
		const leaf = leafById(layout, leafId);
		const tab = leaf?.tabs.find((candidate) => candidate.id === tabId);
		if (!tab || tab.kind !== 'terminal') return;
		if ((tab.params.terminalId ?? null) === terminalId) return;
		const cwd = (terminalId && runtime.terminals.find((row) => row.id === terminalId)?.cwd) || tab.params.cwd;
		const params: Record<string, string> = {};
		if (terminalId) params.terminalId = terminalId;
		if (cwd) params.cwd = cwd;
		commitLayout(replaceTabParams(layout, leafId, tabId, params));
	}

	function runWorkbenchCommand(command: WorkbenchCommand): void {
		commitLayout(
			applyCommand(layout, command, workbenchCommandContext(), (current, leafId, axis, side) =>
				splitLeaf(current, leafId, axis, side, [], { leaf: freshPaneId(), branch: freshPaneId() })
			)
		);
	}

	/**
	 * The native menu owns its accelerators, so a command picked there is handed to the page
	 * rather than guessed at by it. ⌘W closes the tab in front of you and, once there is nothing
	 * left to close, asks the window to hide — which is what 关窗 has always meant.
	 */
	$effect(() => {
		if (!wide) return;
		return listenToWindow('pane-command', (id) => {
			if (id === 'pane-reset') {
				commitLayout(freshLayout(freshPaneId()));
				return;
			}
			if (id === 'pane-close-tab' && allLeaves(layout).every((leaf) => leaf.tabs.length === 0)) {
				void hideDesktopWindow();
				return;
			}
			const command = typeof id === 'string' ? MENU_COMMANDS[id] : undefined;
			if (command) runWorkbenchCommand(command);
		});
	});

	function workbenchCommandContext(): CommandContext {
		return {
			viewport: { x: 0, y: 0, width: shellWidth, height: shellEl?.clientHeight || 800 },
			mins: paneMin,
			ids: freshPaneId,
			newPaneMin: WB_FALLBACK_MIN
		};
	}

	function onPaneCloseTab(leafId: string, tabId: string): void {
		commitLayout(closeWorkbenchTab(layout, leafId, tabId, freshPaneId()));
	}

	/** Following the active pane keeps Stop, the composer and the URL pointing at one conversation. */
	$effect(() => {
		if (!wide) return;
		const id = activeSessionId(layout);
		untrack(() => {
			if (id && runtime.selectedId !== id) void runtime.selectSession(id, { preservePage: true });
		});
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
		if (isFileDropSession(session)) return;
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
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
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
	const nestedProfile = $derived(
		Boolean(runtime.profileBotId && selectedKind !== 'you-bot')
	);
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);
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

	/** The conversation whose settings are open beside it on the workbench, if any. */
	const settingsBeside = $derived(wide ? settingsSide(layout) : null);
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
		if (!runtime.sessionSettingsOpen && !settingsBeside) {
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
		if (runtime.previewSiblings && runtime.previewSiblings.length > 0) {
			return runtime.previewSiblings;
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
			const attachment = findAttachmentById(id) ?? runtime.previewSiblings?.find((s) => s.id === id);
			if (!attachment) return null;
			return {
				relpath: attachment.workspace_relpath,
				attachment,
				siblings: siblingsForPath(attachment.workspace_relpath, attachment),
				forceTree: runtime.forceArtifactTree,
				taskId: runtime.previewTaskId ?? null,
			};
		}
		const relpath = runtime.previewRelpath;
		if (!relpath) return null;
		const attachment = findAttachmentByPath(relpath) ?? runtime.previewSiblings?.find((s) => s.workspace_relpath === relpath);
		const owner = runtime.previewMessageId
			? snapshot.messages.find((message) => message.id === runtime.previewMessageId)
			: undefined;
		return {
			relpath,
			attachment: attachment ?? null,
			siblings: siblingsForPath(relpath, attachment, runtime.previewMessageId),
			forceTree: runtime.forceArtifactTree,
			// The entry opens the job's tree, not just this message's; older messages have none.
			taskId: runtime.previewTaskId ?? owner?.task_id ?? null
		};
	});

	function openArtifactPath(
		relpath: string,
		att?: Attachment,
		messageId?: string | null,
		forceTree = false,
		taskId?: string | null,
		siblings?: Attachment[] | null,
		sessionId?: string | null
	): void {
		if (runtime.paneOpener) {
			const sourceMessageId = messageId ?? att?.message_id ?? null;
			const owner = snapshot.messages.find((row) => row.id === sourceMessageId);
			runtime.paneOpener({
				kind: 'preview',
				// Whose preview this is decides which pane turns: every conversation has one.
				sessionId: sessionId ?? owner?.session_id ?? selected?.id ?? null,
				relpath: sanitizePreviewPath(relpath),
				attachmentId: att?.id ?? null,
				messageId: sourceMessageId,
				taskId: taskId ?? owner?.task_id ?? null,
				forceTree,
				siblings: siblings ?? siblingsForPath(relpath, att, sourceMessageId)
			});
			return;
		}
		if (runtime.hosted) {
			// A remote URL never carries a file path, so the preview goes by attachment id.
			runtime.previewRelpath = null;
			runtime.previewAttachmentId = att?.id ?? findAttachmentByPath(relpath)?.id ?? null;
			runtime.previewMessageId = messageId ?? att?.message_id ?? null;
			runtime.forceArtifactTree = forceTree;
			runtime.previewTaskId = taskId ?? null;
			runtime.previewSiblings = siblings ?? null;
			return;
		}
		runtime.previewAttachmentId = null;
		runtime.previewRelpath = sanitizePreviewPath(relpath);
		runtime.previewMessageId = messageId ?? att?.message_id ?? null;
		runtime.forceArtifactTree = forceTree;
		runtime.previewTaskId = taskId ?? null;
		runtime.previewSiblings = siblings ?? null;
	}

	function closeArtifactPreview(): void {
		runtime.previewRelpath = null;
		runtime.previewAttachmentId = null;
		runtime.previewMessageId = null;
		runtime.forceArtifactTree = false;
		runtime.previewTaskId = null;
		runtime.previewSiblings = null;
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

	/**
	 * `sessionId` is the conversation the profile opens beside on the workbench — the one it was
	 * asked for from, rather than whichever conversation the keyboard happens to be in.
	 */
	function openProfile(botId: string, sessionId?: string): void {
		if (!botsById.has(botId)) return;
		if (dangerConfirm?.source !== 'menu') clearDanger('bot');
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
		if (dangerConfirm?.source !== 'menu') clearDanger('bot');
		profileFailed = false;
		commitLayout(toggleChatSide(layout, sessionId, { kind: 'settings', botId: null }, { id: freshPaneId }));
	}

	function closePaneSide(sessionId: string): void {
		commitLayout(closeChatSide(layout, sessionId));
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
				settingsModal?.backFromProviderEditor();
			} else if (confirmingIndependent) {
				e.stopPropagation();
			} else if (searchPageOpen) {
				sidebar?.closeSearchPage();
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
			if (isTypingTarget(target)) return;
			if (!snapshot.settings.workspace_path) return;
			e.preventDefault();
			toggleWorkspaceExplorer();
			return;
		}
		// After the Escape chain and ⌘O, so neither can be taken out from under them.
		if (wide) {
			const command = matchWorkbenchKey(e);
			if (command) {
				e.preventDefault();
				runWorkbenchCommand(command);
			}
		}
	}}
/>

<!--
	The head of a conversation's settings, in the narrow drawer and beside a workbench pane alike.
	`nested` is a Bot opened from a group's settings. On a phone that page's way out is the
	conversation; a wider window still steps back to the group's settings.
-->
{#snippet settingsHead(group: boolean, nested: boolean, onBack: () => void, onClose: () => void, groupSession: SessionSummary | null = null)}
	<div class="sheet-head">
		{#if nested}
			<button
				type="button"
				class="sheet-back"
				aria-label={narrow ? t.common.back : (group ? t.detail.backToGroup : t.detail.backToBot)}
				onclick={onBack}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				<span class="sheet-back-label">{group ? t.detail.backToGroup : t.detail.backToBot}</span>
			</button>
		{:else if group && groupSession}
			<GroupIdentity {runtime} session={groupSession} bind:detail={groupDetail} {t} />
		{:else}
			<div class="panel-header-title-wrap flex items-center gap-5">
				<div class="panel-header-icon" aria-hidden="true">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="3"></circle>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
					</svg>
				</div>
				<h2>{t.detail.titleBot}</h2>
			</div>
		{/if}
		<button
			type="button"
			class="sheet-close"
			title={t.common.close}
			onclick={onClose}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="18" y1="6" x2="6" y2="18"></line>
				<line x1="6" y1="6" x2="18" y2="18"></line>
			</svg>
		</button>
	</div>
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
	{@const paneSession = sessionsById.get(sessionId)}
	{@const paneKind = paneSession ? classifySession(paneSession) : null}
	{@const shownBotId = botId ?? (paneKind === 'you-bot' && paneSession ? youBotPeer(paneSession) : null)}
	{@const paneBot = shownBotId ? botsById.get(shownBotId) : undefined}
	<div class="sheet session-settings is-beside" class:is-mobile-detail={paneMobileDetail}>
		{@render settingsHead(
			paneKind === 'group' && !paneBot,
			false,
			() => {},
			() => closePaneSide(sessionId),
			paneKind === 'group' && !paneBot && paneSession ? paneSession : null
		)}
		{#if paneBot}
			{#key paneBot.id}
				<ProfilePane
					bind:this={profilePane}
					{runtime}
					bot={paneBot}
					{t}
					modelOptions={availableModelOptions}
					selectedKind={paneKind}
					bind:profileFailed
					bind:mobileDetail={paneMobileDetail}
					openDangerConfirm={(kind, run) => (dangerConfirm = { kind, run, source: 'drawer' })}
					{clearDanger}
					onDeleteBot={() => openDeleteBotConfirm(paneBot.id)}
					onClearHistory={() => openClearHistoryConfirm(sessionId)}
				/>
			{/key}
		{:else if paneSession}
			<GroupPane
				{runtime}
				selected={paneSession}
				{t}
				bind:detail={groupDetail}
				bind:mobileDetail={paneMobileDetail}
				onOpenProfile={(id) => openProfile(id, sessionId)}
				onDeleteGroup={() => openDeleteGroupConfirm(sessionId)}
				onClearHistory={() => openClearHistoryConfirm(sessionId)}
			/>
		{:else}
			<p class="pane-settings-gone">{t.top.deleted}</p>
		{/if}
	</div>
{/snippet}

{#if showOnboarding}
	<Onboarding {runtime} onDismiss={() => (dismissedOnboarding = true)} />
{:else}
<ImageCopy {t} />
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
		{#if wide}
			<Workbench
				{layout}
				mins={paneMin}
				{t}
				wide={true}
				tabName={paneTitle}
				onLayout={commitLayout}
				onActivate={(leafId, tabId) => commitLayout(activateTab(layout, leafId, tabId))}
				onCloseTab={onPaneCloseTab}
			>
				{#snippet tabBody(tab: WorkbenchTab, leafId: string)}
					<PaneContentHost
						{tab}
						{leafId}
						{runtime}
						{t}
						{pinnedSessionIds}
						onTogglePin={togglePin}
						onOpenProfile={openProfile}
						onOpenArtifact={openArtifactPath}
						onCreateBot={openCreateBot}
						onRemoveTab={onPaneCloseTab}
						onBindTerminal={bindTerminalTab}
						onUpdateContent={(content) =>
							commitLayout(replaceTabParams(layout, leafId, tab.id, contentToParams(content)))}
						onPreviewPane={trackPreviewPane}
						onJump={jumpToTrace}
						onToggleSettings={togglePaneSettings}
						onCloseSide={closePaneSide}
						settingsSide={paneSettings}
					/>
				{/snippet}
				{#snippet tabLabel(tab: WorkbenchTab)}
					<span>{paneTitle(tab)}</span>
				{/snippet}
				{#snippet emptyActions(leafId: string)}
					<button type="button" class="pane-open" onclick={() => void openNewTerminal(leafId)}>
						{t.terminal.newTab}
					</button>
					{#each untabbedTerminals as row (row.id)}
						<button
							type="button"
							class="pane-open is-reattach"
							title={row.cwd}
							onclick={() => openInPane(leafId, { kind: 'terminal', terminalId: row.id })}
						>
							{t.terminal.reattach(terminalName(row))}
						</button>
					{/each}
					<button
						type="button"
						class="pane-open"
						disabled={!snapshot.settings.workspace_path}
						onclick={() => openInPane(leafId, { kind: 'workspace', selected: null })}
					>
						{t.sidebar.workspace}
					</button>
					<button type="button" class="pane-open" onclick={() => openInPane(leafId, { kind: 'routines' })}>
						{t.routines.title}
					</button>
				{/snippet}
				{#snippet menuActions(leafId: string, query: string)}
					{@const needle = query.trim().toLowerCase()}
					{@const listed = needle
						? untabbedTerminals.filter((row) =>
								`${terminalName(row)} ${row.cwd}`.toLowerCase().includes(needle))
						: untabbedTerminals}
					<button
						type="button"
						class="wb-menu-row"
						role="menuitem"
						onclick={() => void openNewTerminal(leafId)}
					>
						<span class="wb-menu-mark" aria-hidden="true">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="4 17 10 11 4 5"></polyline>
								<line x1="12" y1="19" x2="20" y2="19"></line>
							</svg>
						</span>
						<span class="wb-menu-name">{t.terminal.newTab}</span>
					</button>
					<button
						type="button"
						class="wb-menu-row"
						role="menuitem"
						disabled={!snapshot.settings.workspace_path}
						onclick={() => openInPane(leafId, { kind: 'workspace', selected: null })}
					>
						<span class="wb-menu-mark is-quiet" aria-hidden="true">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 7.5 12 3l9 4.5-9 4.5L3 7.5Z"></path>
								<path d="M3 12l9 4.5 9-4.5"></path>
								<path d="M3 16.5 12 21l9-4.5"></path>
							</svg>
						</span>
						<span class="wb-menu-name">{t.sidebar.workspace}</span>
					</button>
					<button
						type="button"
						class="wb-menu-row"
						role="menuitem"
						onclick={() => openInPane(leafId, { kind: 'routines' })}
					>
						<span class="wb-menu-mark is-quiet" aria-hidden="true">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="5" width="18" height="16" rx="2"></rect>
								<line x1="3" y1="10" x2="21" y2="10"></line>
								<line x1="8" y1="3" x2="8" y2="7"></line>
								<line x1="16" y1="3" x2="16" y2="7"></line>
							</svg>
						</span>
						<span class="wb-menu-name">{t.routines.title}</span>
					</button>
					<div class="wb-menu-section" role="presentation">{t.pane.runningTerminals}</div>
					{#each listed as row (row.id)}
						<button
							type="button"
							class="wb-menu-row"
							role="menuitem"
							title={row.cwd}
							onclick={() => openInPane(leafId, { kind: 'terminal', terminalId: row.id })}
						>
							<span class="wb-menu-mark is-quiet" aria-hidden="true">
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="4 17 10 11 4 5"></polyline>
									<line x1="12" y1="19" x2="20" y2="19"></line>
								</svg>
							</span>
							<span class="wb-menu-copy">
								<span class="wb-menu-name">{terminalName(row)}</span>
								<span class="wb-menu-meta">{row.cwd}</span>
							</span>
						</button>
					{:else}
						<p class="wb-menu-empty">{needle ? t.sidebar.emptySearch : t.pane.noRunningTerminals}</p>
					{/each}
				{/snippet}
			</Workbench>
		{:else if runtime.routinesOpen}
			{#await import('./calendar/RoutineCalendar.svelte') then { default: RoutineCalendar }}
				<RoutineCalendar {runtime} {t} />
			{/await}
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
		{#await import('./overlays/ArtifactPreview.svelte') then { default: ArtifactPreview }}
			<ArtifactPreview
				bind:this={previewPane}
				attachment={artifactPreview.attachment}
				relpath={artifactPreview.relpath}
				siblings={artifactPreview.siblings}
				api={runtime.client}
				workspacePath={snapshot.settings.workspace_path}
				forceTree={artifactPreview.forceTree}
				taskId={artifactPreview.taskId}
				{t}
				onClose={closeArtifactPreview}
				onSelect={(att) =>
					openArtifactPath(
						att.workspace_relpath,
						att,
						runtime.previewMessageId,
						runtime.forceArtifactTree,
						runtime.previewTaskId,
						runtime.previewSiblings
					)}
				onSelectWorkspacePath={(path) =>
					openArtifactPath(
						path,
						undefined,
						runtime.previewMessageId,
						runtime.forceArtifactTree,
						runtime.previewTaskId,
						runtime.previewSiblings
					)}
			/>
		{/await}
	{/if}
	{#if runtime.traceOpen && selected}
		{#await import('./overlays/TaskTrace.svelte') then { default: TaskTraceView }}
			<TaskTraceView
				bind:this={tracePane}
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
				onJump={jumpToTrace}
				onOpenArtifact={openArtifactPath}
				onTask={(id) => {
					if (runtime.traceTaskId !== id) runtime.traceTaskId = id;
				}}
			/>
		{/await}
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
					else if (nestedProfile && narrow) runtime.closeSessionSettings();
					else if (nestedProfile) closeNestedProfile();
					else if (profilePane?.backFromEditor()) e.stopPropagation();
					else runtime.closeSessionSettings();
				}
			}}
		>
			<div class="sheet is-right session-settings" class:is-mobile-detail={paneMobileDetail}>
				{@render settingsHead(
					selectedKind === 'group',
					nestedProfile,
					() => (narrow ? runtime.closeSessionSettings() : closeNestedProfile()),
					closeCurrentDrawerScreen,
					selectedKind === 'group' && !nestedProfile && selected ? selected : null
				)}

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
	{#if settingsEverOpened}
		{#await import('./settings/SettingsModal.svelte') then { default: SettingsModal }}
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

	/* The drawer's sheet, sliding over one pane instead of over the whole window. */
	.sheet.session-settings.is-beside {
		position: relative;
		inset: auto;
		width: 100%;
		height: 100%;
		min-height: 0;
		box-sizing: border-box;
		padding: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-right: 0;
		box-shadow: none;
		background: var(--bg);
		z-index: auto;
		animation: none;
	}
	.pane-settings-gone {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--muted);
		font-size: 13px;
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

	/*
	 * A phone already has a back chevron on every other settings page. The words ("返回群组设置")
	 * stay for a wider window, where this control is a labelled link, and for the button's name.
	 */
	@media (max-width: 680px) {
		.sheet-back {
			flex: 0 0 44px;
			width: 44px;
			height: 44px;
			justify-content: center;
			gap: 0;
			padding: 0;
			border-radius: var(--radius-md);
		}

		.sheet-back-label {
			display: none;
		}

		.sheet.session-settings:has(.sheet-back) :global(.sheet-head) {
			padding-left: 4px;
		}
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
			z-index: 80;
		}
	}
</style>
