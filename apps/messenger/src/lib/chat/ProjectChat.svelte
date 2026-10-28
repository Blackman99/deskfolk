<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { isHiddenTranscriptKind, PLAN_APPROVAL_KIND, PROJECT_AGENT_CAPS, type ClaudeCodeCommand, type PatchProjectSessionRequest, speechReady, USER_MEMBER, type Attachment, type Message, type SessionSummary } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { desktopReadingMode, transcriptReadingReady, TRANSCRIPT_VISIBLE_MS } from '../notifications/reading.ts';
	import { isLiveRun, projectAgentOf } from '../sidebar/project-groups.ts';
	import {
		composerImeKeyAction,
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate,
		COMPOSER_IME_IDLE,
		type ComposerImeState
	} from './composer-ime.ts';
	import { formatDateDivider, formatLiveDuration, formatMessageTime, isDifferentDay } from './chat-view.ts';
	import CommandActivity from './CommandActivity.svelte';
	import SendButton from './SendButton.svelte';
	import { focusMode } from './focus-mode.svelte.ts';
	import { describeStep } from './turn-activity.ts';
	import { ComposerVoice, spacedHeard } from './composer-voice.svelte.ts';
	import { loadClaudeModels } from '../claude-models.svelte.ts';
	import { accountChoices, claudeStatus, codexModels, loadClaudeStatus, loadCodexStatus } from './project-agent-options.svelte.ts';
	import ProjectAgentTune from './ProjectAgentTune.svelte';
	import ProjectCommandMenu from './ProjectCommandMenu.svelte';
	import ProjectPlanCard from './ProjectPlanCard.svelte';
	import { loadProjectCommands, matchCommands, projectCommandsOf, slashQuery, withCommand } from './project-commands.svelte.ts';
	import VoiceButton from './VoiceButton.svelte';
	import VoiceStatus from './VoiceStatus.svelte';
	import { ProjectCitedPaths } from './project-cited-path.ts';
	import { showToast } from '../toast.svelte.ts';
	import { ComposerAttachments, pastedFiles, uploadedShare } from './composer-attachments.svelte.ts';
	import ComposerAttachmentsBar from './ComposerAttachments.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import MessageImageLightbox, { type ImageOrigin } from './MessageImageLightbox.svelte';
	import { pictureOrigin, pictureStandIn } from './enlarged-images.ts';

	/**
	 * A project session's conversation (ADR 0095): you and the agent in a directory, as in the
	 * agent's own desktop app. It has no Bot, so none of the Bot stage applies: your lines on the
	 * right, the agent's on the left as markdown, the app's centred. The run going on is a Bot's
	 * working bubble at the end — what it has said, its commands folded, its step and times on the
	 * last line — with the approval it waits on under it; Stop is in the composer, as in a Bot's
	 * direct. Pictures and files go with a line as in a Bot's composer: pasted, or picked with the
	 * clip. Plan mode is a switch in the composer (Shift+Tab, as in the terminal), and the plan it
	 * brings is a card of its own; typing `/` lists the agent's commands (ADR 0098). A Codex
	 * session (ADR 0099) has no plan mode and no account to pick; its `/` lists the commands the app
	 * carries out for Codex and its skills. The header is the pane's or the page's own.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary;
		/** Opens a file the agent cites, as a Bot conversation's do; given the absolute path the Mac found. */
		onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string) => void;
	};

	let { runtime, t, selected, onOpenArtifact }: Props = $props();

	const citedPaths = new ProjectCitedPaths(() => runtime.client);

	/**
	 * The agent's paths are relative to where it was working, not to the workspace, so the Mac says
	 * where one is before it opens (project-cited-path.ts); one it cannot place is said, not opened.
	 */
	function openCited(path: string, messageId?: string): void {
		const pending = citedPaths.resolve(selected.id, path);
		if (!pending) {
			onOpenArtifact(path, undefined, messageId);
			return;
		}
		void pending.then((answer) => {
			if (answer.path !== null) onOpenArtifact(answer.path, undefined, messageId);
			else showToast(answer.matches > 1 ? t.project.citedAmbiguous(path, answer.matches) : t.project.citedMissing(path));
		});
	}

	const snapshot = $derived(runtime.snapshot);
	const view = $derived(runtime.sessionView(selected.id));
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const connected = $derived(runtime.connection === 'connected');
	const run = $derived(snapshot.agentRuns[selected.id] ?? null);
	const live = $derived(isLiveRun(run));
	const waiting = $derived(run?.status === 'waiting_approval' && run.approval ? run.approval : null);
	const planWaiting = $derived(waiting?.kind_key === PLAN_APPROVAL_KIND);

	/** Oldest first; what the app keeps out of a transcript stays out. */
	const lines = $derived(
		snapshot.messages
			.filter((m) => m.session_id === selected.id && !isHiddenTranscriptKind(m.kind) && !m.withdrawn_at)
			.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
	);

	// The event stream carries a run's changes; its state when you open the chat is read once.
	$effect(() => {
		const id = selected.id;
		if (connected) void runtime.loadProjectRun(id);
	});

	/**
	 * The account its next run spends, the model its runs ask for and their thinking level, each the
	 * session's own and kept with it, picked in one cascading picker (`ProjectAgentTune`). The models
	 * are the ones your Claude Code lists for that account, as its `/model` does, its default first
	 * for what your settings say; one set elsewhere stays a choice. The thinking levels are the ones
	 * the picked model takes. A model or level change reaches a run going now from its next step; an
	 * account change waits for the run to end.
	 */
	const account = $derived(selected.project_config_dir ?? '');
	/**
	 * Whose session it is (ADR 0099): a Codex session has no account to pick and no plan mode, its `/`
	 * lists what the app carries out for Codex and its skills, and its models are the ones Codex lists.
	 */
	const agent = $derived(projectAgentOf(selected));
	const caps = $derived(PROJECT_AGENT_CAPS[agent]);
	const agentName = $derived(t.project.agentNames[agent]);
	// Asked once each; untracked, so what the asking writes does not ask again.
	$effect(() => {
		const api = runtime.client;
		const codex = agent === 'codex';
		untrack(() => (codex ? loadCodexStatus(api) : loadClaudeStatus(api)));
	});
	$effect(() => {
		const api = runtime.client;
		const dir = account || null;
		if (agent === 'claude_code') untrack(() => loadClaudeModels(api, dir));
	});
	const accountOptions = $derived(accountChoices(claudeStatus(), account, t.project.defaultAccount));
	/** Picked only with a second account to pick, or the session already on one. */
	const accountShown = $derived(caps.accounts && accountOptions.length > 1);
	const model = $derived(selected.project_model ?? '');
	const effort = $derived(selected.project_effort ?? '');
	let tuneFailed = $state(false);
	let accountRefused = $state(false);

	async function tune(change: PatchProjectSessionRequest): Promise<void> {
		const failure = await runtime.tuneProjectSession(selected.id, change);
		accountRefused = failure?.status === 409 && change.config_dir !== undefined;
		tuneFailed = failure !== null && !accountRefused;
	}

	/**
	 * Plan mode (ADR 0098), the session's own: its runs start in it, and a run going now switches at
	 * its next step. An approved plan turns it off; the session's own event brings that back here.
	 */
	const planning = $derived(selected.project_mode === 'plan');

	function togglePlan(): void {
		if (connected && caps.plan) void tune({ mode: planning ? null : 'plan' });
	}

	/**
	 * Typing `/` at the start of the line lists the agent's commands that fit what follows, while the
	 * caret is still in that word (`project-commands.svelte.ts`); Esc closes it until the line changes.
	 */
	let caret = $state(0);
	let commandsClosedAt = $state<string | null>(null);
	let commandActive = $state(0);
	const commandMenuId = $derived(`project-commands-${selected.id}`);
	const commandQuery = $derived(caps.commands ? slashQuery(view.draft, caret) : null);
	const commandsShown = $derived(commandQuery !== null && commandsClosedAt !== view.draft);
	const commandsState = $derived(commandsShown ? projectCommandsOf(selected.id) : null);
	const commandMatches = $derived(Array.isArray(commandsState) && commandQuery !== null ? matchCommands(commandsState, commandQuery) : []);
	const commandsListed = $derived(commandsShown && commandMatches.length > 0);
	$effect(() => {
		if (!commandsShown) return;
		const api = runtime.client;
		const id = selected.id;
		untrack(() => loadProjectCommands(api, id));
	});
	// A new word starts at the best match.
	$effect(() => {
		void commandQuery;
		commandActive = 0;
	});

	function trackCaret(): void {
		if (field) caret = field.selectionStart;
	}

	/** A picked command fills the line's first word; `run` sends it as it stands. */
	function pickCommand(command: ClaudeCodeCommand, run: boolean): void {
		const next = withCommand(view.draft, command.name, run);
		view.draft = next.text;
		caret = next.caret;
		sendFailed = false;
		if (run) {
			void send();
			return;
		}
		void tick().then(() => {
			grow();
			field?.focus();
			field?.setSelectionRange(next.caret, next.caret);
		});
	}

	/** The menu's keys, while it is open; true when the key was its. */
	function commandKey(event: KeyboardEvent): boolean {
		if (!commandsShown) return false;
		if (event.key === 'Escape') {
			event.preventDefault();
			commandsClosedAt = view.draft;
			return true;
		}
		if (commandMatches.length === 0) return false;
		const count = commandMatches.length;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			commandActive = (commandActive + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
			return true;
		}
		const command = commandMatches[Math.min(commandActive, count - 1)]!;
		if (event.key === 'Tab' && !event.shiftKey) {
			event.preventDefault();
			pickCommand(command, false);
			return true;
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			pickCommand(command, true);
			return true;
		}
		return false;
	}

	/**
	 * The microphone (ADR 0073), as in a Bot's composer: what is heard goes in where the caret was,
	 * in the session it was recorded for, and nothing is sent until you send it. The box is a plain
	 * field, so the caret is its selection, which stays put while the button has the focus.
	 */
	let voiceCaret: { start: number; end: number } | null = null;
	const voice = new ComposerVoice({
		api: () => runtime.client,
		t: () => t,
		sessionId: () => selected.id,
		markCaret: () => (voiceCaret = field ? { start: field.selectionStart, end: field.selectionEnd } : null),
		insert: (sessionId, heard) => {
			const caret = voiceCaret;
			voiceCaret = null;
			const target = runtime.sessionView(sessionId);
			if (sessionId !== selected.id) {
				target.draft = target.draft + spacedHeard(target.draft, heard);
				return;
			}
			const draft = target.draft;
			const start = Math.min(caret?.start ?? draft.length, draft.length);
			const end = Math.min(Math.max(caret?.end ?? start, start), draft.length);
			const before = draft.slice(0, start);
			const piece = spacedHeard(before, heard);
			target.draft = before + piece + draft.slice(end);
			sendFailed = false;
			void tick().then(() => {
				grow();
				if (field && document.activeElement === field) field.setSelectionRange(before.length + piece.length, before.length + piece.length);
			});
		}
	});
	/** Offered once a speech endpoint is ready, as in a Bot's composer. */
	const voiceOffered = $derived(speechReady(snapshot.settings.speech));
	$effect(() => () => voice.cancel());

	/**
	 * The working bubble's clock and commands, as a Bot's: its step and the commands it ran come from
	 * the run's tool frames (`turn_id` is the run's id); a page opened mid-run has only the step the
	 * run last stored until the next frame.
	 */
	let nowMs = $state(Date.now());
	$effect(() => {
		if (!live) return;
		const timer = setInterval(() => (nowMs = Date.now()), 250);
		return () => clearInterval(timer);
	});
	const stepLine = $derived.by(() => {
		void runtime.toolRevision;
		const step = run && live ? runtime.stepOf(run.id) : null;
		return step ? describeStep(step, t.chat.activity, nowMs) : null;
	});
	const commandRows = $derived.by(() => {
		void runtime.activityRevision;
		return run && live ? runtime.activity.forTurn(run.id) : [];
	});

	/**
	 * What goes with your next line, staged on the conversation as a Bot's composer stages it, and
	 * kept there until the Mac has it. Claude Code sees a picture as one, and any other file by its
	 * path (ADR 0095).
	 */
	const attachments = new ComposerAttachments({
		runtime: () => runtime,
		selected: () => selected,
		view: () => view,
		lockedComposer: () => false,
		connected: () => connected,
		fileDrop: () => false,
		editorEl: () => null
	});
	const staged = $derived(attachments.pendingAttachments);
	const sendable = $derived(Boolean(view.draft.trim()) || staged.length > 0);

	/** A paste with files stages them; words paste as the field pastes them. */
	function onPaste(event: ClipboardEvent): void {
		const files = pastedFiles(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		attachments.addFiles(files);
	}

	/** A picture of yours opened from its chip, enlarged over the whole app as in a Bot's conversation. */
	let shownImage = $state<{ sessionId: string; attachment: Attachment; origin: ImageOrigin | null; placeholder: string | null } | null>(null);

	function openImage(attachment: Attachment, from?: HTMLElement | null): void {
		shownImage = { sessionId: selected.id, attachment, origin: pictureOrigin(from), placeholder: pictureStandIn(from) };
	}

	let scroller = $state<HTMLElement | null>(null);
	let composerEl = $state<HTMLElement | null>(null);
	let stuck = true;
	let answerFailed = $state(false);
	let sendFailed = $state(false);
	let answering = $state(false);
	let field = $state<HTMLTextAreaElement | null>(null);

	function toBottom(): void {
		void tick().then(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	}

	async function onScroll(): Promise<void> {
		if (!scroller) return;
		stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		if (scroller.scrollTop < 120 && view.hasOlderMessages && !view.olderLoading) {
			const before = scroller.scrollHeight;
			await runtime.loadOlderMessages(selected.id);
			await tick();
			// What came in above must not push what you were reading down.
			if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
		}
	}

	// Another conversation starts at its end. Its id, not its summary: each line or read in this
	// one brings a new summary, and that must not pull you down from what you scrolled up to.
	const sessionId = $derived(selected.id);
	$effect(() => {
		void sessionId;
		stuck = true;
		toBottom();
	});
	// New lines and a run's progress follow you down, unless you scrolled up to read.
	$effect(() => {
		void lines.length;
		void run?.partial;
		void run?.activity;
		void run?.status;
		if (stuck) toBottom();
	});
	/**
	 * The composer floats over the transcript, as a Bot's does, so the list and its scrollbar run to
	 * the pane's bottom. The list keeps room under its last line as tall as the composer actually is
	 * (a longer line, staged files and an error all grow it), and the card keeps its margin off a
	 * classic scrollbar on the list's right edge. Either changing keeps you at the end if you were.
	 */
	$effect(() => {
		const list = scroller;
		const bar = composerEl;
		const chat = list?.parentElement;
		if (!list || !bar || !chat || typeof ResizeObserver === 'undefined') return;
		const apply = () => {
			chat.style.setProperty('--composer-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
			chat.style.setProperty('--stream-scrollbar', `${list.offsetWidth - list.clientWidth}px`);
			if (stuck) list.scrollTop = list.scrollHeight;
		};
		// The scrollbar showing up narrows the list's content box, so watching the list sees it come and go.
		const observer = new ResizeObserver(apply);
		observer.observe(bar);
		observer.observe(list);
		apply();
		return () => {
			observer.disconnect();
			chat.style.removeProperty('--composer-height');
			chat.style.removeProperty('--stream-scrollbar');
		};
	});

	// Reading it: the last line counts as read once the window has shown it for a moment.
	let readTimer: ReturnType<typeof setTimeout> | null = null;
	let windowFocused = $state(typeof document !== 'undefined' ? document.hasFocus() : true);
	onMount(() => {
		const focus = () => (windowFocused = true);
		const blur = () => (windowFocused = false);
		window.addEventListener('focus', focus);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('focus', focus);
			window.removeEventListener('blur', blur);
			if (readTimer) clearTimeout(readTimer);
		};
	});
	$effect(() => {
		const id = selected.id;
		const last = lines.at(-1)?.id;
		const notice = runtime.noticeMark(id);
		void windowFocused;
		if (readTimer) clearTimeout(readTimer);
		readTimer = null;
		if (!last) return;
		const ready = transcriptReadingReady(
			{
				visibility: document.visibilityState,
				hasFocus: document.hasFocus(),
				connected,
				snapshotReady: true,
				overlayBlocksTranscript: runtime.settingsOpen || runtime.workspaceOpen
			},
			desktopReadingMode(runtime.isDesktopShell, runtime.nativeCapabilities),
			runtime.isDesktopShell ? runtime.nativeFocusFacts : null
		);
		if (!ready || !stuck) return;
		readTimer = setTimeout(() => {
			readTimer = null;
			if (document.hasFocus() && document.visibilityState === 'visible') void runtime.submitBoundedRead(id, last, notice);
		}, TRANSCRIPT_VISIBLE_MS);
		return () => {
			if (readTimer) clearTimeout(readTimer);
			readTimer = null;
		};
	});

	async function answer(allow: boolean): Promise<void> {
		if (!run || answering) return;
		answering = true;
		answerFailed = false;
		const failure = await runtime.answerAgentRun(run.id, allow);
		answering = false;
		// null is also what a dropped link answers; the run's own event says what became of it.
		answerFailed = failure !== null;
	}

	async function stop(): Promise<void> {
		if (!run) return;
		answerFailed = (await runtime.stopAgentRun(run.id)) !== null;
	}

	async function send(): Promise<void> {
		if (!sendable || view.sending) return;
		sendFailed = false;
		stuck = true;
		const target = view;
		const files = [...staged];
		const sent = await runtime.send({ sessionId: selected.id, attachments: files.length > 0 ? files.map((row) => row.file) : undefined });
		sendFailed = !sent;
		if (sent) {
			// What was staged goes once the Mac has it, as in a Bot's composer.
			for (const row of files) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
			const gone = new Set(files.map((row) => row.id));
			target.stagedAttachments = target.stagedAttachments.filter((row) => !gone.has(row.id));
			if (field) field.style.height = '';
			field?.focus();
			toBottom();
		}
	}

	/** Enter that confirms a pinyin or kana candidate is the input method's, not a send. */
	let ime = $state<ComposerImeState>(COMPOSER_IME_IDLE);

	function onKey(event: KeyboardEvent): void {
		const action = composerImeKeyAction(event, ime, Date.now());
		if (action === 'swallow') event.preventDefault();
		if (action !== 'pass') return;
		if (commandKey(event)) return;
		// Shift+Tab switches plan mode, as in the terminal; where there is none it moves the focus as usual.
		if (caps.plan && event.key === 'Tab' && event.shiftKey) {
			event.preventDefault();
			togglePlan();
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		void send();
	}

	function grow(): void {
		if (!field) return;
		field.style.height = 'auto';
		field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
	}

	function lineOf(message: Message): 'you' | 'agent' | 'app' {
		if (message.kind === 'system' || message.author === 'app') return 'app';
		return message.author === USER_MEMBER ? 'you' : 'agent';
	}
</script>

<div class="project-chat flex-1 min-h-0 flex flex-col bg-pane" data-project-chat={selected.id}>
	<div class="transcript" bind:this={scroller} onscroll={() => void onScroll()}>
		<div class="transcript-inner">
			{#if view.hasOlderMessages}
				<div class="earlier muted" role="status">{view.olderLoading ? t.stream.loadingEarlier : ' '}</div>
			{/if}
			{#if lines.length === 0 && !live && !view.historyLoading}
				<p class="empty muted">{t.project.empty(agentName)}</p>
			{/if}
			{#each lines as message, index (message.id)}
				{@const previous = index > 0 ? lines[index - 1] : null}
				{@const who = lineOf(message)}
				{#if !previous || isDifferentDay(previous.created_at, message.created_at)}
					<div class="day"><span>{formatDateDivider(message.created_at, locale)}</span></div>
				{/if}
				{#if who === 'app'}
					<div class="line is-app" data-line="app">{message.body}</div>
				{:else if who === 'you'}
					<div class="line is-you" data-line="you">
						<div class="bubble">
							{#if message.body}<div class="words">{message.body}</div>{/if}{#if message.attachments.length > 0}
								<MessageAttachments
									attachments={message.attachments}
									api={runtime.client}
									{t}
									onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, message.id)}
									onOpenImage={openImage}
								/>
							{/if}
						</div>
						<span class="time">{formatMessageTime(message.created_at)}</span>
					</div>
				{:else}
					<div class="line is-agent" data-line="agent">
						<MarkdownBody source={message.body} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} onOpenArtifact={(path) => openCited(path, message.id)} />
						<span class="time">{formatMessageTime(message.created_at)}</span>
					</div>
				{/if}
			{/each}

			{#if run && live}
				<!-- The agent at work, as a Bot's working bubble: what it has said, its commands, then where it is and for how long. -->
				<div class="line is-agent is-stream" data-line="working" data-agent-run={run.status}>
					{#if run.partial}
						<MarkdownBody source={run.partial} options={{ streaming: true }} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} onOpenArtifact={(path) => openCited(path)}>
							<span class="streaming-cursor"></span>
						</MarkdownBody>
					{/if}
					{#if !focusMode.on}
						<CommandActivity rows={commandRows} {t} />
					{/if}
					<div class="stream-foot" role="status" aria-live="polite">
						<span class="pulse" aria-hidden="true"></span>
						{#if waiting}
							<span class="stream-step">{planWaiting ? t.project.waitingPlan : t.project.waiting(agentName)}</span>
						{:else if !focusMode.on && stepLine}
							<span class="stream-step" title={stepLine.full}>{stepLine.text}</span>
							{#if stepLine.elapsed}<span class="stream-step-elapsed mono" aria-hidden="true">{stepLine.elapsed}</span>{/if}
						{:else if !focusMode.on && run.activity}
							<span class="stream-step" title={run.activity}>{run.activity}</span>
						{:else}
							<span class="stream-step">{run.partial ? t.stream.streaming : t.sidebar.statusRunning}</span>
						{/if}
						{#if !focusMode.on}
							<span class="duration-badge">
								<Icon name="clock" size={12} />
								{formatLiveDuration(run.created_at, nowMs, t.chat.spanPart)}
							</span>
						{/if}
					</div>
				</div>
				{#if waiting && planWaiting}
					<!-- The plan it asks you to approve: approved, it gets to work; a line you send is what to change. -->
					<ProjectPlanCard {t} approval={waiting} disabled={answering || !connected} onAnswer={(allow) => void answer(allow)} onOpenPath={(path) => openCited(path)} />
				{:else if waiting}
					<!-- What it waits on you for, as a Bot's approval card. -->
					<article class="approval-card" data-agent-approval>
						<div class="approval-head">
							<Icon name="shield-check" size={12} />
							<span>{t.project.approvalHead}</span>
							<span class="approval-who">{agentName}</span>
						</div>
						<div class="approval-main">
							<pre class="approval-summary mono">{waiting.summary}</pre>
							<div class="approval-actions">
								<Button variant="primary" icon="check" disabled={answering || !connected} onclick={() => void answer(true)}>{t.project.allow}</Button>
								<Button disabled={answering || !connected} onclick={() => void answer(false)}>{t.project.deny}</Button>
							</div>
						</div>
					</article>
				{/if}
				{#if answerFailed}
					<p class="field-error">{t.project.actionFailed}</p>
				{/if}
			{/if}
		</div>
	</div>

	<div class="composer" bind:this={composerEl}>
		<div class="composer-column">
			{#if sendFailed || tuneFailed}
				<p class="field-error">{t.project.actionFailed}</p>
			{:else if accountRefused}
				<p class="field-error">{t.project.accountBusy}</p>
			{/if}
			<VoiceStatus {voice} {t} />
			<div class="composer-box">
				{#if commandsShown}
					<ProjectCommandMenu
						{t}
						{agentName}
						id={commandMenuId}
						status={commandsState}
						matches={commandMatches}
						active={commandActive}
						onHover={(index) => (commandActive = index)}
						onPick={(command) => pickCommand(command, false)}
					/>
				{/if}
				{#if staged.length > 0}
					<ComposerAttachmentsBar
						{t}
						pendingAttachments={staged}
						pendingPaths={[]}
						sending={view.sending}
						uploadedPercent={(file) => uploadedShare(view.upload, file)}
						onRemoveAttachment={attachments.removePendingAttachment}
						onRemovePath={() => {}}
					/>
				{/if}
				<textarea
					bind:this={field}
					rows="1"
					aria-label={t.project.composerLabel(agentName)}
					placeholder={planning ? t.project.composerPlaceholderPlan : t.project.composerPlaceholder(agentName)}
					aria-autocomplete="list"
					aria-controls={commandsListed ? commandMenuId : undefined}
					aria-activedescendant={commandsListed ? `${commandMenuId}-${commandActive}` : undefined}
					value={view.draft}
					oninput={(event) => {
						view.draft = event.currentTarget.value;
						caret = event.currentTarget.selectionStart;
						sendFailed = false;
						grow();
					}}
					onkeydown={onKey}
					onkeyup={(event) => {
						if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') trackCaret();
					}}
					onclick={trackCaret}
					onfocus={trackCaret}
					onblur={() => (commandsClosedAt = view.draft)}
					onpaste={onPaste}
					oncompositionstart={() => (ime = composerImeOnStart())}
					oncompositionupdate={() => (ime = composerImeOnUpdate(ime))}
					oncompositionend={() => (ime = composerImeOnEnd(Date.now()))}
				></textarea>
				<div class="composer-tools">
					<button
						type="button"
						class="attach"
						title={t.composer.attach}
						aria-label={t.composer.attach}
						disabled={!connected || Boolean(view.sending)}
						onclick={attachments.openFilePicker}
						data-project-attach
					>
						<Icon name="paperclip" size={16} />
					</button>
					<input type="file" multiple hidden bind:this={attachments.fileInputEl} onchange={attachments.onFileInputChange} />
					<!-- Plan mode, the session's own: on, it plans and asks before changing anything. Claude Code's only. -->
					{#if caps.plan}
						<button
							type="button"
							class="plan-toggle"
							class:is-on={planning}
							aria-pressed={planning}
							title={planning ? t.project.planOnHint : t.project.planOffHint}
							disabled={!connected}
							onclick={togglePlan}
							data-project-plan
						>
							<Icon name="list" size={16} />
							<span>{t.project.plan}</span>
						</button>
					{/if}
					<!-- An account changes for the next run: Claude Code keeps the session under the account it ran on. -->
					<ProjectAgentTune
						{t}
						{agent}
						models={agent === 'codex' ? codexModels() : undefined}
						tune={{ account, model, effort }}
						accounts={accountShown ? accountOptions : null}
						accountLocked={live}
						disabled={!connected}
						client={runtime.client}
						onpick={(change) => void tune(change)}
					/>
					<span class="tools-gap"></span>
					{#if voiceOffered || voice.busy}
						<VoiceButton {voice} {t} disabled={!connected} />
					{/if}
					<!-- Stop beside Send while the agent works, as in a Bot's direct: a line sent meanwhile goes into the run. -->
					<SendButton
						{t}
						{connected}
						primaryAction={{ kind: 'send', disabled: !sendable || Boolean(view.sending) || !connected }}
						directStop={live}
						stepsAside={false}
						sending={view.sending}
						upload={view.upload}
						onStop={() => void stop()}
						onSend={() => void send()}
					/>
				</div>
			</div>
		</div>
	</div>

	{#if shownImage && shownImage.sessionId === selected.id}
		<MessageImageLightbox
			attachment={shownImage.attachment}
			relpath={shownImage.attachment.workspace_relpath}
			origin={shownImage.origin}
			placeholder={shownImage.placeholder}
			api={runtime.client}
			{t}
			onClose={() => (shownImage = null)}
		/>
	{/if}
</div>

<style>
	.project-chat {
		position: relative;
		overflow: hidden;
	}

	.transcript {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-anchor: none;
	}

	.transcript-inner {
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: 100%;
		max-width: calc(var(--chat-max-width) + 48px);
		margin-inline: auto;
		/* Room for the composer floating over this list, as tall as it actually is. */
		padding: 20px 24px calc(var(--composer-height, 120px) + 16px);
		box-sizing: border-box;
	}

	.earlier {
		text-align: center;
		font-size: 12px;
	}

	.empty {
		margin: 40px 0;
		text-align: center;
		font-size: 13px;
	}

	.day {
		position: relative;
		display: flex;
		justify-content: center;
		margin-top: 10px;
	}

	.day::before {
		content: '';
		position: absolute;
		inset: 50% 0 auto 0;
		height: 1px;
		background: var(--line-subtle);
	}

	.day span {
		position: relative;
		padding: 0 12px;
		background: var(--pane);
		font-size: var(--text-micro);
		font-weight: 600;
		color: var(--date-pill-text);
	}

	.line {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.line .time {
		margin-top: 3px;
		font-size: 11px;
		color: var(--muted);
	}

	.line.is-you {
		align-items: flex-end;
	}

	.line.is-you .bubble {
		max-width: 80%;
		padding: 10px 14px;
		border-radius: var(--radius-lg) var(--radius-xs) var(--radius-lg) var(--radius-lg);
		background: var(--you);
		color: var(--you-text);
		--selection: color-mix(in srgb, var(--you-text) 30%, transparent);
		box-shadow: var(--shadow-xs);
	}

	.line.is-you .words {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.line.is-agent {
		align-items: flex-start;
	}

	.line.is-agent :global(.md-body),
	.line.is-agent > :global(div) {
		max-width: 100%;
	}

	.line.is-app {
		align-self: center;
		max-width: 90%;
		padding: 4px 12px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 12px;
		text-align: center;
		overflow-wrap: anywhere;
	}

	/* The working bubble's last line, as a Bot's: its step, that step's time and the whole run's. */
	.stream-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-top: 8px;
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
	}

	.line.is-stream :global(.command-activity) {
		margin-top: 8px;
	}

	/* Working is the accent everywhere — the sidebar row, a Bot's bubble and this. */
	.pulse {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.2s ease-in-out infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}

	/* A long command clips; the times beside it never do. */
	.stream-step {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stream-step-elapsed,
	.duration-badge {
		flex-shrink: 0;
	}

	/* The whole run's time sits at the right end, where a finished line has its time. */
	.duration-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
		padding-left: 8px;
		font-weight: 400;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.streaming-cursor {
		display: inline-block;
		width: 7px;
		height: 14px;
		background: var(--accent);
		margin-left: 3px;
		vertical-align: -2px;
		animation: cursorBlink 0.8s infinite;
	}

	/* What it waits on you for, as a Bot's approval card: a warn-tinted head and a soft warn ring. */
	.approval-card {
		overflow: hidden;
		border: 1px solid var(--warn-line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--warn) 10%, transparent),
			var(--shadow-sm);
	}

	.approval-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 9px 16px;
		border-bottom: 1px solid var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
		font-size: var(--text-caption);
		font-weight: 650;
	}

	.approval-who {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.approval-who::before {
		content: '·';
		margin-right: 6px;
		color: var(--muted-light);
	}

	.approval-main {
		padding: 12px 16px 14px;
	}

	.approval-summary {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--ink);
	}

	.approval-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}

	/* Over the transcript, which runs on under it; only the column takes the pointer, so the list
	   still scrolls and selects beside the card. On the transcript's column: a classic scrollbar
	   takes the list's right edge, and the card keeps its margin off it. */
	.composer {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 4;
		padding: 8px calc(24px + var(--stream-scrollbar, 0px)) calc(14px + env(safe-area-inset-bottom)) 24px;
		box-sizing: border-box;
		pointer-events: none;
	}

	.composer-column {
		position: relative;
		max-width: var(--chat-max-width);
		margin-inline: auto;
		pointer-events: auto;
	}

	/* Frost hugging the card and the lines above it, as on a Bot's composer: what scrolls under them
	   blurs. Under the column's own lines (the composer is its stacking context), not over them. */
	.composer-column::before {
		content: "";
		position: absolute;
		z-index: -1;
		inset: -8px;
		border-radius: calc(var(--radius-lg) + 8px);
		pointer-events: none;
		background: color-mix(in srgb, var(--glass-composer) 50%, transparent);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
	}

	/* The line on top, the model and Send under it, as in the agents' own apps. */
	.composer-box {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 8px 8px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--input-bg);
		box-shadow: var(--shadow-xs);
	}

	.composer-box:focus-within {
		border-color: var(--field-focus-border);
		box-shadow: var(--field-focus-ring);
	}

	.composer-box textarea {
		width: 100%;
		min-width: 0;
		max-height: 200px;
		padding: 6px 0;
		border: 0;
		outline: none;
		box-shadow: none;
		resize: none;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		line-height: 1.5;
	}

	.composer-tools {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* The clip leads the row, its glyph under the line's first letter. */
	.attach {
		flex: 0 0 30px;
		width: 30px;
		height: 30px;
		margin-left: -8px;
		padding: 0;
		border: none;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background-color 0.15s ease, color 0.15s ease;
	}

	.attach:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.attach:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.tools-gap {
		flex: 1;
	}

	/* Plan mode: quiet while off, the accent's tint while on, as a selected item of a set is. */
	.plan-toggle {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		padding: 0 9px 0 7px;
		border: 1px solid transparent;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
	}

	.plan-toggle:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.plan-toggle.is-on {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-toggle.is-on:hover:not(:disabled) {
		background: var(--accent-tint);
		color: var(--accent-hover);
	}

	.plan-toggle:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* The conversation's own width, as in a Bot's (the `conversation` container): a workbench pane as narrow as a phone gets it in a wide window too. */
	@container conversation (max-width: 680px) {
		.transcript-inner {
			padding: 14px 12px calc(var(--composer-height, 120px) + 12px);
		}

		.composer {
			padding: 6px calc(12px + var(--stream-scrollbar, 0px)) calc(10px + env(safe-area-inset-bottom)) 12px;
		}


		.line.is-you .bubble {
			max-width: 88%;
		}
	}

	/* As narrow as a phone itself the composer docks, as a Bot's does: a bar across the bottom, its
	   line on top, in the chat's flow, so the transcript ends above it and keeps no room for it. */
	@container conversation (max-width: 480px) {
		.transcript-inner {
			padding-bottom: 12px;
		}

		.composer {
			position: relative;
			bottom: auto;
			flex: none;
			pointer-events: auto;
			padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px)) 12px;
			background: var(--input-bg);
			border-top: 1px solid var(--line);
			transition: border-color 0.15s ease;
		}

		.composer:focus-within {
			border-top-color: var(--field-focus-border);
		}

		.composer-column {
			max-width: none;
		}

		.composer-column::before {
			display: none;
		}

		.composer-box,
		.composer-box:focus-within {
			padding: 0;
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
		}

		/* A thumb, on a screen whose edges may curve away: the bar keeps its own margin from all three. */
		@media (pointer: coarse) {
			.composer {
				padding: 6px max(16px, env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
			}
		}
	}
</style>
