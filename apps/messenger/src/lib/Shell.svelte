<script lang="ts">
	import {
		USER_MEMBER,
		type Attachment,
		type Bot,
		type Message,
		type SessionSummary
	} from '@real-bot/protocol';
	import {
		botAvatarColor,
		calculateBotDuration,
		canContinueInterrupt,
		formatDateDivider,
		formatDurationMs,
		formatFullTimestamp,
		formatLiveDuration,
		formatMessageTime,
		groupReactions,
		groupTranscript,
		isDifferentDay
	} from './chat-view.ts';
	import {
		approvalForMessage,
		approvalNeedsSecret,
		approvalSecretRequired,
		canAlwaysAllow,
		isHttpMcpApproval
	} from './approval-card.ts';
	import { composerLocked } from './composer-mode.ts';
	import { copyFor } from './copy.ts';
	import { modelSelectValue, type ProviderEditorState } from './provider-form.ts';
	import { rosterLetter } from './roster-letter.ts';
	import { avatarSrc } from './avatar.ts';
	import SessionAvatar from './SessionAvatar.svelte';
	import { routeLogRows } from './route-log.ts';
	import RouteLog from './RouteLog.svelte';
	import { getStarterOptions } from './starter-prompts.ts';
	import { presentBotIds } from './group-edit.ts';
	import {
		cleanPinnedIds,
		isSessionPinned,
		loadPinnedIds,
		savePinnedIds,
		togglePinnedId
	} from './pinned-sessions.ts';
	import { themeManager } from './theme.ts';
	import { classifySession, youBotPeer } from './session-groups.ts';
	import { sessionTitle } from './session-title.ts';
	import { renderMarkdown } from './markdown.ts';
		import {
		composeTranscript,
		isLiveStatus,
		isPendingAsk,
		transcriptItemKey
	} from './transcript.ts';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import Select from './Select.svelte';
	import SessionContextMenu from './SessionContextMenu.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import ArtifactPreview from './ArtifactPreview.svelte';
	import WorkspaceExplorer from './WorkspaceExplorer.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import { markdownCode } from './code-blocks.ts';
	import { parseArtifactHref } from './artifacts.ts';
	import { clampPreviewWidth, loadPreviewWidth, savePreviewWidth } from './preview-width.ts';
	import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from './sidebar-width.ts';
	import DangerDialog from './overlays/DangerDialog.svelte';
	import CreateBotSheet from './sidebar/CreateBotSheet.svelte';
	import GroupPane, { type GroupDetailDraft } from './panels/GroupPane.svelte';
	import ProfilePane from './panels/ProfilePane.svelte';
	import Sidebar from './sidebar/Sidebar.svelte';
	import ChatHeader from './chat/ChatHeader.svelte';
	import Composer from './chat/Composer.svelte';
	import SettingsModal from './settings/SettingsModal.svelte';
	import { canQuoteReply, draftWithQuoteMention, quotedBotName, quotePreview } from './quote-reply.ts';
	import {
		parseMentionHref,
	} from './mention-chips.ts';
	import { tick } from 'svelte';
	import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from './stream-scroll.ts';

	let { runtime }: { runtime: MessengerRuntime } = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const t = $derived(copyFor(locale));
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	let pinnedSessionIds = $state<string[]>(loadPinnedIds());
	let approvalKeys = $state<Record<string, string>>({});
	let approvalKeyErrors = $state<Record<string, boolean>>({});

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

	async function resolveApprovalCard(card: {
		id: string;
		kind_key: string | null;
		target: string | null;
		requires_api_key: boolean;
	}, action: 'allow_once' | 'deny' | 'always_allow'): Promise<void> {
		const key = approvalKeys[card.id] ?? '';
		if (action === 'allow_once' && approvalSecretRequired(card) && key.trim().length === 0) {
			approvalKeyErrors = { ...approvalKeyErrors, [card.id]: true };
			return;
		}
		const error = await runtime.resolveApproval(card.id, action, key);
		if (error && error.status === 422 && approvalNeedsSecret(card)) {
			approvalKeyErrors = { ...approvalKeyErrors, [card.id]: true };
			return;
		}
		if (!error) {
			const nextKeys = { ...approvalKeys };
			delete nextKeys[card.id];
			approvalKeys = nextKeys;
			const nextErrors = { ...approvalKeyErrors };
			delete nextErrors[card.id];
			approvalKeyErrors = nextErrors;
		}
	}


	const selected = $derived(snapshot.sessions.find((s) => s.id === runtime.selectedId) ?? null);
	const stream = $derived(
		selected
			? composeTranscript(
					snapshot.messages,
					snapshot.turns,
					selected.id,
					snapshot.pendingJudgements,
				)
			: []
	);
	const groupedStream = $derived(groupTranscript(stream));
	const liveTurnsHere = $derived(
		selected
			? snapshot.turns.filter((turn) => turn.session_id === selected.id && isLiveStatus(turn.status))
			: []
	);
	const pendingHere = $derived(
		selected ? snapshot.pendingJudgements.filter((j) => j.session_id === selected.id) : []
	);
	const liveTurn = $derived(
		liveTurnsHere.find((turn) => turn.id === runtime.focusedTurnId) ?? liveTurnsHere[0]
	);
	let askDrafts = $state<Record<string, string>>({});
	const connected = $derived(runtime.connection === 'connected');
	let composer = $state<{ focus: () => void } | null>(null);
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(
		selectedPeer ? (botsById.get(selectedPeer) ?? null) : null
	);
	const starterOptions = $derived(
		selectedPeerBot
			? getStarterOptions({
					name: selectedPeerBot.name,
					duties: selectedPeerBot.duties,
					boundaries: selectedPeerBot.boundaries,
					locale
				})
			: []
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
	let copiedMessageId = $state<string | null>(null);
	let streamContainer = $state<HTMLElement | null>(null);
	let streamInner = $state<HTMLElement | null>(null);
	let showScrollBottom = $state(false);
	let stickToBottom = $state(true);
	let ignoreStreamScroll = false;
	let jumpToBottom = false;
	let jumpToBottomTimer: ReturnType<typeof setTimeout> | null = null;
	let nowMs = $state(Date.now());





	function pinStreamToBottom(): void {
		const el = streamContainer;
		if (!el) return;
		ignoreStreamScroll = true;
		el.scrollTop = maxScrollTop(el.scrollHeight, el.clientHeight);
		showScrollBottom = false;
	}

	function cancelJumpToBottom(): void {
		if (jumpToBottomTimer !== null) {
			clearTimeout(jumpToBottomTimer);
			jumpToBottomTimer = null;
		}
		jumpToBottom = false;
	}

	function finishJumpToBottom(): void {
		cancelJumpToBottom();
		pinStreamToBottom();
	}



	$effect(() => {
		void runtime.selectedId;
		cancelJumpToBottom();
		if (runtime.highlightedMessageId) {
			stickToBottom = false;
			return () => cancelJumpToBottom();
		}
		stickToBottom = true;
		showScrollBottom = false;
		void tick().then(() => pinStreamToBottom());
		return () => cancelJumpToBottom();
	});

	$effect(() => {
		const id = runtime.highlightedMessageId;
		const token = runtime.searchHighlightToken;
		if (!id) return;
		stickToBottom = false;
		void snapshot.messages;
		void runtime.selectedId;
		void token;
		void tick().then(() => {
			if (runtime.highlightedMessageId !== id) return;
			scrollHighlightedMessage();
		});
	});

	$effect(() => {
		const outer = streamContainer;
		const inner = streamInner;
		if (!outer || !inner) return;
		void stickToBottom;
		const follow = () => {
			if (jumpToBottom) return;
			if (stickToBottom) {
				pinStreamToBottom();
				return;
			}
			showScrollBottom = !isNearBottom(outer.scrollHeight, outer.scrollTop, outer.clientHeight);
		};
		const ro = new ResizeObserver(follow);
		ro.observe(inner);
		ro.observe(outer);
		window.addEventListener('resize', follow);
		follow();
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', follow);
		};
	});

	$effect(() => {
		if (liveTurnsHere.length > 0) {
			const timer = setInterval(() => {
				nowMs = Date.now();
			}, 250);
			return () => clearInterval(timer);
		}
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

	function who(message: Message): string {
		if (message.author === USER_MEMBER) return t.common.you;
		return botsById.get(message.author)?.name ?? t.top.deleted;
	}

	function whoAuthor(author: string): string {
		if (author === USER_MEMBER) return t.common.you;
		return botsById.get(author)?.name ?? t.top.deleted;
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

	function scrollHighlightedMessage(): void {
		const id = runtime.highlightedMessageId;
		const root = streamContainer;
		if (!id || !root) return;
		const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
		if (!(el instanceof HTMLElement)) return;
		stickToBottom = false;
		el.scrollIntoView({ block: 'center', behavior: 'smooth' });
		window.setTimeout(() => {
			if (!streamContainer) return;
			showScrollBottom = !isNearBottom(
				streamContainer.scrollHeight,
				streamContainer.scrollTop,
				streamContainer.clientHeight
			);
		}, 320);
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

	function markdownOpts(message?: Message, extra?: { streaming?: boolean }) {
		const session = message ? snapshot.sessions.find((s) => s.id === message.session_id) : undefined;
		const mentionMembers = session
			? presentBotIds(session)
					.map((id) => botsById.get(id))
					.filter((b): b is Bot => Boolean(b))
			: snapshot.bots;
		return {
			streaming: extra?.streaming,
			extraPaths: message?.attachments.map((att) => att.workspace_relpath) ?? [],
			mentionBots: snapshot.bots,
			mentionMembers,
			unresolvedMentionTitle: t.stream.mentionUnresolved
		};
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

















	function pickStarterPrompt(prompt: string): void {
		runtime.draft = prompt;
		void tick().then(() => composer?.focus());
	}

	/** The composer hands the files over; scrolling to the new message is the stage's job. */
	async function sendFromComposer(files: File[]): Promise<void> {
		stickToBottom = true;
		await runtime.send({ attachments: files.length > 0 ? files : undefined });
		await tick();
		scrollToBottom(false);
	}

	function onStreamScroll(e: Event): void {
		const el = e.currentTarget as HTMLElement;
		if (!el) return;
		const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
		const next = stickAfterScroll(ignoreStreamScroll, near, jumpToBottom);
		ignoreStreamScroll = next.ignore;
		if (next.ignore) {
			if (jumpToBottom && distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight) <= 1) {
				finishJumpToBottom();
			}
			return;
		}
		showScrollBottom = !next.stick;
		stickToBottom = next.stick;
	}

	function onStreamScrollEnd(): void {
		if (!jumpToBottom) return;
		finishJumpToBottom();
	}

	function scrollToBottom(smooth = true): void {
		if (!streamContainer) return;
		stickToBottom = true;
		showScrollBottom = false;
		const reduceMotion =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!smooth || reduceMotion) {
			finishJumpToBottom();
			return;
		}
		jumpToBottom = true;
		ignoreStreamScroll = true;
		const el = streamContainer;
		el.scrollTo({
			top: maxScrollTop(el.scrollHeight, el.clientHeight),
			behavior: 'smooth'
		});
		if (jumpToBottomTimer !== null) clearTimeout(jumpToBottomTimer);
		jumpToBottomTimer = setTimeout(() => {
			jumpToBottomTimer = null;
			finishJumpToBottom();
		}, 800);
	}

	function fallbackCopyText(text: string): void {
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		} catch {
			// ignore
		}
	}


	function startQuoteReply(message: Message): void {
		if (lockedComposer || !canQuoteReply(message)) return;
		runtime.replyingToId = message.id;
		const name = quotedBotName(message, botsById);
		if (name) runtime.draft = draftWithQuoteMention(runtime.draft, name);
		void tick().then(() => composer?.focus());
	}



	function copyMessageBody(id: string, text: string, event?: MouseEvent): void {
		fallbackCopyText(text);
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard.writeText(text).catch(() => {});
		}
		copiedMessageId = id;
		const target = event?.currentTarget as HTMLElement | undefined;
		if (target) {
			target.classList.add('is-copied');
			setTimeout(() => {
				target.classList.remove('is-copied');
			}, 1800);
		}
		setTimeout(() => {
			if (copiedMessageId === id) copiedMessageId = null;
		}, 1800);
	}

	function markdownLinks(node: HTMLElement) {
		node.addEventListener('click', onMarkdownClick);
		const code = markdownCode(node, { copy: t.chat.copyCode, copied: t.chat.copied });
		return {
			update() {
				code.update({ copy: t.chat.copyCode, copied: t.chat.copied });
			},
			destroy() {
				node.removeEventListener('click', onMarkdownClick);
				code.destroy();
			}
		};
	}

	function onMarkdownClick(ev: MouseEvent): void {
		const target = ev.target;
		if (!(target instanceof Element)) return;
		const a = target.closest('a');
		if (!(a instanceof HTMLAnchorElement)) return;
		ev.preventDefault();
		const raw = a.getAttribute('href') ?? a.href;
		const botId = parseMentionHref(raw);
		if (botId && botId !== 'everyone') {
			openProfile(botId);
			return;
		}
		const artifact = parseArtifactHref(raw);
		if (artifact) {
			openArtifactPath(artifact);
			return;
		}
		const href = a.href;
		if (
			href.startsWith('https:') ||
			href.startsWith('http:') ||
			href.startsWith('mailto:')
		) {
			window.open(href, '_blank', 'noopener,noreferrer');
		}
	}

	async function replyAsk(askId: string): Promise<void> {
		const body = (askDrafts[askId] ?? '').trim();
		if (!body) return;
		stickToBottom = true;
		await runtime.sendAsk(askId, body);
		const next = { ...askDrafts };
		delete next[askId];
		askDrafts = next;
		await tick();
		scrollToBottom(false);
	}

	function approvalStatusCopy(status: 'allowed_once' | 'denied' | 'voided' | 'pending'): string {
		if (status === 'allowed_once') return t.stream.allowed;
		if (status === 'denied') return t.stream.denied;
		if (status === 'voided') return t.stream.voided;
		return t.stream.approval;
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
		<div class="stream-stage">
			<div class="stream" bind:this={streamContainer} onscroll={onStreamScroll} onscrollend={onStreamScrollEnd}>
				<div class="stream-inner" bind:this={streamInner}>
			{#if !selected}
				<div class="empty-state">
					<div class="empty-icon" aria-hidden="true">
						<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
						</svg>
					</div>
					<h2>{t.top.pickSession}</h2>
					<p class="muted">{t.top.pickSession}</p>
				</div>
			{:else if stream.length === 0}
				<div class="empty-chat-welcome">
					{#if selectedKind === 'you-bot' && selectedPeerBot}
						{@const pal = botAvatarColor(selectedPeerBot.id)}
						<button
							type="button"
							class="welcome-identity-btn"
							onclick={() => openProfile(selectedPeerBot.id)}
							title={sessionSettingsLabel}
						>
							<span
								class="welcome-avatar"
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
							>
								{#if avatarSrc(selectedPeerBot.avatar)}
									<img src={avatarSrc(selectedPeerBot.avatar)} alt={selectedPeerBot.name} class="avatar-img" />
								{:else}
									{rosterLetter(selectedPeerBot.name)}
								{/if}
							</span>
							<span class="welcome-title">{selectedPeerBot.name}</span>
						</button>
						<div class="welcome-badges">
							<span class="bot-badge">{t.chat.botBadge}</span>
							{#if selectedPeerBot.model}
								<span class="model-badge mono">{selectedPeerBot.model}</span>
							{/if}
						</div>
						{#if selectedPeerBot.duties}
							<div class="welcome-duties">
								<p class="duties-text">{selectedPeerBot.duties}</p>
							</div>
						{/if}
						{#if starterOptions.length > 0}
							<div class="welcome-starters">
								{#each starterOptions as starter (starter.id)}
									<button
										type="button"
										class="starter-chip"
										disabled={lockedComposer}
										onclick={() => pickStarterPrompt(starter.prompt)}
									>
										{starter.icon} {starter.label}
									</button>
								{/each}
							</div>
						{/if}
					{:else}
						<div class="empty-icon" aria-hidden="true">
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10"></circle>
								<line x1="8" y1="12" x2="16" y2="12"></line>
							</svg>
						</div>
						<h2>{titleOf(selected)}</h2>
					{/if}
					<p class="muted">{t.stream.empty}</p>
				</div>
			{:else}
				{#each groupedStream as group, gIdx (group.id)}
					{@const groupDate = group.created_at}
					{@const prevGroup = gIdx > 0 ? groupedStream[gIdx - 1] : null}
					{@const prevDate = prevGroup ? prevGroup.created_at : null}
					{#if !prevDate || isDifferentDay(prevDate, groupDate)}
						<div class="date-divider">
							<span class="date-pill">{formatDateDivider(groupDate, locale)}</span>
						</div>
					{/if}

					{#if group.kind === 'replying'}
						{@const block = group.items[0]}
						{#if block.type === 'replying'}
							<div class="replying-list" aria-live="polite">
								<ReplyingIndicator
									entries={block.entries}
									{botsById}
									isUser={false}
									thinkingText={t.chat.thinking}
									deletedText={t.top.deleted}
									onOpenProfile={openProfile}
								/>
							</div>
						{/if}
					{:else if group.kind === 'ask'}
						{@const singleMsg = group.items[0]}
						{#if singleMsg.type === 'message'}
							{@const askBot = botsById.get(singleMsg.message.author)}
							{@const pal = botAvatarColor(singleMsg.message.author)}
							<div
								class="msg-wrap is-bot"
								data-message-id={singleMsg.message.id}
								class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
							>
								<div class="avatar-col">
									{#if askBot}
										<button
											type="button"
											class="bot-avatar is-clickable"
											style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
											title={t.top.botSettings}
											onclick={() => openProfile(askBot.id)}
										>
											{#if avatarSrc(askBot.avatar)}
												<img src={avatarSrc(askBot.avatar)} alt={askBot.name} class="avatar-img" />
											{:else}
												{rosterLetter(askBot.name)}
											{/if}
										</button>
									{:else}
										<div class="bot-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};">
											?
										</div>
									{/if}
								</div>
								<div class="msg-content">
									<div class="msg-header">
										{#if askBot}
											<button
												type="button"
												class="sender-name is-clickable"
												onclick={() => openProfile(askBot.id)}
												title={t.top.botSettings}
											>
												{who(singleMsg.message)}
											</button>
										{:else}
											<span class="sender-name">{who(singleMsg.message)}</span>
										{/if}
										<span class="ask-badge">?</span>
										<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
											{formatMessageTime(singleMsg.message.created_at)}
										</span>
									</div>
									<article class="msg is-ask">
										<div class="who">{t.stream.ask} · {who(singleMsg.message)}</div>
										<div class="body">{singleMsg.message.body}</div>
										{#if isPendingAsk(singleMsg.message, snapshot.turns)}
											<div class="ask-reply">
												<input
													type="text"
													placeholder={t.stream.reply}
													value={askDrafts[singleMsg.message.id] ?? ''}
													oninput={(ev) =>
														(askDrafts = {
															...askDrafts,
															[singleMsg.message.id]: (ev.currentTarget as HTMLInputElement).value
														})}
													onkeydown={(ev) => {
														if (ev.key === 'Enter') {
															ev.preventDefault();
															void replyAsk(singleMsg.message.id);
														}
													}}
												/>
												<button type="button" onclick={() => void replyAsk(singleMsg.message.id)}
													>{t.stream.reply}</button
												>
											</div>
										{/if}
									</article>
								</div>
							</div>
						{/if}
					{:else if group.kind === 'approval'}
						{@const singleMsg = group.items[0]}
						{#if singleMsg.type === 'message'}
							{@const card = approvalForMessage(snapshot.approvals, singleMsg.message)}
							<div
								class="msg-wrap is-card-wrap"
								data-message-id={singleMsg.message.id}
								class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
							>
								<article class="msg is-approval">
									<div class="who">{t.stream.approval} · {who(singleMsg.message)}</div>
									<div class="body">{singleMsg.message.body}</div>
									{#if card?.status === 'pending'}
										{#if approvalNeedsSecret(card)}
											{@const mcpAuth = isHttpMcpApproval(card.kind_key, card.target) || card.kind_key === 'mcp-add' || card.kind_key === 'mcp-edit'}
											<label class="approval-key" for={`approval-key-${card.id}`}>
												<span>{mcpAuth ? t.stream.mcpAuth : t.stream.endpointKey}</span>
												<input
													id={`approval-key-${card.id}`}
													type="password"
													autocomplete="off"
													value={approvalKeys[card.id] ?? ''}
													oninput={(e) => {
														approvalKeys = {
															...approvalKeys,
															[card.id]: e.currentTarget.value
														};
														if (approvalKeyErrors[card.id]) {
															approvalKeyErrors = { ...approvalKeyErrors, [card.id]: false };
														}
													}}
												/>
												{#if approvalKeyErrors[card.id]}
													<p class="field-error">{mcpAuth ? t.stream.mcpAuthEmpty : t.stream.endpointKeyEmpty}</p>
												{:else}
													<p class="hint">
														{mcpAuth
															? card.kind_key === 'mcp-add'
																? t.stream.mcpAuthHintAdd
																: t.stream.mcpAuthHintEdit
															: card.kind_key === 'endpoint-add'
																? t.stream.endpointKeyHintAdd
																: t.stream.endpointKeyHintEdit}
													</p>
												{/if}
											</label>
										{/if}
										<div class="approval-acts">
											<button
												type="button"
												onclick={() => void resolveApprovalCard(card, 'allow_once')}
												>{t.stream.allowOnce}</button
											>
											{#if canAlwaysAllow(card.kind_key)}
												<button
													type="button"
													onclick={() => void resolveApprovalCard(card, 'always_allow')}
													>{t.stream.alwaysAllow}</button
												>
											{/if}
											<button
												type="button"
												class="deny"
												onclick={() => void resolveApprovalCard(card, 'deny')}
												>{t.stream.deny}</button
											>
										</div>
									{:else if card}
										<p class="muted">{approvalStatusCopy(card.status)}</p>
									{/if}
								</article>
							</div>
						{/if}
					{:else if group.kind === 'system'}
						{@const singleMsg = group.items[0]}
						{#if singleMsg.type === 'message'}
							{@const sysBot = botsById.get(singleMsg.message.author)}
							{@const pal = botAvatarColor(singleMsg.message.author)}
							{@const showContinue = canContinueInterrupt(singleMsg.message, snapshot.turns, {
								locked: lockedComposer,
								hasLiveTurnForBot: liveTurnsHere.some((turn) => turn.bot_id === singleMsg.message.author)
							})}
							<div
								class="msg-wrap is-bot is-system-row"
								data-message-id={singleMsg.message.id}
								class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
							>
								<div class="avatar-col">
									{#if sysBot}
										<button
											type="button"
											class="bot-avatar is-clickable"
											style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
											title={t.top.botSettings}
											onclick={() => openProfile(sysBot.id)}
										>
											{#if avatarSrc(sysBot.avatar)}
												<img src={avatarSrc(sysBot.avatar)} alt={sysBot.name} class="avatar-img" />
											{:else}
												{rosterLetter(sysBot.name)}
											{/if}
										</button>
									{:else}
										<div class="bot-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};">
											?
										</div>
									{/if}
								</div>
								<div class="msg-content">
									<div class="msg-header">
										{#if sysBot}
											<button
												type="button"
												class="sender-name is-clickable"
												onclick={() => openProfile(sysBot.id)}
												title={t.top.botSettings}
											>
												{who(singleMsg.message)}
											</button>
										{:else}
											<span class="sender-name">{who(singleMsg.message)}</span>
										{/if}
										<span class="bot-badge">{t.chat.botBadge}</span>
										<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
											{formatMessageTime(singleMsg.message.created_at)}
										</span>
									</div>
									<div class="msg-interrupt-row">
										<article class="msg is-system">
											<div class="who">{who(singleMsg.message)}</div>
											<div class="body">{singleMsg.message.body}</div>
										</article>
										{#if showContinue}
											<button
												type="button"
												class="btn-mini-continue"
												title={t.stream.continueInterruptHint}
												disabled={!connected || runtime.busy}
												onclick={() => void runtime.continueInterrupt(singleMsg.message.id)}
											>
												{t.stream.continueInterrupt}
											</button>
										{/if}
									</div>
									{#if singleMsg.replying && singleMsg.replying.length > 0}
										<div class="msg-attached-replying" aria-live="polite">
											<ReplyingIndicator
												entries={singleMsg.replying}
												{botsById}
												isUser={false}
												thinkingText={t.chat.thinking}
												deletedText={t.top.deleted}
												onOpenProfile={openProfile}
											/>
										</div>
									{/if}
								</div>
							</div>
						{/if}
					{:else if group.kind === 'user'}
						{@const isMulti = group.items.length > 1}
						<div class="msg-wrap is-user" class:is-group={isMulti}>
							<div class="msg-content">
								<div class="msg-header is-right">
									{#if isMulti}
										<span class="segment-count-badge mono">{t.chat.messageCount(group.items.length)}</span>
										<span class="sender-name">{t.common.you}</span>
									{:else}
										{@const single = group.items[0]}
										{#if single.type === 'message'}
											<span class="msg-time mono" title={formatFullTimestamp(single.message.created_at)}>
												{formatMessageTime(single.message.created_at)}
											</span>
										{/if}
										<span class="sender-name">{t.common.you}</span>
									{/if}
								</div>
								<div class="msg-segments is-user-segments">
									{#each group.items as item (transcriptItemKey(item))}
										{#if item.type === 'message'}
											{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
											<div
												class="msg-segment is-user-segment"
												data-message-id={item.message.id}
												class:is-search-hit={runtime.highlightedMessageId === item.message.id}
											>
												{#if isMulti}
													<div class="segment-meta is-right">
														<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
															{formatMessageTime(item.message.created_at)}
														</span>
													</div>
												{/if}
												<article class="msg is-you">
													<div class="who">{who(item.message)}</div>
													<div class="msg-toolbar">
														{#if canQuoteReply(item.message) && !lockedComposer}
															<button
																type="button"
																class="act-btn"
																title={t.chat.replyMessage}
																onclick={() => startQuoteReply(item.message)}
															>
																<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
															</button>
														{/if}
														<button
															type="button"
															class="act-btn"
															class:is-copied={copiedMessageId === item.message.id}
															title={t.chat.copyMessage}
															onclick={(e) => copyMessageBody(item.message.id, item.message.body, e)}
														>
															{#if copiedMessageId === item.message.id}
																<span class="copied-badge">✓ {t.chat.copied}</span>
															{:else}
																<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
															{/if}
														</button>
													</div>
													{#if item.message.parent_id}
														{@const quoted = snapshot.messages.find((m) => m.id === item.message.parent_id)}
														<button
															type="button"
															class="quote-ref"
															onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
														>
															<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
															<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
														</button>
													{/if}
													<div class="body is-md" use:markdownLinks>{@html renderMarkdown(item.message.body, markdownOpts(item.message))}</div>
													{#if item.message.attachments && item.message.attachments.length > 0}
														<MessageAttachments
															attachments={item.message.attachments}
															api={runtime.client}
															{t}
															onPreview={(att) => openArtifactPath(att.workspace_relpath, att)}
														/>
													{/if}
												</article>
												{#if rxGroups.length > 0}
													<div class="rx-row is-right">
														{#each rxGroups as rx}
															<button
																type="button"
																class="rx-chip"
																class:is-active={rx.userReacted}
																onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
															>
																<span class="rx-emoji">{rx.emoji}</span>
																<span class="rx-count mono">{rx.count}</span>
															</button>
														{/each}
													</div>
												{/if}
												{#if item.replying && item.replying.length > 0}
													<div class="msg-attached-replying is-user" aria-live="polite">
														<ReplyingIndicator
															entries={item.replying}
															{botsById}
															isUser={true}
															thinkingText={t.chat.thinking}
															deletedText={t.top.deleted}
															onOpenProfile={openProfile}
														/>
													</div>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							</div>
							<div class="avatar-col">
								<div class="user-avatar" title={t.common.you}>
									{rosterLetter(t.common.you)}
								</div>
							</div>
						</div>
					{:else}
						{@const botAuthor = botsById.get(group.author)}
						{@const pal = botAvatarColor(group.author)}
						{@const isMulti = group.items.length > 1}
						{@const hasStreaming = group.items.some((i) => i.type === 'streaming')}
						<div
							class="msg-wrap is-bot"
							class:is-group={isMulti}
							class:is-streaming-wrap={hasStreaming}
						>
							<div class="avatar-col">
								{#if botAuthor}
									<button
										type="button"
										class="bot-avatar is-clickable"
										class:is-streaming-avatar={hasStreaming}
										style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
										title={t.top.botSettings}
										onclick={() => openProfile(botAuthor.id)}
									>
										{#if avatarSrc(botAuthor.avatar)}
											<img src={avatarSrc(botAuthor.avatar)} alt={botAuthor.name} class="avatar-img" />
										{:else}
											{rosterLetter(botAuthor.name)}
										{/if}
									</button>
								{:else}
									<div
										class="bot-avatar"
										class:is-streaming-avatar={hasStreaming}
										style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
										title={t.top.deleted}
									>
										{rosterLetter('?')}
									</div>
								{/if}
							</div>
							<div class="msg-content">
								<div class="msg-header">
									{#if botAuthor}
										<button
											type="button"
											class="sender-name is-clickable"
											onclick={() => openProfile(botAuthor.id)}
											title={t.top.botSettings}
										>
											{botAuthor.name}
										</button>
									{:else}
										<span class="sender-name">{whoAuthor(group.author)}</span>
									{/if}
									<span class="bot-badge">{t.chat.botBadge}</span>
									{#if botAuthor?.model}
										<span class="model-badge mono">{botAuthor.model}</span>
									{/if}
									{#if isMulti}
										<span class="segment-count-badge mono">{t.chat.segmentCount(group.items.length)}</span>
									{:else}
										{@const single = group.items[0]}
										{#if single.type === 'streaming'}
											{@const liveElapsed = formatLiveDuration(single.turn.created_at, nowMs)}
											<span class="streaming-status">
												<span class="pulse"></span>
												{t.stream.streaming}
											</span>
											<span class="duration-badge mono live">⏱️ {liveElapsed}</span>
											{#if selected?.kind !== 'group'}
												<button
													type="button"
													class="btn-mini-stop"
													title={t.composer.stop}
													onclick={() => void runtime.stopTurn()}
												>
													<span class="stop-icon-mini">■</span>
													<span>{t.composer.stop}</span>
												</button>
											{/if}
										{:else if single.type === 'message'}
											{@const duration = calculateBotDuration(single.message, snapshot.messages, snapshot.turns)}
											<span class="msg-time mono" title={formatFullTimestamp(single.message.created_at)}>
												{formatMessageTime(single.message.created_at)}
											</span>
											{#if duration}
												<span class="duration-badge mono" title={t.chat.replyTime(duration.formatted)}>
													<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
													{duration.formatted}
												</span>
											{/if}
										{/if}
									{/if}
								</div>

								<div class="msg-segments">
									{#each group.items as item, sIdx (transcriptItemKey(item))}
										<div
											class="msg-segment"
											class:is-streaming={item.type === 'streaming'}
											data-message-id={item.type === 'message' ? item.message.id : undefined}
											class:is-search-hit={item.type === 'message' &&
												runtime.highlightedMessageId === item.message.id}
										>
											{#if isMulti}
												<div class="segment-meta">
													<span class="segment-tag">{t.chat.segmentPart(sIdx + 1)}</span>
													{#if item.type === 'streaming'}
														{@const liveElapsed = formatLiveDuration(item.turn.created_at, nowMs)}
														<span class="streaming-status">
															<span class="pulse"></span>
															{t.stream.streaming}
														</span>
														<span class="duration-badge mono live">⏱️ {liveElapsed}</span>
														{#if selected?.kind !== 'group'}
															<button
																type="button"
																class="btn-mini-stop"
																title={t.composer.stop}
																onclick={() => void runtime.stopTurn()}
															>
																<span class="stop-icon-mini">■</span>
																<span>{t.composer.stop}</span>
															</button>
														{/if}
													{:else if item.type === 'message'}
														{@const duration = calculateBotDuration(item.message, snapshot.messages, snapshot.turns)}
														<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
															{formatMessageTime(item.message.created_at)}
														</span>
														{#if duration}
															<span class="duration-badge mono" title={t.chat.replyTime(duration.formatted)}>
																<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
																{duration.formatted}
															</span>
														{/if}
													{/if}
												</div>
											{/if}

											{#if item.type === 'streaming'}
												<article class="msg is-stream">
													<div class="who">
														{botAuthor?.name ?? t.top.deleted} · {t.stream.streaming}
														<span class="pulse"></span>
													</div>
													<div class="body is-md" use:markdownLinks>
														{@html renderMarkdown(item.turn.partial_text ?? '', markdownOpts(undefined, { streaming: true }))}
														<span class="streaming-cursor"></span>
													</div>
												</article>
											{:else if item.type === 'message'}
												{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
												<article class="msg">
													<div class="who">{who(item.message)}</div>
													<div class="msg-toolbar">
														{#if canQuoteReply(item.message) && !lockedComposer}
															<button
																type="button"
																class="act-btn"
																title={t.chat.replyMessage}
																onclick={() => startQuoteReply(item.message)}
															>
																<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
															</button>
														{/if}
														<button
															type="button"
															class="act-btn"
															class:is-copied={copiedMessageId === item.message.id}
															title={t.chat.copyMessage}
															onclick={(e) => copyMessageBody(item.message.id, item.message.body, e)}
														>
															{#if copiedMessageId === item.message.id}
																<span class="copied-badge">✓ {t.chat.copied}</span>
															{:else}
																<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
															{/if}
														</button>
													</div>
													{#if item.message.parent_id}
														{@const quoted = snapshot.messages.find((m) => m.id === item.message.parent_id)}
														<button
															type="button"
															class="quote-ref"
															onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
														>
															<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
															<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
														</button>
													{/if}
													<div class="body is-md" use:markdownLinks>{@html renderMarkdown(item.message.body, markdownOpts(item.message))}</div>
													{#if item.message.attachments && item.message.attachments.length > 0}
														<MessageAttachments
															attachments={item.message.attachments}
															api={runtime.client}
															{t}
															onPreview={(att) => openArtifactPath(att.workspace_relpath, att)}
														/>
													{/if}
												</article>
												{#if rxGroups.length > 0}
													<div class="rx-row">
														{#each rxGroups as rx}
															<button
																type="button"
																class="rx-chip"
																class:is-active={rx.userReacted}
																onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
															>
																<span class="rx-emoji">{rx.emoji}</span>
																<span class="rx-count mono">{rx.count}</span>
															</button>
														{/each}
													</div>
												{/if}
												{#if item.replying && item.replying.length > 0}
													<div class="msg-attached-replying" aria-live="polite">
														<ReplyingIndicator
															entries={item.replying}
															{botsById}
															isUser={false}
															thinkingText={t.chat.thinking}
															deletedText={t.top.deleted}
															onOpenProfile={openProfile}
														/>
													</div>
												{/if}
											{/if}
										</div>
									{/each}
								</div>
							</div>
						</div>
					{/if}
				{/each}
			{/if}
				</div>
			</div>

			{#if showScrollBottom}
				<button
					type="button"
					class="scroll-bottom-btn"
					title={t.chat.scrollToBottom}
					aria-label={t.chat.scrollToBottom}
					onclick={() => scrollToBottom(true)}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
				</button>
			{/if}

			<Composer
				bind:this={composer}
				{runtime}
				{t}
				{selected}
				onSend={sendFromComposer}
				onPickPrompt={pickStarterPrompt}
			/>
		</div>
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
