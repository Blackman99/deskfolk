<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { isHiddenTranscriptKind, USER_MEMBER, type Message, type SessionSummary } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
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
	import { formatDateDivider, formatMessageTime, isDifferentDay } from './chat-view.ts';

	/**
	 * A project session's conversation (ADR 0095): you and the agent in a directory, as in the
	 * agent's own desktop app. It has no Bot, so none of the Bot stage applies: your lines on the
	 * right, the agent's on the left as markdown, the app's centred, and below them the run that is
	 * going on, with the approval it waits on and Stop. The header is the pane's or the page's own.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary;
	};

	let { runtime, t, selected }: Props = $props();

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
						<MarkdownBody source={message.body} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} />
						<span class="time">{formatMessageTime(message.created_at)}</span>
					</div>
				{/if}
			{/each}

			{#if run && live}
				<div class="run" data-agent-run={run.status}>
					<div class="run-head" role="status" aria-live="polite">
						<span class="pulse" aria-hidden="true"></span>
						<span class="run-title">{waiting ? t.project.waiting : t.project.working}</span>
						<Button size="sm" icon="square" onclick={() => void stop()} disabled={!connected}>{t.project.stop}</Button>
					</div>
					{#if run.activity}
						<div class="activity mono" title={run.activity}>{run.activity}</div>
					{/if}
					{#if run.partial}
						<div class="partial">
							<MarkdownBody source={run.partial} options={{ streaming: true }} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} />
						</div>
					{/if}
					{#if waiting}
						<div class="approval" data-agent-approval>
							<span class="approval-head"><Icon name="shield-check" size={12} />{t.project.approvalHead}</span>
							<pre class="approval-summary mono">{waiting.summary}</pre>
							<div class="approval-actions">
								<Button variant="primary" disabled={answering || !connected} onclick={() => void answer(true)}>{t.project.allow}</Button>
								<Button disabled={answering || !connected} onclick={() => void answer(false)}>{t.project.deny}</Button>
							</div>
						</div>
					{/if}
					{#if answerFailed}
						<p class="field-error">{t.project.actionFailed}</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="composer">
		{#if sendFailed}
			<p class="field-error">{t.project.actionFailed}</p>
		{/if}
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
			<button
				type="button"
				class="send"
				title={t.project.send}
				aria-label={t.project.send}
				disabled={!view.draft.trim() || view.sending || !connected}
				onclick={() => void send()}
			>
				<Icon name="arrow-up" size={16} />
			</button>
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

	.run {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
	}

	.run-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.run-title {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.pulse {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		animation: run-pulse 1.4s ease-in-out infinite;
	}

	@keyframes run-pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}

	.activity {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	/* What it has said so far, fainter than a settled reply. */
	.partial {
		opacity: 0.65;
	}

	.approval {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
	}

	.approval-head {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
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
		gap: 8px;
	}

	.composer {
		flex: none;
		width: 100%;
		max-width: calc(var(--chat-max-width) + 48px);
		margin-inline: auto;
		padding: 8px 24px calc(14px + env(safe-area-inset-bottom));
		box-sizing: border-box;
	}

	.composer-box {
		display: flex;
		align-items: flex-end;
		gap: 8px;
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
		flex: 1;
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

	.send {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: var(--accent);
		color: var(--on-accent);
	}

	.send:disabled {
		opacity: 0.4;
	}

	@media (max-width: 680px) {
		.transcript-inner {
			padding: 14px 12px 12px;
		}

		.composer {
			padding: 6px 12px calc(10px + env(safe-area-inset-bottom));
		}

		.send {
			width: 44px;
			height: 44px;
		}

		.line.is-you .bubble {
			max-width: 88%;
		}
	}
</style>
