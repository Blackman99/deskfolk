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
	import { composerAction, composerLocked } from './composer-mode.ts';
	import { insertComposerNewline } from './composer-editor.ts';
	import {
		COMPOSER_IME_IDLE,
		composerImeKeyAction,
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate,
		type ComposerImeState
	} from './composer-ime.ts';
	import { copyFor, JAIL_COPY, thinkingLevelLabel } from './copy.ts';
	import McpSettings from './McpSettings.svelte';
	import {
		emptySkillDraft,
		formatSkillUses,
		mapCreateBotError,
		mapCreateGroupError,
		mapSkillError,
		planCreateBot,
		planCreateGroup,
		planSkill,
		reconcileSkillDraft,
		skillDraftDirty,
		type CreateBotDraft,
		type CreateBotFieldErrors,
		type CreateGroupFieldErrors,
		type SkillDraft,
		type SkillFieldErrors
	} from './create-form.ts';
	import {
		mapSettingsError,
		planWorkspaceSave,
		type FieldErrorKind,
		type SettingsFieldErrors
	} from './wizard-save.ts';
	import {
		applyProbedModels,
		draftFromProvider,
		emptyProviderDraft,
		mapProviderError,
		modelSelectValue,
		planCreateProvider,
		planPatchProvider,
		probeSignature,
		providerHost,
		withSyncedDefaultModel,
		type ProviderDraft,
		type ProviderFieldErrors
	} from './provider-form.ts';
	import { rosterLetter } from './roster-letter.ts';
	import { avatarSrc } from './avatar.ts';
	import AvatarEditor from './AvatarEditor.svelte';
	import SessionAvatar from './SessionAvatar.svelte';
	import { searchHitView, searchJump } from './search-jump.ts';
	import { routeLogRows } from './route-log.ts';
	import RouteLog from './RouteLog.svelte';
	import { getStarterOptions } from './starter-prompts.ts';
	import {
		canRemoveGroupBot,
		mapGroupEditError,
		planGroupName,
		presentBotIds,
		pullInCandidates
	} from './group-edit.ts';
	import {
		profileDraftDirty,
		profileNeedsSave,
		reconcileProfileDraft,
		type ProfileFields
	} from './roster-edit.ts';
	import { applyModelPin, pinnableThinkingLevels } from './create-form.ts';
	import { untrack } from 'svelte';
	import {
		cleanPinnedIds,
		isSessionPinned,
		loadPinnedIds,
		savePinnedIds,
		togglePinnedId
	} from './pinned-sessions.ts';
	import { themeManager } from './theme.ts';
	import { classifySession, groupSessions, isSessionArchived, youBotPeer } from './session-groups.ts';
	import { sessionPresence, sessionTitle } from './session-title.ts';
	import { renderMarkdown } from './markdown.ts';
	import { botWorkStatus, sidebarStatus } from './session-status.ts';
	import { sessionUnreadCount, unreadBadge } from './unread.ts';
	import {
		composeTranscript,
		isLiveStatus,
		isPendingAsk,
		latestPreview,
		transcriptItemKey
	} from './transcript.ts';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import { updateChecker } from './update-checker.svelte.ts';
	import Onboarding from './Onboarding.svelte';
	import ProviderForm from './ProviderForm.svelte';
	import Select from './Select.svelte';
	import SessionContextMenu from './SessionContextMenu.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import ArtifactPreview from './ArtifactPreview.svelte';
	import WorkspaceExplorer from './WorkspaceExplorer.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import { markdownCode } from './code-blocks.ts';
	import { parseArtifactHref } from './artifacts.ts';
	import WorkspacePicker from './WorkspacePicker.svelte';
	import { clampPreviewWidth, loadPreviewWidth, savePreviewWidth } from './preview-width.ts';
	import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from './sidebar-width.ts';
	import { isOutside } from './click-outside.ts';
	import { formatFileSize } from './attachments.ts';
	import { canQuoteReply, draftWithQuoteMention, quotedBotName, quotePreview } from './quote-reply.ts';
	import {
		deleteChipElement,
		getTextBeforeCaret,
		handleEditorBackspace,
		handleEditorDelete,
		insertMentionChipAtCaret,
		parseMentionHref,
		serializeEditorText,
		setEditorContentFromText
	} from './mention-chips.ts';
	import {
		applyMentionCandidate,
		detectMentionTrigger,
		scrollTopToRevealRect,
		shouldIgnoreKeyUp,
		updateMentionTrigger
	} from './mention-popup.ts';
	import { tick } from 'svelte';
	import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from './stream-scroll.ts';

	let { runtime }: { runtime: MessengerRuntime } = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const t = $derived(copyFor(locale));
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	let pinnedSessionIds = $state<string[]>(loadPinnedIds());
	let pinnedExpanded = $state(false);
	let approvalKeys = $state<Record<string, string>>({});
	let approvalKeyErrors = $state<Record<string, boolean>>({});

	let searchFocused = $state(false);
	let searchHighlightIndex = $state(-1);
	let searchWrapEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let searchDropEl = $state<HTMLElement | null>(null);

	$effect(() => {
		void runtime.searchHits;
		searchHighlightIndex = -1;
	});

	const aliveBotIds = $derived(new Set(snapshot.bots.map((b) => b.id)));
	const validSessionIds = $derived(new Set(snapshot.sessions.map((s) => s.id)));

	$effect(() => {
		const cleaned = cleanPinnedIds(pinnedSessionIds, validSessionIds);
		if (cleaned.length !== pinnedSessionIds.length) {
			pinnedSessionIds = cleaned;
			savePinnedIds(cleaned);
		}
	});

	let resolvedTheme = $state(themeManager.resolved);
	let themePreference = $state(themeManager.preference);

	$effect(() => {
		return themeManager.subscribe(() => {
			resolvedTheme = themeManager.resolved;
			themePreference = themeManager.preference;
		});
	});

	$effect(() => {
		if (snapshot.settings.theme) {
			themeManager.syncFromSnapshot(snapshot.settings.theme);
		}
	});

	let themeMenuOpen = $state(false);
	let themeMenuEl = $state<HTMLElement | null>(null);
	let themeToggleBtnEl = $state<HTMLButtonElement | null>(null);
	const currentTheme = $derived(snapshot.settings.theme || themePreference);

	function selectTheme(theme: 'system' | 'light' | 'dark'): void {
		themeManager.setTheme(theme);
		void patchImmediate({ theme });
		themeMenuOpen = false;
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

	$effect(() => {
		if (themeMenuOpen && themeMenuEl) {
			const activeItem = themeMenuEl.querySelector<HTMLButtonElement>('.theme-menu-item.is-selected')
				?? themeMenuEl.querySelector<HTMLButtonElement>('.theme-menu-item');
			activeItem?.focus();
		}
	});

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

	let viewingArchived = $state(false);

	const grouped = $derived(groupSessions(snapshot.sessions, pinnedSessionIds, aliveBotIds, botsById));
	const archivedSessions = $derived(
		snapshot.sessions.filter((s) => {
			if (s.kind === 'direct') {
				const parts = s.participants.filter((p) => p.left_at === null).map((p) => p.member);
				const bots = parts.filter((m) => m !== USER_MEMBER);
				if (bots.some((m) => !aliveBotIds.has(m))) return false;
			}
			return isSessionArchived(s, botsById);
		})
	);
	const pinnedSessions = $derived(
		pinnedSessionIds
			.map((id) => snapshot.sessions.find((s) => s.id === id))
			.filter((s): s is SessionSummary => Boolean(s))
			.filter((s) => !isSessionArchived(s, botsById))
			.filter((s) => {
				if (s.kind === 'direct') {
					const parts = s.participants.filter((p) => p.left_at === null).map((p) => p.member);
					const bots = parts.filter((m) => m !== USER_MEMBER);
					if (bots.some((m) => !aliveBotIds.has(m))) return false;
				}
				return true;
			})
	);
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
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		idle: t.sidebar.statusIdle
	});
	const selectedWork = $derived(
		selected
			? sidebarStatus(
					selected,
					snapshot.turns,
					snapshot.approvals,
					statusLabels,
					snapshot.pendingJudgements
				)
			: null
	);
	const thinkingHere = $derived(Boolean(selectedWork?.isBusy));
	const liveTurn = $derived(
		liveTurnsHere.find((turn) => turn.id === runtime.focusedTurnId) ?? liveTurnsHere[0]
	);
	let askDrafts = $state<Record<string, string>>({});
	const connected = $derived(runtime.connection === 'connected');
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const searchKindLabels = $derived({
		bot: t.sidebar.searchKindBot,
		session: t.sidebar.searchKindSession,
		message: t.sidebar.searchKindMessage,
		routine: t.sidebar.searchKindRoutine,
		file: t.sidebar.searchKindFile
	});
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
	const availableModels = $derived(availableModelOptions.map((option) => option.value));
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
	const groupCanRemove = $derived(selected?.kind === 'group' ? canRemoveGroupBot(selected) : false);
	const groupCandidates = $derived(
		selected?.kind === 'group' ? pullInCandidates(visibleBots, selected) : []
	);
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
	let fieldErrors = $state<SettingsFieldErrors>({});
	let saveFailed = $state(false);
	let activeSettingsTab = $state<'general' | 'preferences' | 'models' | 'mcp' | 'about'>('general');
	let dismissedOnboarding = $state(false);
	const showOnboarding = $derived(!snapshot.settings.wizard_complete && !dismissedOnboarding);
	const generalHasError = $derived(Boolean(fieldErrors.workspace));
	/**
	 * The one endpoint editor that can be open. Adding and editing used to be two parallel sets of
	 * state — five scalars for the add form, five maps keyed by the endpoint being edited — for a
	 * flyout that only ever shows one of them.
	 */
	type ProviderEditorState = {
		/** `'add'`, or the id of the endpoint being edited. */
		target: 'add' | string;
		draft: ProviderDraft;
		errors: ProviderFieldErrors;
		failed: boolean;
		fetching: boolean;
		fetchError: string | null;
	};
	let providerEditor = $state<ProviderEditorState | null>(null);
	let providerProbeTimer: ReturnType<typeof setTimeout> | null = null;
	/** URL + key the open editor last asked the endpoint about; the same pair is not probed twice. */
	let providerProbedSignature: string | null = null;
	const modelsHasError = $derived(
		Boolean(
			providerEditor &&
				(providerEditor.errors.name ||
					providerEditor.errors.endpoint ||
					providerEditor.errors.endpointKey ||
					providerEditor.errors.models ||
					providerEditor.errors.defaultModel)
		)
	);
	let botDraft = $state<CreateBotDraft>({ name: '', duties: '', boundaries: '', model: '', thinkingLevel: '' });
	let botErrors = $state<CreateBotFieldErrors>({});
	let botFailed = $state(false);
	let groupName = $state('');
	let groupMembers = $state<string[]>([]);
	let groupErrors = $state<CreateGroupFieldErrors>({});
	let groupFailed = $state(false);
	let profileDraft = $state<ProfileFields>({
		name: '',
		duties: '',
		boundaries: '',
		model: '',
		thinkingLevel: ''
	});
	let profileBaseline = $state<ProfileFields>({
		name: '',
		duties: '',
		boundaries: '',
		model: '',
		thinkingLevel: ''
	});
	let profileErrors = $state<CreateBotFieldErrors>({});
	let profileFailed = $state(false);
	let profileSaving = $state(false);
	/** Bumps after each successful autosave so the panel can say so; reset when a profile opens. */
	let profileSavedTick = $state(0);
	let profileSaveTimer: ReturnType<typeof setTimeout> | null = null;
	/** The Bot the current draft belongs to; a save resolving after a switch must not touch the new draft. */
	let profileSaveBotId: string | null = null;
	let profileSaveQueued = false;
	/**
	 * One confirm at a time. These used to be five booleans that each cleared the other four on the
	 * way up; every opener, every close path and the window handler had to keep that list in sync.
	 */
	type DangerConfirm =
		| { kind: 'bot' }
		| { kind: 'group' }
		| { kind: 'history' }
		| { kind: 'skill'; id: string }
		| { kind: 'provider'; id: string };
	let dangerConfirm = $state<DangerConfirm | null>(null);

	/** Drop the confirm only when it is one of these kinds, as the per-flag resets used to. */
	function clearDanger(...kinds: DangerConfirm['kind'][]): void {
		if (dangerConfirm && kinds.includes(dangerConfirm.kind)) dangerConfirm = null;
	}
	let skillEditor = $state<'add' | string | null>(null);
	let skillDraft = $state<SkillDraft>(emptySkillDraft());
	let skillBaseline = $state<SkillDraft>(emptySkillDraft());
	let skillErrors = $state<SkillFieldErrors>({});
	let skillFailed = $state(false);
	let skillBusy = $state(false);
	const profileSkills = $derived(
		runtime.profileBotId
			? snapshot.skills.filter((skill) => skill.bot_id === runtime.profileBotId)
			: []
	);
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
	let detailName = $state('');
	let detailNameError = $state<'empty' | undefined>();
	let detailFailed = $state(false);
	let detailSessionId = $state<string | null>(null);
	let pullPick = $state('');
	let copiedMessageId = $state<string | null>(null);
	let streamContainer = $state<HTMLElement | null>(null);
	let streamInner = $state<HTMLElement | null>(null);
	let showScrollBottom = $state(false);
	let stickToBottom = $state(true);
	let ignoreStreamScroll = false;
	let jumpToBottom = false;
	let jumpToBottomTimer: ReturnType<typeof setTimeout> | null = null;
	let nowMs = $state(Date.now());
	let editorEl = $state<HTMLDivElement | null>(null);
	let composerIme = $state<ComposerImeState>(COMPOSER_IME_IDLE);

	type PendingAttachment = {
		id: string;
		file: File;
		name: string;
		size: number;
		isImage: boolean;
		previewUrl: string | null;
	};

	let pendingAttachments = $state<PendingAttachment[]>([]);
	let fileInputEl = $state<HTMLInputElement | null>(null);
	const primaryAction = $derived(composerAction({
		connected,
		hasSession: Boolean(selected),
		locked: lockedComposer,
		hasLiveTurn: Boolean(liveTurn),
		pendingJudgement: pendingHere.length > 0,
		busy: runtime.busy,
		hasContent: Boolean(runtime.draft.trim()) || pendingAttachments.length > 0,
		sessionKind: selected?.kind ?? null,
	}));

	type MentionCandidate = {
		id: string;
		name: string;
		isEveryone: boolean;
		avatar?: string | null;
		duties?: string;
	};

	let showMentionPopup = $state(false);
	let mentionQuery = $state('');
	let mentionAnchorIndex = $state(-1);
	let mentionHighlightIndex = $state(0);
	let mentionDismissed = $state(false);
	let mentionPopupEl = $state<HTMLDivElement | null>(null);

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

	const mentionCandidates = $derived.by<MentionCandidate[]>(() => {
		if (!showMentionPopup) return [];
		const q = mentionQuery.toLowerCase();
		const results: MentionCandidate[] = [];
		const isGroup = selected?.kind === 'group';
		if (isGroup && 'everyone'.includes(q)) {
			results.push({
				id: 'everyone',
				name: 'everyone',
				isEveryone: true,
				duties: t.chat.mentionTooltip,
			});
		}
		const botsList = isGroup
			? groupPresent.map((id) => botsById.get(id)).filter((b): b is Bot => Boolean(b))
			: visibleBots;
		for (const b of botsList) {
			if (b.name.toLowerCase().includes(q) || (b.duties && b.duties.toLowerCase().includes(q))) {
				results.push({
					id: b.id,
					name: b.name,
					isEveryone: false,
					avatar: b.avatar,
					duties: b.duties,
				});
			}
		}
		return results;
	});

	$effect(() => {
		if (mentionHighlightIndex >= mentionCandidates.length && mentionCandidates.length > 0) {
			mentionHighlightIndex = mentionCandidates.length - 1;
		}
	});

	function scrollMentionHighlightIntoView(index = mentionHighlightIndex): void {
		const popup = mentionPopupEl;
		if (!popup) return;
		const item = popup.querySelectorAll<HTMLElement>('.autocomplete-item')[index];
		if (!item) return;
		const popupRect = popup.getBoundingClientRect();
		const itemRect = item.getBoundingClientRect();
		popup.scrollTop = scrollTopToRevealRect(
			popup.scrollTop,
			popupRect.top,
			popupRect.bottom,
			itemRect.top,
			itemRect.bottom
		);
	}

	$effect(() => {
		showMentionPopup = false;
		mentionDismissed = false;
		mentionQuery = '';
		mentionAnchorIndex = -1;
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
		const targetDraft = runtime.draft;
		if (editorEl) {
			const currentSerialized = serializeEditorText(editorEl);
			if (targetDraft !== currentSerialized) {
				if (!targetDraft) {
					editorEl.innerHTML = '';
				} else {
					setEditorContentFromText(editorEl, targetDraft, botsById);
				}
			}
		}
	});

	$effect(() => {
		document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';
	});

	$effect(() => {
		if (!runtime.sessionSettingsOpen || !runtime.profileBotId) {
			untrack(() => flushProfileSave());
			if (skillEditor) closeSkillEditor();
			return;
		}
		const bot = snapshot.bots.find((row) => row.id === runtime.profileBotId);
		if (!bot) {
			runtime.profileBotId = null;
			return;
		}
		const incoming = {
			name: bot.name,
			duties: bot.duties,
			boundaries: bot.boundaries,
			avatar: bot.avatar ?? '',
			model: botModelValue(bot),
			thinkingLevel: bot.thinking_level ?? ''
		};
		const next = reconcileProfileDraft(profileDraft, profileBaseline, incoming);
		if (profileDraftDirty(profileDraft, next.draft)) profileDraft = next.draft;
		if (profileDraftDirty(profileBaseline, next.baseline)) profileBaseline = next.baseline;
		if (skillEditor && skillEditor !== 'add') {
			const live = snapshot.skills.find((skill) => skill.id === skillEditor);
			if (!live || live.bot_id !== bot.id) {
				closeSkillEditor();
			} else {
				const incomingSkill = {
					name: live.name,
					description: live.description,
					body: live.body,
					uses: formatSkillUses(live.uses),
					enabled: live.enabled
				};
				const nextSkill = reconcileSkillDraft(skillDraft, skillBaseline, incomingSkill);
				if (skillDraftDirty(skillDraft, nextSkill.draft)) skillDraft = nextSkill.draft;
				if (skillDraftDirty(skillBaseline, nextSkill.baseline)) skillBaseline = nextSkill.baseline;
			}
		}
	});

	$effect(() => {
		const session = selected;
		if (!session) {
			detailSessionId = null;
			clearDanger('group', 'history');
			return;
		}
		if (detailSessionId === session.id) return;
		detailSessionId = session.id;
		detailName = session.kind === 'group' ? (session.name ?? '') : '';
		detailNameError = undefined;
		detailFailed = false;
		pullPick = '';
		clearDanger('group', 'history');
	});

	$effect(() => {
		if (!runtime.sessionSettingsOpen) {
			clearDanger('bot', 'group', 'history');
		}
	});

	$effect(() => {
		if (!runtime.settingsOpen) {
			if (providerEditor) closeProviderEditor();
			clearDanger('provider');
			return;
		}
		const openEditor = providerEditor;
		if (
			openEditor &&
			openEditor.target !== 'add' &&
			!snapshot.providers.some((row) => row.id === openEditor.target)
		) {
			closeProviderEditor();
		}
		const pendingProvider = dangerConfirm;
		if (
			pendingProvider?.kind === 'provider' &&
			!snapshot.providers.some((row) => row.id === pendingProvider.id)
		) {
			dangerConfirm = null;
		}
	});

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

	function who(message: Message): string {
		if (message.author === USER_MEMBER) return t.common.you;
		return botsById.get(message.author)?.name ?? t.top.deleted;
	}

	function whoAuthor(author: string): string {
		if (author === USER_MEMBER) return t.common.you;
		return botsById.get(author)?.name ?? t.top.deleted;
	}

	function archivedSuffix(session: SessionSummary): string {
		if (session.archived_at) return ` · ${t.top.archived}`;
		const peer = youBotPeer(session);
		if (!peer) return '';
		return botsById.get(peer)?.archived_at ? ` · ${t.top.archived}` : '';
	}

	function memberLabel(id: string): string {
		if (id === USER_MEMBER) return t.common.you;
		const bot = botsById.get(id);
		if (!bot) return t.top.deleted;
		return bot.archived_at ? `${bot.name} · ${t.top.archived}` : bot.name;
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
			openArtifactPath(hit.path);
			return;
		}
		const jump = searchJump(hit, snapshot.sessions);
		if (!jump) return;
		runtime.closeSearch();
		void runtime.selectSession(jump.sessionId, { messageId: jump.messageId });
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

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	function clearWorkspaceError(): void {
		if (fieldErrors.workspace) fieldErrors = { ...fieldErrors, workspace: undefined };
	}

	/** A new endpoint has no key on file yet; an existing one's is whatever the snapshot says. */
	function editorKeySet(target: 'add' | string): boolean {
		if (target === 'add') return false;
		return snapshot.providers.find((row) => row.id === target)?.key_set ?? false;
	}

	/** Write into the open editor, but only while it is still that one — awaits can outlive it. */
	function patchProviderEditor(target: 'add' | string, patch: Partial<ProviderEditorState>): void {
		const editor = providerEditor;
		if (!editor || editor.target !== target) return;
		providerEditor = { ...editor, ...patch };
	}

	function setProviderDraft(draft: ProviderDraft): void {
		const editor = providerEditor;
		if (!editor) return;
		const synced = withSyncedDefaultModel(draft);
		providerEditor = { ...editor, draft: synced, errors: {}, failed: false };
		scheduleProviderProbe(editor.target, synced, editorKeySet(editor.target));
	}

	function resetProviderProbe(): void {
		if (providerProbeTimer) clearTimeout(providerProbeTimer);
		providerProbeTimer = null;
		providerProbedSignature = null;
	}

	/** Asks the endpoint for its models once the URL and key are usable, a moment after typing stops. */
	function scheduleProviderProbe(target: 'add' | string, draft: ProviderDraft, keySet: boolean): void {
		const signature = probeSignature(draft, keySet);
		if (providerProbeTimer) clearTimeout(providerProbeTimer);
		providerProbeTimer = null;
		if (!signature || signature === providerProbedSignature) return;
		providerProbeTimer = setTimeout(() => {
			providerProbeTimer = null;
			if (providerEditor?.target !== target) return;
			providerProbedSignature = signature;
			void fetchProviderModels();
		}, 700);
	}

	function openProviderEditor(target: 'add' | string, draft: ProviderDraft): void {
		resetProviderProbe();
		providerEditor = {
			target,
			draft,
			errors: {},
			failed: false,
			fetching: false,
			fetchError: null
		};
	}

	function openAddProvider(): void {
		openProviderEditor('add', emptyProviderDraft());
	}

	function openEditProvider(id: string): void {
		const provider = snapshot.providers.find((row) => row.id === id);
		if (!provider) return;
		const draft = draftFromProvider(provider);
		openProviderEditor(id, draft);
		// The stored URL + key count as already asked, so only changing one of them probes again.
		const signature = probeSignature(draft, provider.key_set);
		providerProbedSignature = signature;
		// Endpoints saved before the list was kept have nothing to show yet; ask once on open.
		if (provider.available_models.length === 0 && signature) void fetchProviderModels();
	}

	function closeProviderEditor(): void {
		resetProviderProbe();
		providerEditor = null;
	}

	function closeSettings(): void {
		closeProviderEditor();
		clearDanger('provider');
		runtime.settingsOpen = false;
	}

	async function fetchProviderModels(): Promise<void> {
		const editor = providerEditor;
		if (!editor) return;
		const { target } = editor;
		const baseUrl = editor.draft.baseUrl.trim();
		if (!baseUrl) {
			patchProviderEditor(target, { fetchError: t.settings.endpointEmpty });
			return;
		}
		const keySet = editorKeySet(target);
		const requested = probeSignature(editor.draft, keySet);
		patchProviderEditor(target, { fetching: true, fetchError: null });
		const res = await runtime.probeModels(
			baseUrl,
			editor.draft.apiKey,
			target === 'add' ? undefined : target
		);
		// The editor may have closed or moved to another URL / key while the request was out.
		const open = providerEditor;
		if (!open || open.target !== target || probeSignature(open.draft, keySet) !== requested) return;
		if (!res.ok) {
			providerEditor = {
				...open,
				fetching: false,
				fetchError: `${t.settings.modelsFetchFailed} (${res.error})`
			};
			return;
		}
		providerEditor = {
			...open,
			fetching: false,
			draft: applyProbedModels(open.draft, res),
			errors: {}
		};
	}

	async function saveProvider(): Promise<void> {
		const editor = providerEditor;
		if (!editor || editor.target === 'add') return;
		const id = editor.target;
		const provider = snapshot.providers.find((row) => row.id === id);
		if (!provider) return;
		patchProviderEditor(id, { failed: false });
		const plan = planPatchProvider(provider, editor.draft);
		if (!plan.ok) {
			patchProviderEditor(id, { errors: plan.errors });
			return;
		}
		if (Object.keys(plan.patch).length === 0) {
			closeProviderEditor();
			return;
		}
		const error = await runtime.patchProvider(id, plan.patch);
		if (error) {
			const mapped = mapProviderError(error.message);
			if ('top' in mapped) patchProviderEditor(id, { failed: true });
			else patchProviderEditor(id, { errors: mapped });
			return;
		}
		closeProviderEditor();
	}

	async function addProvider(): Promise<void> {
		const editor = providerEditor;
		if (!editor || editor.target !== 'add') return;
		patchProviderEditor('add', { failed: false });
		const plan = planCreateProvider(editor.draft, true);
		if (!plan.ok) {
			patchProviderEditor('add', { errors: plan.errors });
			return;
		}
		const error = await runtime.createProvider(plan.body);
		if (error) {
			const mapped = mapProviderError(error.message);
			if ('top' in mapped) patchProviderEditor('add', { failed: true });
			else patchProviderEditor('add', { errors: mapped });
			return;
		}
		closeProviderEditor();
	}

	async function setDefaultProvider(id: string): Promise<void> {
		saveFailed = false;
		const error = await runtime.patchSettings({ default_provider_id: id });
		if (error) saveFailed = true;
	}

	function openDeleteProviderConfirm(id: string): void {
		dangerConfirm = { kind: 'provider', id };
	}

	async function deleteProvider(id: string): Promise<void> {
		if (dangerConfirm?.kind !== 'provider' || dangerConfirm.id !== id) return;
		saveFailed = false;
		const error = await runtime.deleteProvider(id);
		if (error) {
			saveFailed = true;
			dangerConfirm = null;
			return;
		}
		dangerConfirm = null;
		if (providerEditor?.target === id) closeProviderEditor();
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

	async function saveSettings(): Promise<void> {
		saveFailed = false;
		fieldErrors = {};
		const plan = planWorkspaceSave(runtime.workspacePath);
		if (!plan.ok) {
			fieldErrors = { workspace: plan.error };
			activeSettingsTab = 'general';
			return;
		}
		const error = await runtime.patchSettings({ workspace_path: plan.workspace_path });
		if (!error) {
			closeSettings();
			return;
		}
		const mapped = mapSettingsError(error.message);
		if ('workspace' in mapped) {
			fieldErrors = { workspace: mapped.workspace };
			activeSettingsTab = 'general';
		} else {
			saveFailed = true;
		}
	}

	function syncDraftFromEditor(): void {
		if (!editorEl) return;
		runtime.draft = serializeEditorText(editorEl);
	}

	function checkMentionTrigger(): void {
		if (!editorEl) {
			showMentionPopup = false;
			mentionDismissed = false;
			mentionQuery = '';
			mentionAnchorIndex = -1;
			return;
		}
		const textBefore = getTextBeforeCaret(editorEl);
		const trigger = detectMentionTrigger(textBefore, textBefore.length);
		if (!trigger.active) {
			showMentionPopup = false;
			mentionQuery = '';
			mentionAnchorIndex = -1;
			mentionHighlightIndex = 0;
			mentionDismissed = false;
			return;
		}

		if (
			mentionDismissed &&
			trigger.anchorIndex === mentionAnchorIndex &&
			trigger.query === mentionQuery
		) {
			return;
		}

		const shouldResetHighlight =
			!showMentionPopup ||
			trigger.query !== mentionQuery ||
			trigger.anchorIndex !== mentionAnchorIndex;

		showMentionPopup = true;
		mentionQuery = trigger.query;
		mentionAnchorIndex = trigger.anchorIndex;
		mentionHighlightIndex = shouldResetHighlight ? 0 : mentionHighlightIndex;
		mentionDismissed = false;
	}

	function selectMentionCandidate(candidate: MentionCandidate): void {
		if (!editorEl) return;
		insertMentionChipAtCaret(editorEl, candidate, botsById);
		syncDraftFromEditor();
		showMentionPopup = false;
		mentionDismissed = false;
		mentionQuery = '';
		mentionAnchorIndex = -1;
		editorEl.focus();
	}

	function onEditorInput(): void {
		syncDraftFromEditor();
		checkMentionTrigger();
	}

	function onEditorClick(ev: MouseEvent): void {
		const target = ev.target as HTMLElement | null;
		if (target) {
			const closeBtn = target.closest('.chip-close-btn');
			if (closeBtn) {
				ev.preventDefault();
				ev.stopPropagation();
				const chip = closeBtn.closest('.inline-mention-chip') as HTMLElement | null;
				if (chip) {
					deleteChipElement(chip);
					syncDraftFromEditor();
					checkMentionTrigger();
					editorEl?.focus();
				}
				return;
			}
		}
		checkMentionTrigger();
	}

	function addFiles(files: FileList | File[]): void {
		const next: PendingAttachment[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) continue;
			const isImage = file.type.startsWith('image/');
			let previewUrl: string | null = null;
			if (isImage) {
				previewUrl = URL.createObjectURL(file);
			}
			const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
			let name = file.name;
			if (!name || name === 'image.png' || name === 'blob') {
				name = `image-${Date.now().toString().slice(-4)}.png`;
			}
			next.push({ id, file, name, size: file.size, isImage, previewUrl });
		}
		pendingAttachments = [...pendingAttachments, ...next];
	}

	function removePendingAttachment(id: string): void {
		const target = pendingAttachments.find((a) => a.id === id);
		if (target?.previewUrl) {
			URL.revokeObjectURL(target.previewUrl);
		}
		pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
	}

	function onComposerPaste(ev: ClipboardEvent): void {
		if (lockedComposer || !selected) {
			ev.preventDefault();
			return;
		}
		const items = ev.clipboardData?.items;
		if (items) {
			const files: File[] = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const file = item.getAsFile();
					if (file) files.push(file);
				}
			}
			if (files.length > 0) {
				ev.preventDefault();
				addFiles(files);
				return;
			}
		}

		ev.preventDefault();
		const text = ev.clipboardData?.getData('text/plain') || '';
		if (!text) return;
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0 && editorEl?.contains(sel.anchorNode)) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const textNode = document.createTextNode(text);
			range.insertNode(textNode);
			range.setStartAfter(textNode);
			range.setEndAfter(textNode);
			sel.removeAllRanges();
			sel.addRange(range);
		} else if (editorEl) {
			editorEl.appendChild(document.createTextNode(text));
		}
		syncDraftFromEditor();
		checkMentionTrigger();
	}

	function onFileInputChange(ev: Event): void {
		const input = ev.currentTarget as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			addFiles(input.files);
			input.value = '';
		}
	}

	function openFilePicker(): void {
		if (lockedComposer || !connected || !selected || runtime.busy) return;
		fileInputEl?.click();
	}

	async function handleSend(): Promise<void> {
		if (editorEl) syncDraftFromEditor();
		if (primaryAction.kind !== 'send' || primaryAction.disabled) return;
		const files = pendingAttachments.map((a) => a.file);
		for (const a of pendingAttachments) {
			if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
		}
		pendingAttachments = [];
		stickToBottom = true;
		await runtime.send({ attachments: files.length > 0 ? files : undefined });
		if (editorEl) {
			editorEl.innerHTML = '';
		}
		await tick();
		scrollToBottom(false);
	}

	function onComposerCompositionStart(): void {
		composerIme = composerImeOnStart();
	}

	function onComposerCompositionUpdate(): void {
		composerIme = composerImeOnUpdate(composerIme);
	}

	function onComposerCompositionEnd(): void {
		composerIme = composerImeOnEnd(performance.now());
	}

	function onComposerKey(ev: KeyboardEvent): void {
		const imeAction = composerImeKeyAction(
			{
				isComposing: ev.isComposing,
				key: ev.key,
				keyCode: ev.keyCode,
				which: ev.which,
				shiftKey: ev.shiftKey,
				metaKey: ev.metaKey,
				ctrlKey: ev.ctrlKey
			},
			composerIme,
			performance.now()
		);
		if (imeAction === 'swallow') {
			ev.preventDefault();
			composerIme = COMPOSER_IME_IDLE;
			return;
		}
		if (imeAction === 'ignore' || lockedComposer || !selected) return;
		if (showMentionPopup) {
			if (mentionCandidates.length > 0) {
				if (ev.key === 'ArrowDown') {
					ev.preventDefault();
					ev.stopPropagation();
					const next = (mentionHighlightIndex + 1) % mentionCandidates.length;
					mentionHighlightIndex = next;
					scrollMentionHighlightIntoView(next);
					return;
				}
				if (ev.key === 'ArrowUp') {
					ev.preventDefault();
					ev.stopPropagation();
					const next =
						(mentionHighlightIndex - 1 + mentionCandidates.length) % mentionCandidates.length;
					mentionHighlightIndex = next;
					scrollMentionHighlightIntoView(next);
					return;
				}
				if (ev.key === 'Enter' || ev.key === 'Tab') {
					ev.preventDefault();
					ev.stopPropagation();
					const candidate = mentionCandidates[mentionHighlightIndex];
					if (candidate) {
						selectMentionCandidate(candidate);
					}
					return;
				}
			}
			if (ev.key === 'Escape') {
				ev.preventDefault();
				ev.stopPropagation();
				showMentionPopup = false;
				mentionDismissed = true;
				return;
			}
		}

		if (ev.key === 'Backspace' && editorEl) {
			if (handleEditorBackspace(editorEl)) {
				ev.preventDefault();
				ev.stopPropagation();
				syncDraftFromEditor();
				checkMentionTrigger();
				return;
			}
		}

		if (ev.key === 'Delete' && editorEl) {
			if (handleEditorDelete(editorEl)) {
				ev.preventDefault();
				ev.stopPropagation();
				syncDraftFromEditor();
				checkMentionTrigger();
				return;
			}
		}

		if ((ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) || (ev.key === 'Enter' && !ev.shiftKey)) {
			ev.preventDefault();
			void handleSend();
			return;
		}

		if (ev.key === 'Enter' && ev.shiftKey) {
			ev.preventDefault();
			if (editorEl) insertComposerNewline(editorEl);
			syncDraftFromEditor();
			return;
		}
	}

	function onComposerKeyUp(ev: KeyboardEvent): void {
		if (shouldIgnoreKeyUp(ev.key)) {
			return;
		}
		syncDraftFromEditor();
		checkMentionTrigger();
	}

	function onWindowClick(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (showMentionPopup && isOutside(target, editorEl, mentionPopupEl)) {
			showMentionPopup = false;
			mentionDismissed = false;
		}
		if (themeMenuOpen && isOutside(target, themeMenuEl, themeToggleBtnEl)) {
			themeMenuOpen = false;
		}
		if (searchFocused && isOutside(target, searchWrapEl)) {
			searchFocused = false;
		}
	}

	function pickStarterPrompt(prompt: string): void {
		runtime.draft = prompt;
		if (editorEl) {
			setEditorContentFromText(editorEl, prompt, botsById);
			editorEl.focus();
		}
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

	const quoteTarget = $derived(
		runtime.replyingToId
			? (snapshot.messages.find((m) => m.id === runtime.replyingToId) ?? null)
			: null
	);

	function startQuoteReply(message: Message): void {
		if (lockedComposer || !canQuoteReply(message)) return;
		runtime.replyingToId = message.id;
		const name = quotedBotName(message, botsById);
		if (name) {
			runtime.draft = draftWithQuoteMention(runtime.draft, name);
			if (editorEl) {
				setEditorContentFromText(editorEl, runtime.draft, botsById);
			}
		}
		void tick().then(() => editorEl?.focus());
	}

	function cancelQuoteReply(): void {
		runtime.replyingToId = null;
	}

	function quoteLabel(message: Message): string {
		if (message.author === USER_MEMBER) return t.chat.replyToYou;
		const name = quotedBotName(message, botsById);
		return name ? t.chat.replyTo(name) : t.chat.replyToDeleted;
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


	function emptyBot(): CreateBotDraft {
		return { name: '', duties: '', boundaries: '', avatar: '', model: '', thinkingLevel: '' };
	}

	function botModelValue(bot: Bot): string {
		if (!bot.model) return '';
		if (bot.provider_id) return modelSelectValue(bot.provider_id, bot.model);
		const match = snapshot.providers.find((provider) => provider.models.includes(bot.model!));
		return match ? modelSelectValue(match.id, bot.model) : bot.model;
	}

	function emptyProfile(bot: Bot): ProfileFields {
		return {
			name: bot.name,
			duties: bot.duties,
			boundaries: bot.boundaries,
			avatar: bot.avatar ?? '',
			model: botModelValue(bot),
			thinkingLevel: bot.thinking_level ?? ''
		};
	}

	function openProfile(botId: string): void {
		const bot = botsById.get(botId);
		if (!bot) return;
		flushProfileSave();
		profileDraft = emptyProfile(bot);
		profileBaseline = emptyProfile(bot);
		profileErrors = {};
		profileFailed = false;
		profileSavedTick = 0;
		clearDanger('bot');
		closeSkillEditor();
		runtime.openProfile(botId);
	}

	function closeSkillEditor(): void {
		skillEditor = null;
		skillDraft = emptySkillDraft();
		skillBaseline = emptySkillDraft();
		skillErrors = {};
		skillFailed = false;
		skillBusy = false;
		clearDanger('skill');
	}

	function openAddSkill(): void {
		skillEditor = 'add';
		skillDraft = emptySkillDraft();
		skillBaseline = emptySkillDraft();
		skillErrors = {};
		skillFailed = false;
	}

	function openEditSkill(id: string): void {
		const skill = snapshot.skills.find((row) => row.id === id);
		if (!skill) return;
		skillEditor = id;
		skillDraft = {
			name: skill.name,
			description: skill.description,
			body: skill.body,
			uses: formatSkillUses(skill.uses),
			enabled: skill.enabled
		};
		skillBaseline = { ...skillDraft };
		skillErrors = {};
		skillFailed = false;
	}

	function skillNameCopy(kind: 'empty' | 'conflict' | undefined): string {
		if (kind === 'conflict') return t.sidebar.skillNameConflict;
		return t.sidebar.skillNameEmpty;
	}

	async function saveSkill(): Promise<void> {
		if (!runtime.profileBotId || !skillEditor) return;
		skillFailed = false;
		skillErrors = {};
		const plan = planSkill(skillDraft);
		if (!plan.ok) {
			skillErrors = plan.errors;
			return;
		}
		skillBusy = true;
		const error =
			skillEditor === 'add'
				? await runtime.createSkill({ bot_id: runtime.profileBotId, ...plan.body })
				: await runtime.patchSkill(skillEditor, plan.body);
		skillBusy = false;
		if (!error) {
			closeSkillEditor();
			return;
		}
		const mapped = mapSkillError(error.status, error.message);
		if ('top' in mapped) skillFailed = true;
		else skillErrors = mapped;
	}

	async function toggleSkillEnabled(id: string, enabled: boolean): Promise<void> {
		skillFailed = false;
		const error = await runtime.patchSkill(id, { enabled });
		if (error) skillFailed = true;
	}

	function openDeleteSkillConfirm(id: string): void {
		dangerConfirm = { kind: 'skill', id };
	}

	async function deleteSkillRow(): Promise<void> {
		if (dangerConfirm?.kind !== 'skill') return;
		const skillId = dangerConfirm.id;
		skillFailed = false;
		const error = await runtime.deleteSkill(skillId);
		if (error) {
			skillFailed = true;
			return;
		}
		if (skillEditor === skillId) closeSkillEditor();
		dangerConfirm = null;
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
		flushProfileSave();
		runtime.profileBotId = null;
		clearDanger('bot');
		profileErrors = {};
		profileFailed = false;
		closeSkillEditor();
	}

	const profileThinkingOptions = $derived(
		pinnableThinkingLevels(profileDraft.model, snapshot.providers)
	);
	const botThinkingOptions = $derived(pinnableThinkingLevels(botDraft.model, snapshot.providers));

	function onProfileInput(): void {
		profileErrors = {};
		profileFailed = false;
		scheduleProfileSave();
	}

	/** Picks (model, thinking level, avatar) are deliberate, so they save almost at once. */
	function onProfilePick(): void {
		profileErrors = {};
		profileFailed = false;
		scheduleProfileSave(120);
	}

	function onProfileModelChange(value: string): void {
		const pinned = applyModelPin(value, profileDraft.thinkingLevel, snapshot.providers);
		profileDraft.model = pinned.model;
		profileDraft.thinkingLevel = pinned.thinkingLevel;
		onProfilePick();
	}

	function pickProfileThinking(level: string): void {
		if (profileDraft.thinkingLevel === level) return;
		profileDraft.thinkingLevel = level;
		onProfilePick();
	}

	function onBotModelChange(value: string): void {
		const pinned = applyModelPin(value, botDraft.thinkingLevel ?? '', snapshot.providers);
		botDraft.model = pinned.model;
		botDraft.thinkingLevel = pinned.thinkingLevel;
		onBotInput();
	}

	function pickBotThinking(level: string): void {
		botDraft.thinkingLevel = level;
		onBotInput();
	}

	function scheduleProfileSave(delay = 600): void {
		if (!runtime.profileBotId) return;
		profileSaveBotId = runtime.profileBotId;
		if (profileSaveTimer) clearTimeout(profileSaveTimer);
		profileSaveTimer = setTimeout(() => {
			profileSaveTimer = null;
			void saveProfile();
		}, delay);
	}

	/** Sends a pending autosave now: on close, on switching Bots, or when the panel goes away. */
	function flushProfileSave(): void {
		if (!profileSaveTimer) return;
		clearTimeout(profileSaveTimer);
		profileSaveTimer = null;
		void saveProfile();
	}

	async function saveProfile(): Promise<void> {
		const botId = profileSaveBotId;
		if (!botId) return;
		if (profileSaving) {
			profileSaveQueued = true;
			return;
		}
		const sent: ProfileFields = { ...profileDraft };
		if (!profileNeedsSave(sent, profileBaseline)) return;
		const plan = planCreateBot(sent, availableModels);
		if (!plan.ok) {
			if (profileSaveBotId === botId) profileErrors = plan.errors;
			return;
		}
		profileSaving = true;
		profileFailed = false;
		profileErrors = {};
		const error = await runtime.patchBot(botId, plan.body);
		profileSaving = false;
		const stillHere = profileSaveBotId === botId && runtime.profileBotId === botId;
		if (!error) {
			if (stillHere) {
				profileBaseline = sent;
				profileSavedTick += 1;
			}
		} else if (stillHere) {
			const mapped = mapCreateBotError(error.status, error.message);
			if ('top' in mapped) profileFailed = true;
			else profileErrors = mapped;
		}
		if (profileSaveQueued) {
			profileSaveQueued = false;
			void saveProfile();
		}
	}

	async function archiveProfile(): Promise<void> {
		if (!runtime.profileBotId) return;
		profileFailed = false;
		const error = await runtime.archiveBot(runtime.profileBotId);
		if (error) profileFailed = true;
	}

	async function restoreProfile(): Promise<void> {
		if (!runtime.profileBotId) return;
		profileFailed = false;
		const error = await runtime.restoreBot(runtime.profileBotId);
		if (error) profileFailed = true;
	}

	function dismissDangerConfirm(): void {
		requestAnimationFrame(() => {
			dangerConfirm = null;
		});
	}

	function openDeleteBotConfirm(): void {
		dangerConfirm = { kind: 'bot' };
	}

	function openDeleteGroupConfirm(): void {
		dangerConfirm = { kind: 'group' };
	}

	function openClearHistoryConfirm(): void {
		dangerConfirm = { kind: 'history' };
	}

	async function deleteProfile(): Promise<void> {
		if (!runtime.profileBotId || dangerConfirm?.kind !== 'bot') return;
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

	async function saveGroupName(): Promise<void> {
		if (!selected || selected.kind !== 'group') return;
		detailFailed = false;
		detailNameError = undefined;
		const plan = planGroupName(detailName);
		if (!plan.ok) {
			detailNameError = plan.error;
			return;
		}
		const error = await runtime.patchSession(selected.id, { name: plan.name });
		if (!error) {
			detailName = plan.name;
			return;
		}
		const mapped = mapGroupEditError(error.message);
		if ('name' in mapped) detailNameError = mapped.name;
		else detailFailed = true;
	}

	async function pullInMember(): Promise<void> {
		if (!selected || selected.kind !== 'group' || !pullPick) return;
		detailFailed = false;
		const error = await runtime.addMember(selected.id, pullPick);
		if (error) {
			detailFailed = true;
			return;
		}
		pullPick = '';
	}

	async function removeMember(botId: string): Promise<void> {
		if (!selected || selected.kind !== 'group' || !groupCanRemove) return;
		detailFailed = false;
		const error = await runtime.removeMember(selected.id, botId);
		if (error) detailFailed = true;
	}

	async function deleteGroupSession(): Promise<void> {
		if (!selected || selected.kind !== 'group' || dangerConfirm?.kind !== 'group') return;
		detailFailed = false;
		const error = await runtime.deleteSession(selected.id);
		if (error) {
			detailFailed = true;
			return;
		}
		dangerConfirm = null;
		runtime.closeSessionSettings();
	}

	async function clearGroupHistory(): Promise<void> {
		if (!selected || dangerConfirm?.kind !== 'history') return;
		detailFailed = false;
		const error = await runtime.clearSessionHistory(selected.id);
		if (error) {
			detailFailed = true;
			return;
		}
		dangerConfirm = null;
	}

	async function confirmDangerAction(): Promise<void> {
		if (dangerConfirmKind === 'bot') {
			await deleteProfile();
			return;
		}
		if (dangerConfirmKind === 'group') {
			await deleteGroupSession();
			return;
		}
		if (dangerConfirmKind === 'history') {
			await clearGroupHistory();
			return;
		}
		if (dangerConfirmKind === 'skill') {
			await deleteSkillRow();
			return;
		}
		if (dangerConfirm?.kind === 'provider') {
			await deleteProvider(dangerConfirm.id);
		}
	}

	function openCreateBot(): void {
		workspaceOpen = false;
		botDraft = emptyBot();
		botErrors = {};
		botFailed = false;
		runtime.openCreateBot();
	}

	function openCreateGroup(): void {
		workspaceOpen = false;
		groupName = '';
		groupMembers = [];
		groupErrors = {};
		groupFailed = false;
		runtime.openCreateGroup();
	}

	function onBotInput(): void {
		botErrors = {};
		botFailed = false;
	}

	function onGroupInput(): void {
		if (groupErrors.name) groupErrors = { ...groupErrors, name: undefined };
		groupFailed = false;
	}

	function toggleMember(id: string): void {
		groupMembers = groupMembers.includes(id)
			? groupMembers.filter((member) => member !== id)
			: [...groupMembers, id];
		if (groupErrors.members) groupErrors = { ...groupErrors, members: undefined };
		groupFailed = false;
	}

	function botNameCopy(kind: CreateBotFieldErrors['name']): string {
		if (kind === 'empty') return t.sidebar.nameEmpty;
		if (kind === 'conflict') return t.sidebar.nameConflict;
		return '';
	}

	async function saveBot(): Promise<void> {
		botFailed = false;
		botErrors = {};
		const plan = planCreateBot(botDraft, availableModels);
		if (!plan.ok) {
			botErrors = plan.errors;
			return;
		}
		const error = await runtime.createBot(plan.body);
		if (!error) return;
		const mapped = mapCreateBotError(error.status, error.message);
		if ('top' in mapped) botFailed = true;
		else botErrors = mapped;
	}

	async function saveGroup(): Promise<void> {
		groupFailed = false;
		groupErrors = {};
		const plan = planCreateGroup({ name: groupName, members: groupMembers });
		if (!plan.ok) {
			groupErrors = plan.errors;
			return;
		}
		const error = await runtime.createGroup(plan.body);
		if (!error) return;
		const mapped = mapCreateGroupError(error.status, error.message);
		if ('top' in mapped) groupFailed = true;
		else groupErrors = mapped;
	}
</script>

<svelte:window
	onclick={onWindowClick}
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
				closeProviderEditor();
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
							class:is-context-open={contextMenu?.session.id === pSession.id}
							class:is-run={pStatus.isBusy}
							class:is-unread={pUnread > 0}
							onclick={() => void runtime.selectSession(pSession.id)}
							oncontextmenu={(e) => openContextMenu(e, pSession)}
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
							class:is-context-open={contextMenu?.session.id === session.id}
							class:is-unread={unread > 0}
							onclick={() => void runtime.selectSession(session.id)}
							oncontextmenu={(e) => openContextMenu(e, session)}
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
					<button type="button" class="add" title={t.sidebar.addGroup} onclick={openCreateGroup}
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
						class:is-context-open={contextMenu?.session.id === session.id}
						class:is-unread={unread > 0}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => openContextMenu(e, session)}
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
					<button type="button" class="add" title={t.sidebar.addBot} onclick={openCreateBot}>+</button>
				</div>
				{#each grouped.youBot as session (session.id)}
					{@const status = statusOf(session)}
					{@const unread = unreadOf(session)}
					<button
						type="button"
						class="row"
						class:is-on={runtime.selectedId === session.id}
						class:is-context-open={contextMenu?.session.id === session.id}
						class:is-unread={unread > 0}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => openContextMenu(e, session)}
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
						class:is-context-open={contextMenu?.session.id === session.id}
						class:is-unread={unread > 0}
						onclick={() => void runtime.selectSession(session.id)}
						oncontextmenu={(e) => openContextMenu(e, session)}
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
					onclick={() => toggleWorkspaceExplorer()}
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
							onclick={() => selectTheme('system')}
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
							onclick={() => selectTheme('light')}
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
							onclick={() => selectTheme('dark')}
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
					onclick={() => {
						workspaceOpen = false;
						runtime.openSettings();
					}}
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
			<div class="sheet">
				<div class="sheet-head">
					<h2>{t.sidebar.addGroup}</h2>
					<button type="button" class="sheet-close" title={t.common.close} onclick={() => (runtime.createGroupOpen = false)}>✕</button>
				</div>
				{#if groupFailed}
					<p class="field-error">{t.sidebar.saveFailed}</p>
				{/if}
				<label for="group-name">{t.sidebar.groupName}</label>
				<input id="group-name" type="text" bind:value={groupName} oninput={onGroupInput} />
				{#if groupErrors.name}
					<p class="field-error">{t.sidebar.groupNameEmpty}</p>
				{/if}
				<p class="field-head">{t.sidebar.groupMembers}</p>
				<div class="members">
					{#each visibleBots as bot (bot.id)}
						<label>
							<input
								type="checkbox"
								checked={groupMembers.includes(bot.id)}
								onchange={() => toggleMember(bot.id)}
							/>
							{bot.name}
						</label>
					{/each}
				</div>
				{#if groupErrors.members}
					<p class="field-error">{t.sidebar.membersTooFew}</p>
				{/if}
				<div class="actions">
					<button type="button" onclick={() => void saveGroup()}>{t.sidebar.create}</button>
					<button type="button" onclick={() => (runtime.createGroupOpen = false)}
						>{t.common.close}</button
					>
				</div>
			</div>
		{/if}
	</aside>
	<button
		type="button"
		class="sidebar-split"
		aria-label={t.sidebar.resize}
		onpointerdown={startSidebarResize}
	></button>
	<section class="main">
		<header class="top">
			{#if selected}
				<div class="top-session-identity">
					<button
						type="button"
						class="btn-mobile-back"
						title={t.common.close}
						onclick={() => (runtime.selectedId = null)}
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
					</button>
					<button
						type="button"
						class="top-identity-btn"
						class:is-active={runtime.sessionSettingsOpen}
						title={sessionSettingsLabel}
						aria-expanded={runtime.sessionSettingsOpen}
						onclick={toggleSessionSettings}
					>
						{#if selectedKind === 'you-bot' && selectedPeerBot}
							{@const pal = botAvatarColor(selectedPeerBot.id)}
							{@const peerStatus = botStatusOf(selectedPeerBot.id)}
							<span
								class="top-avatar"
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
							>
								{#if avatarSrc(selectedPeerBot.avatar)}
									<img src={avatarSrc(selectedPeerBot.avatar)} alt={selectedPeerBot.name} class="avatar-img" />
								{:else}
									{rosterLetter(selectedPeerBot.name)}
								{/if}
								{#if !selectedPeerBot.archived_at}
									<span
										class="avatar-status-dot is-{peerStatus.kind}"
										class:is-busy={peerStatus.isBusy}
										title="{selectedPeerBot.name}: {peerStatus.label}"
									></span>
								{/if}
							</span>
						{:else}
							<span class="top-avatar is-composite">
								<SessionAvatar session={selected} bots={botsById} size="top" botStatus={botStatusOf} />
								<span class="avatar-status-dot" class:is-busy={thinkingHere}></span>
							</span>
						{/if}
						<span class="top-titles">
							<span class="top-title-text" role="heading" aria-level="1">{titleOf(selected)}{archivedSuffix(selected)}</span>
							<span class="top-subline">
								{#if selectedKind === 'you-bot' && selectedPeerBot}
									<span class="status-indicator">
										<span class="status-dot" class:is-busy={thinkingHere}></span>
										{selectedWork && selectedWork.kind !== 'idle' ? selectedWork.label : t.chat.online}
									</span>
									{#if selectedPeerBot.model}
										<span class="top-model-pill mono">{selectedPeerBot.model}</span>
									{/if}
								{/if}
								<span class="meta"
									>{sessionPresence(
										selected,
										botsById,
										t.common.you,
										selectedKind === 'group'
											? t.top.members
											: selectedKind === 'bot-bot'
												? t.top.presenceOpen
												: '',
										rosterLabels
									)}</span
								>
							</span>
						</span>
					</button>
				</div>

				<div class="top-actions">
					<button
						type="button"
						class="btn-top-action"
						class:is-active={isSessionPinned(pinnedSessionIds, selected.id)}
						title={isSessionPinned(pinnedSessionIds, selected.id) ? t.top.unpin : t.top.pin}
						onclick={() => togglePin(selected.id)}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill={isSessionPinned(pinnedSessionIds, selected.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="12" y1="17" x2="12" y2="22"></line>
							<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
						</svg>
						<span>{isSessionPinned(pinnedSessionIds, selected.id) ? t.top.pinned : t.top.pin}</span>
					</button>
					<button
						type="button"
						class="btn-top-action"
						class:is-active={runtime.routeLogOpen}
						title={t.routes.title}
						onclick={() => runtime.toggleRouteLog()}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="8" y1="6" x2="21" y2="6"></line>
							<line x1="8" y1="12" x2="21" y2="12"></line>
							<line x1="8" y1="18" x2="21" y2="18"></line>
							<line x1="3" y1="6" x2="3.01" y2="6"></line>
							<line x1="3" y1="12" x2="3.01" y2="12"></line>
							<line x1="3" y1="18" x2="3.01" y2="18"></line>
						</svg>
						<span>{t.routes.topAction}</span>
					</button>
					<button
						type="button"
						class="btn-top-action"
						class:is-active={runtime.sessionSettingsOpen}
						onclick={toggleSessionSettings}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<span>{sessionSettingsLabel}</span>
					</button>
				</div>
			{:else}
				<h1>{t.top.pickSession}</h1>
				{#if !snapshot.settings.wizard_complete}
					<button
						type="button"
						class="setup-guide-pill"
						onclick={() => (dismissedOnboarding = false)}
					>
						{t.onboarding.reopenGuide}
					</button>
				{/if}
				{#if visibleBots.length === 0}
					<button type="button" class="empty-roster" onclick={openCreateBot}
						>{t.top.emptyRoster}</button
					>
				{/if}
			{/if}
		</header>
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

		<footer class="composer">
			{#if selected && !lockedComposer && runtime.composerSuggestions.length > 0}
				<div class="composer-suggest-bar" aria-label={t.chat.suggestNext}>
					{#each runtime.composerSuggestions as suggestion (suggestion.id)}
						<button
							type="button"
							class="suggest-chip"
							title={suggestion.prompt}
							onclick={() => pickStarterPrompt(suggestion.prompt)}
						>
							{suggestion.label}
						</button>
					{/each}
				</div>
			{/if}

			{#if showMentionPopup && mentionCandidates.length > 0}
				<div
					bind:this={mentionPopupEl}
					class="mention-autocomplete-popup"
					role="listbox"
					tabindex="-1"
					onmousedown={(e) => e.preventDefault()}
				>
					<div class="autocomplete-header">{t.chat.mentionTooltip}</div>
					{#each mentionCandidates as cand, idx (cand.id)}
						{@const pal = !cand.isEveryone ? botAvatarColor(cand.id) : null}
						<button
							type="button"
							role="option"
							aria-selected={idx === mentionHighlightIndex}
							class="autocomplete-item"
							class:is-highlighted={idx === mentionHighlightIndex}
							onclick={() => selectMentionCandidate(cand)}
							onmouseenter={() => (mentionHighlightIndex = idx)}
						>
							{#if cand.isEveryone}
								<span class="autocomplete-avatar is-everyone">👥</span>
							{:else if cand.avatar && avatarSrc(cand.avatar)}
								<img src={avatarSrc(cand.avatar)} alt="" class="autocomplete-avatar-img" />
							{:else if pal}
								<span class="autocomplete-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border}">
									{rosterLetter(cand.name)}
								</span>
							{/if}
							<div class="autocomplete-info">
								<span class="autocomplete-name">@{cand.name}</span>
								{#if cand.duties}
									<span class="autocomplete-desc">{cand.duties}</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}

			<div
				class="composer-card"
				class:is-locked={lockedComposer}
				role="presentation"
				onclick={(e) => {
					const target = e.target as HTMLElement | null;
					if (selected && !lockedComposer && target && !target.closest('button, input, [contenteditable="true"]')) {
						editorEl?.focus();
					}
				}}
			>
				{#if quoteTarget}
					<div class="composer-quote-bar">
						<div class="composer-quote-meta">
							<span class="composer-quote-who">{quoteLabel(quoteTarget)}</span>
							<span class="composer-quote-body">{quotePreview(quoteTarget.body)}</span>
						</div>
						<button
							type="button"
							class="composer-quote-cancel"
							title={t.chat.cancelReply}
							aria-label={t.chat.cancelReply}
							onclick={cancelQuoteReply}
						>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
						</button>
					</div>
				{/if}
				{#if lockedComposer}
					<div class="composer-locked-message">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
						<span>{selected?.archived_at ? t.chat.groupLockedNotice : t.chat.lockedNotice}</span>
					</div>
				{/if}

				{#if pendingAttachments.length > 0}
					<div class="composer-attachments-bar">
						{#each pendingAttachments as att (att.id)}
							<div class="composer-attachment-item" class:is-img={att.isImage}>
								{#if att.isImage && att.previewUrl}
									<img src={att.previewUrl} alt={att.name} class="attachment-preview-img" />
								{:else}
									<div class="attachment-file-icon">
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
									</div>
								{/if}
								<div class="attachment-meta">
									<span class="attachment-name" title={att.name}>{att.name}</span>
									<span class="attachment-size mono">{formatFileSize(att.size)}</span>
								</div>
								<button
									type="button"
									class="attachment-delete-btn"
									title={t.composer.removeAttachment}
									aria-label="Remove attachment {att.name}"
									onclick={() => removePendingAttachment(att.id)}
								>
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
								</button>
							</div>
						{/each}
					</div>
				{/if}

				<div class="composer-row">
					<button
						type="button"
						class="attach-btn"
						title={t.composer.attach}
						aria-label={t.composer.attach}
						disabled={!connected || !selected || lockedComposer || runtime.busy}
						onclick={openFilePicker}
					>
						<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
						</svg>
					</button>
					<input
						type="file"
						multiple
						bind:this={fileInputEl}
						onchange={onFileInputChange}
						style="display: none;"
					/>
					<div
						bind:this={editorEl}
						class="composer-input"
						class:is-empty={!runtime.draft}
						role="textbox"
						aria-multiline="true"
						aria-label={selectedKind === 'you-bot' && selectedPeerBot ? `${t.chat.replyPrompt} ${selectedPeerBot.name}...` : t.composer.send}
						aria-describedby={!lockedComposer ? 'composer-hint' : undefined}
						data-placeholder={selectedKind === 'you-bot' && selectedPeerBot ? `${t.chat.replyPrompt} ${selectedPeerBot.name}...` : t.composer.send}
						contenteditable={Boolean(selected) && !lockedComposer}
						tabindex="0"
						oninput={onEditorInput}
						onkeydown={onComposerKey}
						onkeyup={onComposerKeyUp}
						oncompositionstart={onComposerCompositionStart}
						oncompositionupdate={onComposerCompositionUpdate}
						oncompositionend={onComposerCompositionEnd}
						onclick={onEditorClick}
						onpaste={onComposerPaste}
					></div>
					<button
						type="button"
						class="composer-action"
						class:send={primaryAction.kind === 'send'}
						class:stop={primaryAction.kind === 'stop'}
						disabled={primaryAction.disabled}
						aria-label={primaryAction.kind === 'stop' ? t.composer.stopGeneration : t.composer.send}
						title={primaryAction.kind === 'stop' ? t.composer.stopGeneration : t.chat.sendHintShortcut}
						onclick={() => primaryAction.kind === 'stop' ? void runtime.stopTurn() : void handleSend()}
					>
						{#if primaryAction.kind === 'stop'}
							<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
						{:else}
							<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"></path></svg>
						{/if}
					</button>
				</div>
			</div>
			{#if !lockedComposer}
				<div class="composer-hint" id="composer-hint">
					<span class="send-shortcut-hint">{selected?.kind !== 'group' && (liveTurn || pendingHere.length > 0) ? t.composer.waitingHint : t.chat.sendHint}</span>
				</div>
			{/if}
		</footer>
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
						{#if profileFailed}
							<div class="panel-alert is-error">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
								<span>{t.sidebar.saveFailed}</span>
							</div>
						{/if}

						<div class="panel-card">
							<div class="panel-card-head">
								<span class="panel-card-title">{t.sidebar.botAvatar}</span>
							</div>
							<div class="panel-card-body">
								<AvatarEditor bind:avatar={profileDraft.avatar} name={profileDraft.name} {t} onchange={onProfilePick} />
							</div>
						</div>

						<div class="panel-card">
							<div class="panel-card-head">
								<span class="panel-card-title">{t.top.profile}</span>
								<span class="profile-save-state" class:is-error={profileFailed} aria-live="polite">
									{#if profileSaving}
										{t.sidebar.autoSaving}
									{:else if profileFailed}
										{t.sidebar.saveFailed}
									{:else if profileSavedTick > 0}
										{t.sidebar.autoSaved}
									{:else}
										{t.sidebar.autoSaveHint}
									{/if}
								</span>
							</div>
							<div class="panel-card-body">
								<div class="form-group">
									<label for="profile-name">{t.sidebar.botName}</label>
									<input
										id="profile-name"
										type="text"
										bind:value={profileDraft.name}
										oninput={onProfileInput}
										placeholder={t.sidebar.botName}
									/>
									{#if profileErrors.name}
										<p class="field-error">{botNameCopy(profileErrors.name)}</p>
									{/if}
								</div>

								<div class="form-group">
									<label for="profile-duties">{t.sidebar.botDuties}</label>
									<textarea
										id="profile-duties"
										bind:value={profileDraft.duties}
										oninput={onProfileInput}
										rows="3"
										placeholder={t.sidebar.botDuties}
									></textarea>
									{#if profileErrors.duties}
										<p class="field-error">{t.sidebar.dutiesEmpty}</p>
									{/if}
								</div>

								<div class="form-group">
									<label for="profile-boundaries">{t.sidebar.botBoundaries}</label>
									<textarea
										id="profile-boundaries"
										bind:value={profileDraft.boundaries}
										oninput={onProfileInput}
										rows="3"
										placeholder={t.sidebar.botBoundaries}
									></textarea>
									{#if profileErrors.boundaries}
										<p class="field-error">{t.sidebar.boundariesEmpty}</p>
									{/if}
								</div>

								<div class="form-group">
									<label for="profile-model">{t.sidebar.botModel}</label>
									<Select
										id="profile-model"
										bind:value={profileDraft.model}
										placeholder={t.sidebar.botModelDefault}
										emptyLabel={t.sidebar.botModelDefault}
										options={availableModelOptions}
										error={!!profileErrors.model}
										onchange={onProfileModelChange}
									/>
									{#if profileErrors.model}
										<p class="field-error">{t.sidebar.botModelInvalid}</p>
									{:else if !profileDraft.model}
										<p class="muted field-hint">{t.sidebar.botModelAutoHint}</p>
									{/if}
								</div>
								{#if profileDraft.model}
								<div class="form-group">
									<span class="field-label" id="profile-thinking-label">{t.sidebar.botThinking}</span>
									<div class="thinking-picker" role="radiogroup" aria-labelledby="profile-thinking-label">
										{#each profileThinkingOptions as level (level)}
											<button
												type="button"
												class="btn-chip level-chip"
												class:active={profileDraft.thinkingLevel === level}
												role="radio"
												aria-checked={profileDraft.thinkingLevel === level}
												onclick={() => pickProfileThinking(level)}
											>{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}</button>
										{/each}
									</div>
									<p class="muted field-hint">{t.sidebar.botThinkingHint}</p>
									{#if profileErrors.thinkingLevel}
										<p class="field-error">{t.sidebar.botThinkingInvalid}</p>
									{/if}
								</div>
								{/if}
							</div>
						</div>

						<div class="panel-card">
							<div class="panel-card-head">
								<span class="panel-card-title">{t.sidebar.skills}</span>
								<span class="panel-counter-badge">{profileSkills.length}</span>
							</div>
							<div class="panel-card-body skill-card-body">
								{#if skillFailed && !skillEditor}
									<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
								{/if}
								{#if profileSkills.length === 0 && !skillEditor}
									<p class="muted skill-empty">{t.sidebar.skillsEmpty}</p>
								{/if}
								{#each profileSkills as skill (skill.id)}
									<div class="skill-row" class:is-disabled={!skill.enabled} class:is-open={skillEditor === skill.id}>
										<button
											type="button"
											class="skill-open"
											aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
											onclick={() => openEditSkill(skill.id)}
										>
											<span class="skill-name" title={skill.name}>{skill.name}</span>
											<span class="skill-desc" title={skill.description}>{skill.description}</span>
										</button>
										<label class="mcp-enable-label">
											<input
												type="checkbox"
												aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
												checked={skill.enabled}
												onchange={(event) => {
													event.currentTarget.checked = skill.enabled;
													void toggleSkillEnabled(skill.id, !skill.enabled);
												}}
											/>
											{t.sidebar.skillEnabled}
										</label>
									</div>
								{/each}
								{#if skillEditor}
									<div class="skill-editor">
										<p class="muted skill-editor-title">
											{skillEditor === 'add' ? t.sidebar.skillAdd : t.sidebar.skillEdit}
										</p>
										{#if skillFailed}
											<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
										{/if}
										<div class="form-group">
											<label for="skill-name">{t.sidebar.skillName}</label>
											<input
												id="skill-name"
												type="text"
												bind:value={skillDraft.name}
												disabled={skillBusy}
											/>
											{#if skillErrors.name}
												<p class="field-error">{skillNameCopy(skillErrors.name)}</p>
											{/if}
										</div>
										<div class="form-group">
											<label for="skill-description">{t.sidebar.skillDescription}</label>
											<textarea
												id="skill-description"
												bind:value={skillDraft.description}
												rows="2"
												disabled={skillBusy}
											></textarea>
											{#if skillErrors.description}
												<p class="field-error">{t.sidebar.skillDescriptionEmpty}</p>
											{/if}
										</div>
										<div class="form-group">
											<label for="skill-body">{t.sidebar.skillBody}</label>
											<textarea
												id="skill-body"
												bind:value={skillDraft.body}
												rows="6"
												disabled={skillBusy}
											></textarea>
											{#if skillErrors.body}
												<p class="field-error">{t.sidebar.skillBodyEmpty}</p>
											{/if}
										</div>
										<div class="form-group">
											<label for="skill-uses">{t.sidebar.skillUses}</label>
											<input
												id="skill-uses"
												type="text"
												bind:value={skillDraft.uses}
												placeholder={t.sidebar.skillUsesPlaceholder}
												disabled={skillBusy}
											/>
											<p class="muted skill-editor-hint">{t.sidebar.skillUsesHint}</p>
										</div>
										<label class="mcp-enable-label skill-editor-enabled">
											<input type="checkbox" bind:checked={skillDraft.enabled} disabled={skillBusy} />
											{t.sidebar.skillEnabled}
										</label>
										<div class="skill-editor-actions">
											<button type="button" class="btn-primary" disabled={skillBusy} onclick={() => void saveSkill()}>
												{t.sidebar.skillSave}
											</button>
											<button type="button" class="btn-secondary" disabled={skillBusy} onclick={closeSkillEditor}>
												{t.sidebar.skillCancel}
											</button>
											{#if skillEditor !== 'add'}
												<button
													type="button"
													class="deny"
													disabled={skillBusy}
													onclick={() => openDeleteSkillConfirm(skillEditor as string)}
												>
													{t.sidebar.skillDelete}
												</button>
											{/if}
										</div>
									</div>
								{:else}
									<button type="button" class="btn-secondary skill-add" onclick={openAddSkill}>
										{t.sidebar.skillAdd}
									</button>
								{/if}
							</div>
						</div>

						<div class="panel-card danger-zone-card">
							<div class="panel-card-head">
								<span class="panel-card-title">{#if selectedKind === 'you-bot'}{t.sidebar.archive} / {t.detail.clearHistory} / {t.sidebar.delete}{:else}{t.sidebar.archive} / {t.sidebar.delete}{/if}</span>
							</div>
							<div class="panel-card-body">
								<div class="bot-management-actions">
									{#if profileBot.archived_at}
										<button type="button" class="btn-secondary" onclick={() => void restoreProfile()}>
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
											<span>{t.sidebar.restore}</span>
										</button>
									{:else}
										<button type="button" class="btn-secondary" onclick={() => void archiveProfile()}>
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
											<span>{t.sidebar.archive}</span>
										</button>
									{/if}

									{#if selectedKind === 'you-bot'}
										<button type="button" class="btn-secondary btn-history-clear" onclick={openClearHistoryConfirm}>
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
											<span>{t.detail.clearHistory}</span>
										</button>
									{/if}

									<button type="button" class="deny" onclick={openDeleteBotConfirm}>
										<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
										<span>{t.sidebar.delete}</span>
									</button>
								</div>
							</div>
						</div>
					{:else}
						{#if selected.kind === 'group'}
							{#if detailFailed}
								<div class="panel-alert is-error">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
									<span>{t.detail.saveFailed}</span>
								</div>
							{/if}

							<!-- Group Profile Section -->
							<div class="panel-card group-hero-card">
								<div class="group-hero-header">
									<div class="group-hero-avatar has-composite" aria-hidden="true">
										<SessionAvatar session={selected} bots={botsById} size="hero" botStatus={botStatusOf} />
									</div>
									<div class="group-hero-info">
										<div class="group-hero-title-row">
											<h3 class="group-hero-name">{detailName || titleOf(selected)}</h3>
											{#if selected.archived_at}
												<span class="badge-archived">{t.top.archived}</span>
											{/if}
										</div>
										<span class="group-hero-count">{groupPresent.length + 1} {t.detail.members}</span>
									</div>
								</div>

								<div class="form-group group-name-edit">
									<label for="detail-group-name">{t.sidebar.groupName}</label>
									<div class="name-row">
										<input
											id="detail-group-name"
											type="text"
											bind:value={detailName}
											placeholder={t.sidebar.groupName}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													void saveGroupName();
												}
											}}
										/>
										<button
											type="button"
											class="btn-save-name"
											class:is-active={detailName.trim() !== (selected.name ?? '').trim()}
											disabled={detailName.trim() === (selected.name ?? '').trim()}
											onclick={() => void saveGroupName()}
										>
											{t.detail.saveName}
										</button>
									</div>
									{#if detailNameError}
										<p class="field-error">{t.sidebar.groupNameEmpty}</p>
									{/if}
								</div>
							</div>

							<!-- Group Members Section -->
							<div class="panel-card group-members-card">
								<div class="panel-card-head">
									<span class="panel-card-title">{t.detail.members}</span>
									<span class="panel-counter-badge">{groupPresent.length + 1}</span>
								</div>
								<div class="panel-card-body">
									<div class="members">
										<div class="member you">
											<div class="member-left">
												<div class="member-avatar-mini is-you" aria-hidden="true">
													<span>{rosterLetter(t.common.you)}</span>
												</div>
												<div class="member-info">
													<div class="member-name-row">
														<span class="member-name-text">{t.common.you}</span>
														<span class="member-badge is-owner">{locale === 'zh' ? '创建者' : 'Owner'}</span>
													</div>
												</div>
											</div>
										</div>

										{#each groupPresent as botId (botId)}
											{@const bot = botsById.get(botId)}
											<div class="member">
												<div class="member-left">
													{#if bot}
														{@const pal = botAvatarColor(bot.id)}
														<span
															class="member-avatar-mini"
															style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
														>
															{#if avatarSrc(bot.avatar)}
																<img src={avatarSrc(bot.avatar)!} alt="" class="avatar-img" />
															{:else}
																{rosterLetter(bot.name)}
															{/if}
														</span>
														<div class="member-info">
															<div class="member-name-row">
																<button
																	type="button"
																	class="member-name-btn"
																	onclick={() => openProfile(bot.id)}
																	title={locale === 'zh' ? '查看并编辑 Bot 人设' : 'View & edit bot profile'}
																>
																	{memberLabel(botId)}
																</button>
																{#if bot.model}
																	<span class="member-badge is-model mono" title={bot.model}>{bot.model}</span>
																{/if}
															</div>
															{#if bot.duties}
																<span class="member-duties-text" title={bot.duties}>{bot.duties}</span>
															{/if}
														</div>
													{:else}
														<span class="member-avatar-mini is-deleted">?</span>
														<div class="member-info">
															<span class="member-deleted-label">{t.top.deleted}</span>
														</div>
													{/if}
												</div>

												{#if bot}
													<button
														type="button"
														class="btn-remove-member"
														disabled={!groupCanRemove}
														title={!groupCanRemove ? (locale === 'zh' ? '群内至少需保留 2 个 Bot' : 'Keep at least 2 bots') : t.detail.remove}
														onclick={() => void removeMember(botId)}
													>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
														<span>{t.detail.remove}</span>
													</button>
												{/if}
											</div>
										{/each}
									</div>

									{#if groupCandidates.length > 0}
										<div class="pull-in-section">
											<div class="name-row">
												<Select
													bind:value={pullPick}
													placeholder={t.detail.pullIn}
													emptyLabel={t.detail.pullIn}
													options={groupCandidates.map((bot) => ({ value: bot.id, label: bot.name }))}
													size="sm"
												/>
												<button
													type="button"
													class="btn-pull-in"
													disabled={!pullPick}
													onclick={() => void pullInMember()}
												>
													<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
													<span>{t.detail.pullIn}</span>
												</button>
											</div>
										</div>
									{/if}
								</div>
							</div>
						{:else if selectedKind === 'bot-bot'}
							<div class="panel-card group-members-card">
								<div class="panel-card-head">
									<span class="panel-card-title">{t.detail.members}</span>
									<span class="panel-counter-badge">{groupPresent.length}</span>
								</div>
								<div class="panel-card-body">
									<div class="members">
										{#each groupPresent as botId (botId)}
											{@const bot = botsById.get(botId)}
											<div class="member">
												<div class="member-left">
													{#if bot}
														{@const pal = botAvatarColor(bot.id)}
														<span
															class="member-avatar-mini"
															style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
														>
															{#if avatarSrc(bot.avatar)}
																<img src={avatarSrc(bot.avatar)!} alt="" class="avatar-img" />
															{:else}
																{rosterLetter(bot.name)}
															{/if}
														</span>
														<div class="member-info">
															<div class="member-name-row">
																<button
																	type="button"
																	class="member-name-btn"
																	onclick={() => openProfile(bot.id)}
																	title={locale === 'zh' ? '查看并编辑 Bot 人设' : 'View & edit bot profile'}
																>
																	{memberLabel(botId)}
																</button>
																{#if bot.model}
																	<span class="member-badge is-model mono" title={bot.model}>{bot.model}</span>
																{/if}
															</div>
															{#if bot.duties}
																<span class="member-duties-text" title={bot.duties}>{bot.duties}</span>
															{/if}
														</div>
													{:else}
														<span class="member-avatar-mini is-deleted">?</span>
														<div class="member-info">
															<span class="member-deleted-label">{t.top.deleted}</span>
														</div>
													{/if}
												</div>
											</div>
										{/each}
									</div>
								</div>
							</div>
						{/if}

						<!-- Session Actions (Archive / Restore) -->
						{#if selected.kind === 'group'}
							<div class="panel-card">
								<div class="panel-card-head">
									<span class="panel-card-title">{locale === 'zh' ? '会话操作' : 'Actions'}</span>
								</div>
								<div class="panel-card-body">
									<div class="action-list-row">
										<div class="action-list-info">
											<span class="action-list-title">{selected.archived_at ? t.sidebar.restore : t.sidebar.archive}</span>
											<span class="action-list-desc">{selected.archived_at ? (locale === 'zh' ? '恢复此群组到活跃会话列表' : 'Restore group to active sidebar') : (locale === 'zh' ? '从侧栏移入已归档列表，保留历史消息' : 'Move to archived sessions without deleting history')}</span>
										</div>
										{#if selected.archived_at}
											<button type="button" class="btn-secondary action-btn" onclick={() => void runtime.restoreSession(selected.id)}>
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
												<span>{t.sidebar.restore}</span>
											</button>
										{:else}
											<button type="button" class="btn-secondary action-btn" onclick={() => void runtime.archiveSession(selected.id)}>
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
												<span>{t.sidebar.archive}</span>
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/if}

						<!-- Danger Zone (Clear History / Delete Group) -->
						<div class="panel-card danger-zone-card">
							<div class="panel-card-head">
								<span class="panel-card-title">{locale === 'zh' ? '危险区域' : 'Danger Zone'}</span>
							</div>
							<div class="panel-card-body">
								<div class="action-list-stack">
									<div class="action-list-row">
										<div class="action-list-info">
											<span class="action-list-title">{t.detail.clearHistory}</span>
											<span class="action-list-desc">{locale === 'zh' ? '清空所有聊天消息、轮次和上下文，不可撤销' : 'Clear all messages and turns in this group'}</span>
										</div>
										<button
											type="button"
											class="btn-secondary btn-history-clear action-btn"
											onclick={openClearHistoryConfirm}
										>
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
											<span>{t.detail.clearHistory}</span>
										</button>
									</div>

									{#if selected.kind === 'group'}
										<div class="action-list-row is-danger">
											<div class="action-list-info">
												<span class="action-list-title text-danger">{t.detail.deleteGroup}</span>
												<span class="action-list-desc">{locale === 'zh' ? '永久解散此群组并删除记录，名册上的 Bot 保留' : 'Permanently delete this group; member bots remain'}</span>
											</div>
											<button type="button" class="deny action-btn" onclick={openDeleteGroupConfirm}>
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
												<span>{t.detail.deleteGroup}</span>
											</button>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
	{#if dangerConfirmCopy}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="modal-backdrop confirm-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="danger-confirm-title"
			aria-describedby="danger-confirm-body"
			tabindex="-1"
			onclick={(e) => {
				e.stopPropagation();
				if (e.target === e.currentTarget) dismissDangerConfirm();
			}}
			onpointerdown={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					dismissDangerConfirm();
				}
			}}
		>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="modal-dialog confirm-dialog"
				onclick={(e) => e.stopPropagation()}
				onpointerdown={(e) => e.stopPropagation()}
			>
				<div class="modal-head">
					<h2 id="danger-confirm-title">{dangerConfirmCopy.title}</h2>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={dismissDangerConfirm}
					>✕</button>
				</div>
				<div class="modal-body">
					<p id="danger-confirm-body" class="confirm-copy">{dangerConfirmCopy.body}</p>
				</div>
				<div class="modal-foot actions">
					<button type="button" onclick={dismissDangerConfirm}>
						{dangerConfirmCopy.cancel}
					</button>
					<button type="button" class="deny" onclick={() => void confirmDangerAction()}>
						{dangerConfirmCopy.confirm}
					</button>
				</div>
			</div>
		</div>
	{/if}
	{#if runtime.settingsOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="modal-backdrop"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => {
				if (e.target === e.currentTarget && !providerEditor && dangerConfirm?.kind !== 'provider')
					closeSettings();
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape' && !providerEditor && dangerConfirm?.kind !== 'provider')
					closeSettings();
			}}
		>
			<div class="modal-dialog settings-modal">
				<aside class="settings-sidebar">
					<div class="settings-sidebar-head">
						<div class="settings-head-left">
							<svg class="settings-head-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="3"></circle>
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
							</svg>
							<h2>{t.settings.title}</h2>
						</div>
						{#if !snapshot.settings.wizard_complete}
							<span class="settings-wizard-badge">{t.settings.wizardIncomplete}</span>
						{/if}
					</div>

					<div class="settings-tabs" role="tablist" aria-label={t.settings.title}>
						<button
							type="button"
							role="tab"
							aria-selected={activeSettingsTab === 'general'}
							class="settings-tab-btn"
							class:is-active={activeSettingsTab === 'general'}
							onclick={() => (activeSettingsTab = 'general')}
						>
							<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="3"></circle>
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
							</svg>
							<span class="tab-name">{t.settings.tabGeneral}</span>
							{#if generalHasError}
								<span class="tab-badge-error" aria-label="error">!</span>
							{/if}
						</button>

						<button
							type="button"
							role="tab"
							aria-selected={activeSettingsTab === 'preferences'}
							class="settings-tab-btn"
							class:is-active={activeSettingsTab === 'preferences'}
							onclick={() => (activeSettingsTab = 'preferences')}
						>
							<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<line x1="4" y1="21" x2="4" y2="14"></line>
								<line x1="4" y1="10" x2="4" y2="3"></line>
								<line x1="12" y1="21" x2="12" y2="12"></line>
								<line x1="12" y1="8" x2="12" y2="3"></line>
								<line x1="20" y1="21" x2="20" y2="16"></line>
								<line x1="20" y1="12" x2="20" y2="3"></line>
								<line x1="1" y1="14" x2="7" y2="14"></line>
								<line x1="9" y1="8" x2="15" y2="8"></line>
								<line x1="17" y1="16" x2="23" y2="16"></line>
							</svg>
							<span class="tab-name">{t.settings.tabPreferences}</span>
						</button>

						<button
							type="button"
							role="tab"
							aria-selected={activeSettingsTab === 'models'}
							class="settings-tab-btn"
							class:is-active={activeSettingsTab === 'models'}
							onclick={() => (activeSettingsTab = 'models')}
						>
							<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
								<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
								<line x1="12" y1="22.08" x2="12" y2="12"></line>
							</svg>
							<span class="tab-name">{t.settings.tabModels}</span>
							{#if modelsHasError}
								<span class="tab-badge-error" aria-label="error">!</span>
							{:else if snapshot.providers.length > 0}
								<span class="tab-count">{snapshot.providers.length}</span>
							{/if}
						</button>

						<button
							type="button"
							role="tab"
							aria-selected={activeSettingsTab === 'mcp'}
							class="settings-tab-btn"
							class:is-active={activeSettingsTab === 'mcp'}
							onclick={() => (activeSettingsTab = 'mcp')}
						>
							<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
								<rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
								<line x1="6" y1="6" x2="6.01" y2="6"></line>
								<line x1="6" y1="18" x2="6.01" y2="18"></line>
							</svg>
							<span class="tab-name">{t.settings.tabMcp}</span>
							{#if snapshot.mcpServers.length > 0}
								<span class="tab-count">{snapshot.mcpServers.length}</span>
							{/if}
						</button>

						<button
							type="button"
							role="tab"
							aria-selected={activeSettingsTab === 'about'}
							class="settings-tab-btn"
							class:is-active={activeSettingsTab === 'about'}
							onclick={() => (activeSettingsTab = 'about')}
							title={updateChecker.updateVisible ? `${t.settings.tabAbout} · ${t.sidebar.updateAvailable}` : t.settings.tabAbout}
						>
							<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="10"></circle>
								<line x1="12" y1="16" x2="12" y2="12"></line>
								<line x1="12" y1="8" x2="12.01" y2="8"></line>
							</svg>
							<span class="tab-name">{t.settings.tabAbout}</span>
							{#if updateChecker.updateVisible}
								<span class="tab-badge-dot" aria-label={t.sidebar.updateAvailable}></span>
							{/if}
						</button>
					</div>
				</aside>

				<section class="settings-main">
					<div class="settings-main-head">
						<div class="settings-main-head-left">
							<h3 class="settings-main-title">
								{activeSettingsTab === 'general'
									? t.settings.tabGeneral
									: activeSettingsTab === 'preferences'
										? t.settings.tabPreferences
										: activeSettingsTab === 'models'
											? t.settings.tabModels
											: activeSettingsTab === 'mcp'
												? t.settings.tabMcp
												: t.settings.tabAbout}
							</h3>
						</div>
						<button
							type="button"
							class="modal-close"
							title={t.common.close}
							onclick={closeSettings}
						>✕</button>
					</div>

				<div class="modal-body" class:is-mcp={activeSettingsTab === 'mcp'}>
					{#if saveFailed}
						<p class="field-error">{t.settings.saveFailed}</p>
					{/if}
					{#if !snapshot.settings.wizard_complete}
						<div class="wizard-banner">
							<p class="muted">{t.settings.wizardHint}</p>
							<p class="muted">{t.settings.wizardIncomplete}</p>
						</div>
					{/if}

					{#if activeSettingsTab === 'general'}
						<div class="settings-tab-pane">
							<!-- Workspace Directory Section -->
							<div class="settings-card settings-card-workspace">
								<div class="settings-card-header">
									<div class="settings-card-header-main">
										<div class="settings-header-icon-wrap" aria-hidden="true">
											<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
											</svg>
										</div>
										<div>
											<h3 class="settings-card-title">{t.settings.sectionWorkspace}</h3>
											<p class="settings-card-subtitle">{t.settings.workspaceSubtitle}</p>
										</div>
									</div>
									{#if runtime.workspacePath}
										<span class="settings-badge-ok">{t.settings.workspaceConfigured}</span>
									{:else}
										<span class="settings-badge-warn">{t.settings.workspaceUnsetNotice}</span>
									{/if}
								</div>

								<div class="settings-workspace-box">
									<WorkspacePicker
										id="workspace"
										path={runtime.workspacePath}
										chooseLabel={t.settings.workspaceChoose}
										changeLabel={t.settings.workspaceChange}
										emptyLabel={t.settings.workspaceUnsetValue}
										unavailableLabel={t.settings.workspacePickerUnavailable}
										dialogTitle={t.settings.workspaceChoose}
										onChange={(next) => {
											runtime.workspacePath = next;
											clearWorkspaceError();
										}}
									/>

									{#if fieldErrors.workspace}
										<div class="field-error-alert" role="alert">
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
												<circle cx="12" cy="12" r="10"></circle>
												<line x1="12" y1="8" x2="12" y2="12"></line>
												<line x1="12" y1="16" x2="12.01" y2="16"></line>
											</svg>
											<span>
												{fieldCopy(
													fieldErrors.workspace,
													t.settings.workspaceEmpty,
													t.settings.workspaceInvalid
												)}
											</span>
										</div>
									{/if}

									<div class="workspace-jail-callout">
										<svg class="jail-callout-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
										</svg>
										<div class="jail-callout-content">
											<span class="jail-callout-title">{t.settings.workspaceSecurityBoundary}</span>
											<p class="jail-callout-text">{JAIL_COPY[locale]}</p>
										</div>
									</div>
								</div>
							</div>
						</div>
					{:else if activeSettingsTab === 'preferences'}
						<div class="settings-tab-pane">
							<!-- Preferences Section -->
							<div class="settings-card settings-card-preferences">
								<div class="settings-card-header">
									<div class="settings-card-header-main">
										<div class="settings-header-icon-wrap" aria-hidden="true">
											<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<line x1="4" y1="21" x2="4" y2="14"></line>
												<line x1="4" y1="10" x2="4" y2="3"></line>
												<line x1="12" y1="21" x2="12" y2="12"></line>
												<line x1="12" y1="8" x2="12" y2="3"></line>
												<line x1="20" y1="21" x2="20" y2="16"></line>
												<line x1="20" y1="12" x2="20" y2="3"></line>
												<line x1="1" y1="14" x2="7" y2="14"></line>
												<line x1="9" y1="8" x2="15" y2="8"></line>
												<line x1="17" y1="16" x2="23" y2="16"></line>
											</svg>
										</div>
										<div>
											<h3 class="settings-card-title">{t.settings.sectionPreferences}</h3>
											<p class="settings-card-subtitle">{t.settings.preferencesSubtitle}</p>
										</div>
									</div>
								</div>

								<div class="settings-rows">
									<!-- Theme Row -->
									<div class="settings-row">
										<div class="settings-row-info">
											<span class="settings-row-title" id="theme-setting-label">{t.settings.theme}</span>
											<span class="settings-row-desc">{t.settings.themeDesc}</span>
										</div>
										<div class="settings-row-action">
											<div class="segmented-control" role="group" aria-labelledby="theme-setting-label">
												<button
													type="button"
													class="segmented-btn"
													class:is-active={snapshot.settings.theme === 'system'}
													onclick={() => {
														themeManager.setTheme('system');
														void patchImmediate({ theme: 'system' });
													}}
												>
													<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
														<rect x="2" y="3" width="20" height="14" rx="2"></rect>
														<line x1="8" y1="21" x2="16" y2="21"></line>
														<line x1="12" y1="17" x2="12" y2="21"></line>
													</svg>
													<span>{t.settings.themeSystem}</span>
												</button>
												<button
													type="button"
													class="segmented-btn"
													class:is-active={snapshot.settings.theme === 'light'}
													onclick={() => {
														themeManager.setTheme('light');
														void patchImmediate({ theme: 'light' });
													}}
												>
													<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
													<span>{t.settings.themeLight}</span>
												</button>
												<button
													type="button"
													class="segmented-btn"
													class:is-active={snapshot.settings.theme === 'dark'}
													onclick={() => {
														themeManager.setTheme('dark');
														void patchImmediate({ theme: 'dark' });
													}}
												>
													<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
														<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
													</svg>
													<span>{t.settings.themeDark}</span>
												</button>
											</div>
										</div>
									</div>

									<!-- Language Row -->
									<div class="settings-row">
										<div class="settings-row-info">
											<span class="settings-row-title" id="lang-setting-label">{t.settings.language}</span>
											<span class="settings-row-desc">{t.settings.languageDesc}</span>
										</div>
										<div class="settings-row-action">
											<div class="segmented-control" role="group" aria-labelledby="lang-setting-label">
												<button
													type="button"
													class="segmented-btn"
													class:is-active={locale === 'zh'}
													onclick={() => void patchImmediate({ locale: 'zh' })}
												>
													<span>{t.settings.localeZh}</span>
												</button>
												<button
													type="button"
													class="segmented-btn"
													class:is-active={locale === 'en'}
													onclick={() => void patchImmediate({ locale: 'en' })}
												>
													<span>{t.settings.localeEn}</span>
												</button>
											</div>
										</div>
									</div>

									<!-- Launch at login Row -->
									<div class="settings-row">
										<div class="settings-row-info">
											<span class="settings-row-title" id="launch-setting-label">{t.settings.launch}</span>
											<span class="settings-row-desc">{t.settings.launchDesc}</span>
										</div>
										<div class="settings-row-action">
											<label class="switch-toggle" for="launch-at-login-toggle" aria-labelledby="launch-setting-label">
												<input
													id="launch-at-login-toggle"
													type="checkbox"
													checked={snapshot.settings.launch_at_login}
													onchange={(ev) =>
														void patchImmediate({
															launch_at_login: (ev.currentTarget as HTMLInputElement).checked
														})}
												/>
												<span class="switch-track" aria-hidden="true">
													<span class="switch-thumb"></span>
												</span>
											</label>
										</div>
									</div>
								</div>
							</div>
						</div>
					{:else if activeSettingsTab === 'models'}
						<div class="settings-tab-pane">
							<div class="provider-list-head">
								<p class="muted">{t.settings.providersHint}</p>
								<button type="button" class="btn-provider-add" onclick={openAddProvider}>
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
									<span>{t.settings.providerAdd}</span>
								</button>
							</div>
							{#if snapshot.providers.length === 0}
								<div class="mcp-empty">
									<p class="muted">{t.settings.providerEmpty}</p>
								</div>
							{/if}
							<div class="provider-card-list">
								{#each snapshot.providers as provider (provider.id)}
									{@const isDefault = snapshot.settings.default_provider_id === provider.id}
									{@const palette = botAvatarColor(provider.id)}
									{@const host = providerHost(provider.base_url)}
									<div class="provider-card" class:is-default={isDefault}>
										<div class="provider-card-head">
											<button
												type="button"
												class="provider-card-identity"
												onclick={() => openEditProvider(provider.id)}
												title={`${t.settings.providerEdit}: ${provider.name}`}
											>
												<span
													class="provider-card-mark"
													style:background={palette.bg}
													style:color={palette.text}
													style:border-color={palette.border}
												>{rosterLetter(provider.name)}</span>
												<span class="provider-identity-text">
													<span class="provider-name-row">
														<span class="provider-card-name">{provider.name}</span>
														{#if isDefault}
															<span class="provider-badge-default" title={t.settings.providerDefault}>
																<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
																<span>{t.settings.providerDefault}</span>
															</span>
														{/if}
														<span class="provider-badge-key" class:is-set={provider.key_set} title={provider.key_set ? t.settings.keySet : t.settings.keyUnset}>
															<span class="provider-status-dot" class:is-set={provider.key_set}></span>
															<span>{provider.key_set ? t.settings.keySet : t.settings.keyUnset}</span>
														</span>
													</span>
													{#if host}
														<span class="provider-card-host mono" title={provider.base_url ?? ''}>
															<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
															<span>{host}</span>
														</span>
													{/if}
												</span>
											</button>

											<div class="provider-card-acts">
												{#if !isDefault}
													<button
														type="button"
														class="btn-provider-action btn-provider-setdefault"
														onclick={() => void setDefaultProvider(provider.id)}
														title={t.settings.providerSetDefault}
													>
														<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
														<span>{t.settings.providerSetDefault}</span>
													</button>
												{/if}
												<button
													type="button"
													class="btn-provider-action btn-provider-edit"
													aria-label={`${t.settings.providerEdit}: ${provider.name}`}
													onclick={() => openEditProvider(provider.id)}
													title={t.settings.providerEdit}
												>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
													<span>{t.settings.providerEdit}</span>
												</button>
												<button
													type="button"
													class="btn-provider-action btn-provider-delete"
													aria-label={`${t.settings.providerDelete}: ${provider.name}`}
													onclick={() => openDeleteProviderConfirm(provider.id)}
													title={t.settings.providerDelete}
												>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
												</button>
											</div>
										</div>

										{#if provider.default_model || provider.models.length > 0}
											<button
												type="button"
												class="provider-card-body-btn"
												onclick={() => openEditProvider(provider.id)}
												title={`${t.settings.providerEdit}: ${provider.name}`}
											>
												<div class="provider-meta-row">
													{#if provider.default_model}
														<div class="provider-default-model-tag" title={`${t.settings.defaultModel}: ${provider.default_model}`}>
															<span class="tag-icon">
																<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
															</span>
															<span class="tag-label">{t.settings.defaultModel}:</span>
															<span class="tag-val mono">{provider.default_model}</span>
														</div>
													{/if}
													<span class="provider-model-count-label">
														{t.settings.providerModelCount(provider.models.length)}
													</span>
												</div>

												{#if provider.models.length > 0}
													<div class="provider-model-chips">
														{#each provider.models.slice(0, 4) as model}
															<span class="provider-model-chip mono" class:is-default={model === provider.default_model}>
																{model}
															</span>
														{/each}
														{#if provider.models.length > 4}
															<span class="provider-model-chip is-overflow">
																+{provider.models.length - 4}
															</span>
														{/if}
													</div>
												{/if}
											</button>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{:else if activeSettingsTab === 'mcp'}
						<McpSettings {runtime} {t} />
					{:else if activeSettingsTab === 'about'}
						<div class="settings-tab-pane">
							<div class="settings-card settings-card-about">
								<div class="settings-card-header">
									<div class="settings-card-header-main">
										<div class="settings-header-icon-wrap" aria-hidden="true">
											<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="12" cy="12" r="10"></circle>
												<line x1="12" y1="16" x2="12" y2="12"></line>
												<line x1="12" y1="8" x2="12.01" y2="8"></line>
											</svg>
										</div>
										<div>
											<h3 class="settings-card-title">{t.settings.sectionAbout}</h3>
											<p class="settings-card-subtitle">{t.settings.aboutSubtitle}</p>
										</div>
									</div>
								</div>

								<div class="settings-rows">
									<div class="settings-row">
										<div class="settings-row-info">
											<span class="settings-row-title">Real Bot</span>
											<span class="settings-row-desc">
												<span class="about-version-chip">{t.settings.version(updateChecker.version ?? '0.1.0-rc.1')}</span>
											</span>
										</div>
										{#if updateChecker.available}
											<div class="settings-row-action">
												<button
													type="button"
													class="btn-check-update"
													disabled={updateChecker.status === 'checking'}
													onclick={() => void updateChecker.checkNow()}
												>
													{#if updateChecker.status === 'checking'}
														<svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
															<circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
															<path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor"></path>
														</svg>
													{/if}
													<span>{updateChecker.status === 'checking' ? t.settings.checkingUpdates : t.settings.checkUpdates}</span>
												</button>
											</div>
										{/if}
									</div>
								</div>

								{#if updateChecker.available}
									{#if updateChecker.status === 'error'}
										<div class="about-status-banner is-error">
											<p class="about-status-text">{t.settings.updateFailed}</p>
										</div>
									{:else if updateChecker.result?.updateAvailable && updateChecker.result.latest}
										<div class="about-update-banner">
											<p class="about-update-title">{t.settings.updateAvailable(updateChecker.result.latest)}</p>
											<div class="about-actions">
												{#if updateChecker.result.downloadUrl}
													<button type="button" class="btn-xs btn-primary" onclick={() => void updateChecker.download()}>
														{t.settings.updateDownload}
													</button>
												{/if}
												{#if updateChecker.result.releaseUrl}
													<button type="button" class="btn-xs" onclick={() => void updateChecker.openNotes()}>
														{t.settings.updateNotes}
													</button>
												{/if}
												{#if updateChecker.ignoredVersion !== updateChecker.result.latest}
													<button type="button" class="btn-text-action" onclick={() => updateChecker.ignoreLatest()}>
														{t.settings.updateIgnore}
													</button>
												{/if}
											</div>
										</div>
									{:else if updateChecker.status === 'ok'}
										<div class="about-status-banner is-ok">
											<p class="about-status-text">{t.settings.upToDate}</p>
										</div>
									{/if}
								{/if}
							</div>
						</div>
					{/if}
				</div>
					<div class="modal-foot actions">
						<button type="button" onclick={() => void saveSettings()}>{t.settings.save}</button>
						<button type="button" onclick={closeSettings}>{t.common.close}</button>
					</div>
				</section>
			</div>
		</div>
	{/if}
	{#if runtime.settingsOpen && providerEditor}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="modal-backdrop provider-editor-backdrop"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => {
				if (e.target === e.currentTarget) closeProviderEditor();
			}}
		>
			<div class="modal-dialog provider-editor-modal">
				<div class="modal-head">
					<h2>
						{providerEditor.target === 'add' ? t.settings.providerAdd : t.settings.providerEdit}
					</h2>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={closeProviderEditor}
					>✕</button>
				</div>
				<div class="modal-body">
					<ProviderForm
						draft={providerEditor.draft}
						errors={providerEditor.errors}
						failed={providerEditor.failed}
						fetching={providerEditor.fetching}
						fetchError={providerEditor.fetchError}
						fieldPrefix={providerEditor.target === 'add'
							? 'provider-add'
							: `provider-${providerEditor.target}`}
						keySet={editorKeySet(providerEditor.target)}
						{t}
						onchange={setProviderDraft}
						onfetch={() => void fetchProviderModels()}
					/>
				</div>
				<div class="modal-foot actions">
					{#if providerEditor.target === 'add'}
						<button type="button" onclick={() => void addProvider()}>{t.settings.providerAdd}</button>
					{:else}
						<button type="button" onclick={() => void saveProvider()}>{t.settings.providerSave}</button>
					{/if}
					<button type="button" onclick={closeProviderEditor}>{t.common.close}</button>
				</div>
			</div>
		</div>
	{/if}
	{#if runtime.createBotOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="modal-backdrop"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => {
				if (e.target === e.currentTarget) runtime.createBotOpen = false;
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape') runtime.createBotOpen = false;
			}}
		>
			<div class="modal-dialog create-bot-modal">
				<div class="modal-head">
					<h2>{t.sidebar.addBot}</h2>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={() => (runtime.createBotOpen = false)}>✕</button
					>
				</div>
				<div class="modal-body">
					{#if botFailed}
						<p class="field-error">{t.sidebar.saveFailed}</p>
					{/if}
					<div class="modal-section">
						<span class="field-head">{t.sidebar.botAvatar}</span>
						<AvatarEditor bind:avatar={botDraft.avatar} name={botDraft.name} {t} onchange={onBotInput} />
					</div>
					<div class="modal-section">
						<label for="bot-name">{t.sidebar.botName}</label>
						<input id="bot-name" type="text" bind:value={botDraft.name} oninput={onBotInput} />
						{#if botErrors.name}
							<p class="field-error">{botNameCopy(botErrors.name)}</p>
						{/if}
					</div>
					<div class="modal-section">
						<label for="bot-duties">{t.sidebar.botDuties}</label>
						<textarea id="bot-duties" bind:value={botDraft.duties} oninput={onBotInput}></textarea>
						{#if botErrors.duties}
							<p class="field-error">{t.sidebar.dutiesEmpty}</p>
						{/if}
					</div>
					<div class="modal-section">
						<label for="bot-boundaries">{t.sidebar.botBoundaries}</label>
						<textarea
							id="bot-boundaries"
							bind:value={botDraft.boundaries}
							oninput={onBotInput}
						></textarea>
						{#if botErrors.boundaries}
							<p class="field-error">{t.sidebar.boundariesEmpty}</p>
						{/if}
					</div>
					<div class="modal-section">
						<label for="bot-model">{t.sidebar.botModel}</label>
						<Select
							id="bot-model"
							bind:value={botDraft.model}
							placeholder={t.sidebar.botModelDefault}
							emptyLabel={t.sidebar.botModelDefault}
							options={availableModelOptions}
							error={!!botErrors.model}
							onchange={onBotModelChange}
						/>
						{#if botErrors.model}
							<p class="field-error">{t.sidebar.botModelInvalid}</p>
						{:else if !botDraft.model}
							<p class="muted field-hint">{t.sidebar.botModelAutoHint}</p>
						{/if}
					</div>
					{#if botDraft.model}
					<div class="modal-section">
						<span class="field-label" id="bot-thinking-label">{t.sidebar.botThinking}</span>
						<div class="thinking-picker" role="radiogroup" aria-labelledby="bot-thinking-label">
							{#each botThinkingOptions as level (level)}
								<button
									type="button"
									class="btn-chip level-chip"
									class:active={botDraft.thinkingLevel === level}
									role="radio"
									aria-checked={botDraft.thinkingLevel === level}
									onclick={() => pickBotThinking(level)}
								>{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}</button>
							{/each}
						</div>
						<p class="muted field-hint">{t.sidebar.botThinkingHint}</p>
						{#if botErrors.thinkingLevel}
							<p class="field-error">{t.sidebar.botThinkingInvalid}</p>
						{/if}
					</div>
					{/if}
				</div>
				<div class="modal-foot actions">
					<button type="button" onclick={() => void saveBot()}>{t.sidebar.create}</button>
					<button type="button" onclick={() => (runtime.createBotOpen = false)}>{t.common.close}</button>
				</div>
			</div>
		</div>
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
