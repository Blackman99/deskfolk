<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, isHiddenTranscriptKind, speechReady, USER_MEMBER, type Attachment, type Message, type SessionSummary } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import Select from '../Select.svelte';
	import { claudeAgentSource } from '../model-source.ts';
	import type { SelectOption } from '../select-options.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { desktopReadingMode, transcriptReadingReady, TRANSCRIPT_VISIBLE_MS } from '../notifications/reading.ts';
	import { isLiveRun } from '../sidebar/project-groups.ts';
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
	import VoiceButton from './VoiceButton.svelte';
	import VoiceStatus from './VoiceStatus.svelte';
	import { ProjectCitedPaths } from './project-cited-path.ts';
	import { showToast } from '../toast.svelte.ts';

	/**
	 * A project session's conversation (ADR 0095): you and the agent in a directory, as in the
	 * agent's own desktop app. It has no Bot, so none of the Bot stage applies: your lines on the
	 * right, the agent's on the left as markdown, the app's centred. The run going on is a Bot's
	 * working bubble at the end — what it has said, its commands folded, its step and times on the
	 * last line — with the approval it waits on under it; Stop is in the composer, as in a Bot's
	 * direct. The header is the pane's or the page's own.
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
	 * The model its runs ask for: Claude Code's aliases, or none for what your settings say. One
	 * set elsewhere (a full id) stays a choice. A change reaches a run going now from its next step.
	 */
	const model = $derived(selected.project_model ?? '');
	const modelOptions = $derived.by((): SelectOption[] => {
		const mark = claudeAgentSource(t);
		const names: string[] = [...CLAUDE_MODEL_ALIASES];
		if (model && !names.includes(model)) names.push(model);
		return [{ value: '', label: t.project.modelDefault, source: mark }, ...names.map((name) => ({ value: name, label: name, source: mark }))];
	});
	/** The thinking level its runs ask for, the same way: none for what your settings say. */
	const effort = $derived(selected.project_effort ?? '');
	const effortOptions = $derived.by((): SelectOption[] => [
		{ value: '', label: t.project.effortDefault },
		...CLAUDE_EFFORTS.map((level) => ({ value: level, label: t.sidebar.thinkingLevels[level] }))
	]);
	let tuneFailed = $state(false);

	async function pickModel(value: string): Promise<void> {
		if (value === model) return;
		tuneFailed = (await runtime.tuneProjectSession(selected.id, { model: value || null })) !== null;
	}

	async function pickEffort(value: string): Promise<void> {
		if (value === effort) return;
		const level = CLAUDE_EFFORTS.find((each) => each === value) ?? null;
		tuneFailed = (await runtime.tuneProjectSession(selected.id, { effort: level })) !== null;
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

	let scroller = $state<HTMLElement | null>(null);
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

	// Another conversation starts at its end.
	$effect(() => {
		void selected.id;
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
		if (!view.draft.trim() || view.sending) return;
		sendFailed = false;
		stuck = true;
		const sent = await runtime.send({ sessionId: selected.id });
		sendFailed = !sent;
		if (sent) {
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
		if (action !== 'pass' || event.key !== 'Enter' || event.shiftKey) return;
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
				<p class="empty muted">{t.project.empty}</p>
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
						<div class="bubble">{message.body}</div>
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
							<span class="stream-step">{t.project.waiting}</span>
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
				{#if waiting}
					<!-- What it waits on you for, as a Bot's approval card. -->
					<article class="approval-card" data-agent-approval>
						<div class="approval-head">
							<Icon name="shield-check" size={12} />
							<span>{t.project.approvalHead}</span>
							<span class="approval-who">{t.project.agentName}</span>
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

	<div class="composer">
		{#if sendFailed || tuneFailed}
			<p class="field-error">{t.project.actionFailed}</p>
		{/if}
		<VoiceStatus {voice} {t} />
		<div class="composer-box">
			<textarea
				bind:this={field}
				rows="1"
				aria-label={t.project.composerLabel}
				placeholder={t.project.composerPlaceholder}
				value={view.draft}
				oninput={(event) => {
					view.draft = event.currentTarget.value;
					sendFailed = false;
					grow();
				}}
				onkeydown={onKey}
				oncompositionstart={() => (ime = composerImeOnStart())}
				oncompositionupdate={() => (ime = composerImeOnUpdate(ime))}
				oncompositionend={() => (ime = composerImeOnEnd(Date.now()))}
			></textarea>
			<div class="composer-tools">
				<!-- What the default is, on the pointer: a hint in the picker itself would crowd the composer. -->
				<div class="model" data-project-model title={model ? undefined : t.project.modelDefaultHint}>
					<Select
						size="sm"
						placement="top"
						value={model}
						options={modelOptions}
						ariaLabel={t.project.modelLabel}
						title={t.project.modelLabel}
						disabled={!connected}
						onchange={(value) => void pickModel(value)}
					/>
				</div>
				<div class="effort" data-project-effort title={effort ? undefined : t.project.effortDefaultHint}>
					<Select
						size="sm"
						placement="top"
						value={effort}
						options={effortOptions}
						ariaLabel={t.project.effortLabel}
						title={t.project.effortLabel}
						disabled={!connected}
						onchange={(value) => void pickEffort(value)}
					/>
				</div>
				<span class="tools-gap"></span>
				{#if voiceOffered || voice.busy}
					<VoiceButton {voice} {t} disabled={!connected} />
				{/if}
				<!-- Stop beside Send while the agent works, as in a Bot's direct: a line sent meanwhile goes into the run. -->
				<SendButton
					{t}
					{connected}
					primaryAction={{ kind: 'send', disabled: !view.draft.trim() || Boolean(view.sending) || !connected }}
					directStop={live}
					stepsAside={false}
					sending={view.sending}
					upload={undefined}
					onStop={() => void stop()}
					onSend={() => void send()}
				/>
			</div>
		</div>
	</div>
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
		padding: 20px 24px 16px;
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
		box-shadow: var(--shadow-xs);
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

	.composer {
		flex: none;
		width: 100%;
		max-width: calc(var(--chat-max-width) + 48px);
		margin-inline: auto;
		padding: 8px 24px calc(14px + env(safe-area-inset-bottom));
		box-sizing: border-box;
	}

	/* The line on top, the model and Send under it, as in the agents' own apps. */
	.composer-box {
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

	.model,
	.effort {
		min-width: 0;
		max-width: 200px;
	}

	.model {
		margin-left: -6px;
	}

	.tools-gap {
		flex: 1;
	}

	@media (max-width: 680px) {
		.transcript-inner {
			padding: 14px 12px 12px;
		}

		.composer {
			padding: 6px 12px calc(10px + env(safe-area-inset-bottom));
		}


		.line.is-you .bubble {
			max-width: 88%;
		}
	}
</style>
