<script lang="ts">
	import { tick } from 'svelte';
	import type { SessionSummary } from '@real-bot/protocol';
	import { composerAction, composerLocked, lockedReason } from './composer-mode.ts';
	import { keyboardInset } from './composer-inset.ts';
	import {
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate,
		COMPOSER_IME_IDLE,
		type ComposerImeState
	} from './composer-ime.ts';
	import type { Copy } from '../copy.ts';
	import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from '../sidebar/session-groups.ts';
	import {
		deleteChipElement,
		serializeEditorText,
		setEditorContentFromText
	} from './mention-chips.ts';
	import { shouldIgnoreKeyUp } from './mention-popup.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isLiveStatus } from './transcript.ts';
	import { workspaceDropTarget } from '../workspace-drag.svelte.ts';
	import { ComposerAttachments } from './composer-attachments.svelte.ts';
	import { handleComposerKey, type ComposerKeyContext } from './composer-keys.ts';
	import { ComposerMentions } from './composer-mentions.svelte.ts';
	import ComposerAttachmentsBar from './ComposerAttachments.svelte';
	import ComposerEditor from './ComposerEditor.svelte';
	import ComposerQuote from './ComposerQuote.svelte';
	import ComposerSuggestions from './ComposerSuggestions.svelte';
	import ScrollBottomButton from './ScrollBottomButton.svelte';
	import MentionPopup from './MentionPopup.svelte';
	import SendButton from './SendButton.svelte';
	import StopMenu from './StopMenu.svelte';
	import { conversationStopItems, type StopMenuItem } from './stop-menu.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		/** The stage owns scrolling, so sending goes back through it. */
		onSend: (files: File[], paths: string[]) => Promise<boolean>;
		/** A starter chip or a suggestion fills the draft; the mirror effect puts it in the editor. */
		onPickPrompt: (prompt: string) => void;
		/** The stage owns stick-to-bottom; this only draws the jump control on the card. */
		showScrollBottom?: boolean;
		onScrollToBottom?: () => void;
		/** ↑ in an empty box: open your newest line here for changing (ADR 0063). True when one opened. */
		onEditLast?: () => boolean;
		};

	let {
		runtime,
		t,
		selected,
		onSend,
		onPickPrompt,
		showScrollBottom = false,
		onScrollToBottom,
		onEditLast
		}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	/**
	 * This conversation's own draft, reply, chips and staged files. Never the runtime's forwards:
	 * those follow whichever pane has the keyboard, so two composers on screen read one draft.
	 */
	const view = $derived(selected ? runtime.sessionView(selected.id) : null);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const connected = $derived(runtime.connection === 'connected');
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	/** Remote files land here, and notes to yourself. No Bot reads either. */
	const fileDrop = $derived(selected ? isFileDropSession(selected) : false);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);
	const liveTurnsHere = $derived(
		selected
			? snapshot.turns.filter((turn) => turn.session_id === selected.id && isLiveStatus(turn.status))
			: []
	);
	const liveTurn = $derived(
		liveTurnsHere.find((turn) => turn.id === view?.focusedTurnId) ?? liveTurnsHere[0]
	);
	const pendingHere = $derived(
		selected ? snapshot.pendingJudgements.filter((j) => j.session_id === selected.id) : []
	);

	/** Focus from outside: a quote reply or a starter chip lands the caret here. */
	export function focus(): void {
		editorEl?.focus();
	}

	let editorEl = $state<HTMLDivElement | null>(null);

	let composerIme = $state<ComposerImeState>(COMPOSER_IME_IDLE);

	const lockedComposer = $derived(composerLocked(selected, botsById));

	const mentions = new ComposerMentions({
		selected: () => selected,
		editorEl: () => editorEl,
		fileDrop: () => fileDrop,
		botsById: () => botsById,
		visibleBots: () => visibleBots,
		groupPresent: () => groupPresent,
		t: () => t,
		syncDraftFromEditor: () => syncDraftFromEditor()
	});
	const attachments = new ComposerAttachments({
		runtime: () => runtime,
		selected: () => selected,
		view: () => view,
		lockedComposer: () => lockedComposer,
		connected: () => connected,
		fileDrop: () => fileDrop,
		editorEl: () => editorEl
	});

	/**
	 * A group's stop menu: the group, each Bot at work in it, this job, every Bot (ADR 0040 P2).
	 * Only once the daemon has stops, and only while someone in it is at work; Send stays the main
	 * button there. A direct has no menu — see `directStop`.
	 */
	const stopItems = $derived(
		selected?.kind === 'group' && snapshot.holdsOn && !lockedComposer
			? conversationStopItems({ session: selected, turns: snapshot.turns, bots: botsById, holds: snapshot.holds, t: t.control, deleted: t.top.deleted, sessions: snapshot.sessions })
			: []
	);

	/** A refusal comes back for the menu to say. */
	function pickStop(item: StopMenuItem): Promise<unknown> | void {
		if (!selected) return;
		return runtime.stopScope(item.choice.scope, item.choice.id, selected.id, { liftOnNext: item.choice.liftOnNext });
	}

	const lockedNotice = $derived.by(() => {
		const reason = lockedReason(selected, botsById);
		if (reason === 'archived') return t.chat.groupLockedNotice;
		if (reason === 'bot-bot') return t.chat.botBotLockedNotice;
		return t.chat.lockedNotice;
	});

	/* What to type here, never the button's own word: an empty box that said 「发送」 read as a label. */
	const placeholder = $derived(
		fileDrop
			? t.sidebar.fileDropPlaceholder
			: selectedKind === 'you-bot' && selectedPeerBot
				? `${t.chat.replyPrompt} ${selectedPeerBot.name}...`
				: selectedKind === 'group'
					? t.composer.groupPrompt
					: t.composer.messagePrompt
	);

	/**
	 * The line under the box. In a direct whose Bot is at work, or still reading your last line, what
	 * you send reaches it at its next step; only where Send really waits — an older daemon — does it
	 * say to wait for the reply.
	 */
	const composerHint = $derived.by(() => {
		if (selected?.kind === 'group' || !(liveTurn || pendingHere.length > 0)) return t.chat.sendHint;
		const waits = (Boolean(liveTurn) && !snapshot.turnInbox) || (pendingHere.length > 0 && !snapshot.linesInOrder);
		return waits ? t.composer.waitingHint : t.composer.workingHint;
	});

	/** Something to send: text, or files staged without any. */
	const hasContent = $derived(
		Boolean(view?.draft.trim()) || attachments.pendingAttachments.length > 0 || attachments.pendingPaths.length > 0
	);

	const primaryAction = $derived(composerAction({
		connected,
		hasSession: Boolean(selected),
		locked: lockedComposer,
		hasLiveTurn: Boolean(liveTurn),
		pendingJudgement: pendingHere.length > 0,
		busy: view?.sending ?? false,
		hasContent,
		sessionKind: fileDrop ? 'file-drop' : (selected?.kind ?? null),
		turnInbox: snapshot.turnInbox,
		linesInOrder: snapshot.linesInOrder,
		}));

	/**
	 * A direct's one Stop: beside Send while its Bot has a turn going here, because the box stays open
	 * for your next line (otherwise Stop is the main button already). It stops that turn, and your next
	 * line to the Bot is what it goes on from.
	 */
	const directStop = $derived(
		selectedKind === 'you-bot' && !lockedComposer && Boolean(liveTurn) && primaryAction.kind === 'send'
	);

	/** A staged file's own share: the files go out one after the other, in the order they were sent. */
	function uploadedPercent(file: File): number | null {
		const upload = view?.upload;
		const at = upload ? upload.files.indexOf(file) : -1;
		if (!upload || at < 0 || file.size === 0) return null;
		const before = upload.files.slice(0, at).reduce((n, row) => n + row.size, 0);
		return Math.floor(Math.max(0, Math.min(1, (upload.loaded - before) / file.size)) * 100);
	}

	/** Somewhere to send what ✨ drafts: not a locked composer, and no Bot reads the file conversation. */
	const canSuggest = $derived(Boolean(selected) && !lockedComposer && !fileDrop);
	const suggestionsShown = $derived(
		(view?.composerSuggestions.length ?? 0) > 0 || Boolean(view?.suggestionsEmpty)
	);
	/** Drafted while a reply is still coming, they would be about the past the moment it landed. */
	const suggestWaiting = $derived(Boolean(liveTurn) || pendingHere.length > 0);
	const suggestTitle = $derived(
		view?.suggestionsLoading
			? t.composer.suggestStop
			: suggestionsShown
				? t.composer.suggestHide
				: suggestWaiting
					? t.composer.suggestWait
					: t.composer.suggest
	);

	/** One press drafts once; pressing again while drafts are out or on the way puts them away. */
	function toggleSuggestions(): void {
		if (!selected || !view) return;
		if (view.suggestionsLoading || suggestionsShown) {
			runtime.dismissComposerSuggestions(selected.id);
			return;
		}
		void runtime.suggestComposer(selected.id);
	}

	/** "Nothing to suggest" answers the press; it is not worth keeping on screen. */
	$effect(() => {
		const current = view;
		if (!current?.suggestionsEmpty) return;
		const timer = setTimeout(() => {
			current.suggestionsEmpty = false;
		}, 4000);
		return () => clearTimeout(timer);
	});

	const quoteTarget = $derived(
		view?.replyingToId
			? (snapshot.messages.find((m) => m.id === view.replyingToId) ?? null)
			: null
	);

	function syncDraftFromEditor(): void {
		if (!editorEl) return;
		if (view) view.draft = serializeEditorText(editorEl);
	}

	function onEditorInput(): void {
		syncDraftFromEditor();
		mentions.checkMentionTrigger();
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
					mentions.checkMentionTrigger();
					editorEl?.focus();
				}
				return;
			}
		}
		mentions.checkMentionTrigger();
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
				attachments.addFiles(files);
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
		mentions.checkMentionTrigger();
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

	const keyContext: ComposerKeyContext = {
		composerIme: () => composerIme,
		setComposerIme: (next) => {
			composerIme = next;
		},
		lockedComposer: () => lockedComposer,
		selected: () => selected,
		mentions,
		onEditLast: () => onEditLast,
		hasContent: () => hasContent,
		view: () => view,
		editorEl: () => editorEl,
		syncDraftFromEditor: () => syncDraftFromEditor(),
		checkMentionTrigger: () => mentions.checkMentionTrigger(),
		send: () => send()
	};

	function onComposerKey(ev: KeyboardEvent): void {
		handleComposerKey(ev, keyContext);
	}

	function onComposerKeyUp(ev: KeyboardEvent): void {
		if (shouldIgnoreKeyUp(ev.key)) {
			return;
		}
		syncDraftFromEditor();
		mentions.checkMentionTrigger();
	}

	function cancelQuoteReply(): void {
		if (view) view.replyingToId = null;
	}

	/** The draft belongs to the conversation; the contenteditable follows it, whoever set it. */
	$effect(() => {
		const targetDraft = view?.draft ?? '';
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

	/**
	 * What was staged stays staged until the Mac has it. Clearing it up front meant a send that
	 * failed — a phone's link dropping mid-upload — took the files and the words with it, and they
	 * had to be picked and typed again.
	 */
	async function send(): Promise<void> {
		if (editorEl) syncDraftFromEditor();
		if (primaryAction.kind !== 'send' || primaryAction.disabled || !view) return;
		const target = view;
		const staged = [...attachments.pendingAttachments];
		const stagedPaths = [...attachments.pendingPaths];
		if (!(await onSend(staged.map((a) => a.file), stagedPaths.map((row) => row.path)))) return;
		for (const a of [...staged, ...stagedPaths]) {
			if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
		}
		const sent = new Set([...staged, ...stagedPaths].map((a) => a.id));
		target.stagedAttachments = target.stagedAttachments.filter((a) => !sent.has(a.id));
		target.stagedPaths = target.stagedPaths.filter((row) => !sent.has(row.id));
		if (editorEl && view === target) editorEl.innerHTML = '';
	}
	let composerEl = $state<HTMLElement | null>(null);

	/**
	 * The stream reserves room for this bar, so it has to know how tall it actually is: chips, a
	 * suggestion row, a wrapped placeholder and the home-indicator inset all change that, and a
	 * constant guess hid the last messages behind it. The keyboard inset rides along because on
	 * iOS the layout viewport does not shrink when the keyboard opens.
	 */
	$effect(() => {
		const el = composerEl;
		const stage = el?.parentElement;
		if (!el || !stage || typeof ResizeObserver === 'undefined') return;
		const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
		const apply = () => {
			stage.style.setProperty('--composer-height', `${Math.ceil(el.getBoundingClientRect().height)}px`);
			stage.style.setProperty('--keyboard-inset', `${keyboardInset(window.innerHeight, viewport)}px`);
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(el);
		viewport?.addEventListener('resize', apply);
		viewport?.addEventListener('scroll', apply);
		return () => {
			observer.disconnect();
			viewport?.removeEventListener('resize', apply);
			viewport?.removeEventListener('scroll', apply);
			stage.style.removeProperty('--composer-height');
			stage.style.removeProperty('--keyboard-inset');
		};
	});
</script>

<svelte:window onclick={mentions.onWindowClick} />

		<footer class="composer" bind:this={composerEl} ondragover={attachments.onFileDragOver} ondrop={attachments.onFileDrop}>
{#if mentions.showMentionPopup && mentions.mentionCandidates.length > 0}
	<MentionPopup {mentions} {t} />
{/if}

<div class="composer-dock">
{#if canSuggest && view && suggestionsShown}
	<div class="composer-frost-shell composer-suggest-bar" role="group" aria-label={t.chat.suggestNext}>
		<ComposerSuggestions suggestions={view.composerSuggestions} {t} {onPickPrompt} />
	</div>
{/if}

<div class="composer-card-wrap">
<div class="composer-frost-shell composer-card-shell">
<div
	bind:this={attachments.cardEl}
	class="composer-card"
	class:is-locked={lockedComposer}
	class:is-drop-ready={attachments.dropReady}
	class:is-drop-over={attachments.dropOver}
	role="presentation"
	use:workspaceDropTarget={{ accepts: attachments.takesWorkspaceItems, drop: attachments.stageWorkspaceItems }}
	onclick={(e) => {
		const target = e.target as HTMLElement | null;
		if (selected && !lockedComposer && target && !target.closest('button, input, [contenteditable="true"]')) {
			editorEl?.focus();
		}
	}}
>
	{#if quoteTarget}
		<ComposerQuote message={quoteTarget} {t} {botsById} onCancel={cancelQuoteReply} />
	{/if}
	{#if lockedComposer}
		<div class="composer-locked-message flex items-center justify-center gap-4 py-1 px-0 text-muted text-13 font-medium">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
			<span>{lockedNotice}</span>
		</div>
	{/if}

	{#if attachments.dropOver}
		<div class="composer-drop-hint" aria-hidden="true">{t.composer.dropWorkspaceItems}</div>
	{/if}

	{#if attachments.pendingAttachments.length > 0 || attachments.pendingPaths.length > 0}
		<ComposerAttachmentsBar
			{t}
			pendingAttachments={attachments.pendingAttachments}
			pendingPaths={attachments.pendingPaths}
			sending={view?.sending}
			{uploadedPercent}
			onRemoveAttachment={attachments.removePendingAttachment}
			onRemovePath={attachments.removePendingPath}
		/>
	{/if}

	<div
		class="composer-row flex items-end gap-2 w-full"
		class:is-file-drop={fileDrop}
		ondragover={attachments.onFileDragOver}
		ondrop={attachments.onFileDrop}
	>
		<button
			type="button"
			class="attach-btn"
			title={t.composer.attach}
			aria-label={t.composer.attach}
			disabled={!connected || !selected || lockedComposer || view?.sending}
			onclick={attachments.openFilePicker}
		>
			<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
			</svg>
		</button>
		<input
			type="file"
			multiple
			bind:this={attachments.fileInputEl}
			onchange={attachments.onFileInputChange}
			style="display: none;"
		/>
		<ComposerEditor
			bind:el={editorEl}
			{placeholder}
			empty={!view?.draft}
			{lockedComposer}
			editable={Boolean(selected) && !lockedComposer}
			{fileDrop}
			onInput={onEditorInput}
			onKey={onComposerKey}
			onKeyUp={onComposerKeyUp}
			onCompositionStart={onComposerCompositionStart}
			onCompositionUpdate={onComposerCompositionUpdate}
			onCompositionEnd={onComposerCompositionEnd}
			onClick={onEditorClick}
			onPaste={onComposerPaste}
		/>
		<!-- Beside send rather than the attachment button, so a thumb has one of them on each side. -->
		{#if canSuggest}
			<button
				type="button"
				class="suggest-btn"
				class:is-active={suggestionsShown}
				class:steps-aside={hasContent}
				title={suggestTitle}
				aria-label={suggestTitle}
				aria-pressed={suggestionsShown}
				aria-busy={view?.suggestionsLoading ? true : undefined}
				disabled={!view?.suggestionsLoading && !suggestionsShown && (!connected || suggestWaiting || view?.sending)}
				onclick={toggleSuggestions}
			>
				{#if view?.suggestionsLoading}
					<svg class="suggest-spinner" aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"></path></svg>
				{:else}
					<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path></svg>
				{/if}
			</button>
		{/if}
		{#if stopItems.length > 0}
			<StopMenu items={stopItems} {t} disabled={!connected} onPick={pickStop} />
		{/if}
		<SendButton
			{t}
			{connected}
			{primaryAction}
			{directStop}
			sending={view?.sending}
			upload={view?.upload}
			onStop={() => void runtime.stopTurn(selected?.id)}
			onSend={() => void send()}
		/>
	</div>
</div>
</div>
<ScrollBottomButton shown={showScrollBottom} {t} {onScrollToBottom} />
</div>
{#if !lockedComposer}
	<div class="composer-hint" id="composer-hint">
		<span class="composer-frost-shell composer-hint-shell">
			<span class="send-shortcut-hint">{composerHint}</span>
		</span>
	</div>
{/if}
</div>
		</footer>

<style>
	/* Composer, mention popup and chips, attachments in the bar and in bubbles. */
	/* Composer Area */
	.composer {
		position: absolute;
		left: 0;
		right: 0;
		bottom: var(--keyboard-inset, 0px);
		background: transparent;
		padding: 10px 24px 12px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		min-width: 0;
		pointer-events: none;
		z-index: 4;
	}

	/* Pipe-stem dock: chips sit on the left shoulder of the input card. */
	.composer-dock {
		position: relative;
		width: 100%;
		max-width: var(--chat-max-width);
		display: flex;
		flex-direction: column;
		align-items: stretch;
		min-width: 0;
	}

	.composer-frost-shell {
		position: relative;
		pointer-events: none;
	}

	/* Frosted ring hugging chips / card / hint — not a full-width bottom bar.
	   On the shell so backdrop-filter can see the transcript. */
	.composer-frost-shell::before {
		content: "";
		position: absolute;
		inset: -8px;
		border-radius: inherit;
		pointer-events: none;
		background: color-mix(in srgb, var(--glass-composer) 50%, transparent);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
	}

	.composer-suggest-bar {
		position: relative;
		/* Above the card, so the chips keep sitting on its left shoulder. */
		z-index: 3;
		align-self: flex-start;
		width: max-content;
		max-width: 100%;
		display: flex;
		min-width: 0;
		margin: 0 0 -8px;
		border-radius: 22px 22px var(--radius-md) var(--radius-md);
		pointer-events: auto;
	}

	/* Stop the chip row before the jump button. Padding inside a full-width bar would still cover it. */
	.composer-dock:has(:global(.scroll-bottom-slot.is-shown)) .composer-suggest-bar {
		max-width: calc(100% - 52px);
	}

	.composer-suggest-bar::before {
		inset: -8px -8px 4px -8px;
		border-radius: 22px 22px var(--radius-md) var(--radius-md);
	}
	/* The jump control floats above the card's top-right and grows out of the card. */
	.composer-card-wrap {
		position: relative;
		width: 100%;
	}

	.composer-card-shell {
		position: relative;
		width: 100%;
		border-radius: 24px;
		/* No z-index here. A stacking context would trap the card with its frost, and the card could no longer cover the button. */
	}

	.composer-card-shell::before {
		inset: -8px;
		border-radius: 32px;
	}

	.composer-card {
		position: relative;
		/* Covers the jump button. The suggestion row is higher still, and stops short of the button. */
		z-index: 2;
		width: 100%;
		background: var(--input-bg);
		border: 1px solid var(--line);
		border-radius: 24px;
		box-shadow: var(--shadow-md);
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		padding: 5px 6px 5px 8px;
		box-sizing: border-box;
		pointer-events: auto;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.composer-card:hover:not(:focus-within):not(.is-locked) {
		border-color: var(--line-hover);
	}

	.composer-card:focus-within {
		border-color: var(--accent-border);
		box-shadow: 0 0 0 3px var(--accent-glow), var(--shadow-md);
	}

	/* A drag out of the file tree is on its way: the card says it would take it, and more so under the pointer. */
	.composer-card.is-drop-ready {
		border-color: var(--accent-border);
		border-style: dashed;
	}

	.composer-card.is-drop-over {
		border-style: solid;
		box-shadow: 0 0 0 3px var(--accent-glow), var(--shadow-md);
	}

	.composer-drop-hint {
		position: absolute;
		inset: 0;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: inherit;
		background: color-mix(in srgb, var(--input-bg) 82%, transparent);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		pointer-events: none;
	}

	.composer-card.is-locked {
		background: var(--sidebar-bg);
		border-style: dashed;
		border-radius: 18px;
		padding: 10px 14px;
	}

	.composer-card.is-locked .composer-row {
		display: none;
	}

	.attach-btn,
	.suggest-btn {
		background: transparent;
		border: none;
		color: var(--muted);
		width: 34px;
		height: 34px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: 0 0 34px;
		margin-bottom: 0;
		padding: 0;
		transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
	}

	.attach-btn:hover:not(:disabled),
	.suggest-btn:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.attach-btn:active:not(:disabled),
	.suggest-btn:active:not(:disabled) {
		transform: scale(0.96);
	}

	.attach-btn:disabled,
	.suggest-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Out, or on the way: the same press puts them away. */
	.suggest-btn.is-active,
	.suggest-btn[aria-busy="true"],
	.suggest-btn.is-active:hover:not(:disabled) {
		color: var(--accent);
	}

	.suggest-btn.is-active,
	.suggest-btn.is-active:hover:not(:disabled) {
		background: var(--accent-tint);
	}

	.suggest-spinner {
		animation: suggestSpin 0.9s linear infinite;
	}

	@keyframes suggestSpin {
		to {
			transform: rotate(360deg);
		}
	}

	.composer .attach-btn:focus-visible,
	.composer .suggest-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.composer-hint {
		width: 100%;
		max-width: var(--chat-max-width);
		min-height: 14px;
		margin-top: 8px;
		text-align: center;
		line-height: 14px;
		pointer-events: none;
	}

	.composer-hint-shell {
		display: inline-flex;
		border-radius: var(--radius-full);
	}

	.composer-hint-shell::before {
		inset: -4px -10px;
	}

	.send-shortcut-hint {
		position: relative;
		z-index: 1;
		font-size: 11px;
		color: var(--muted);
		opacity: 0.92;
	}

	/*
	 * A conversation as narrow as a phone — a phone, a small window, a workbench pane — docks the
	 * composer: a bar across the bottom that the transcript ends above, rather than a card floating
	 * over it. Floating cost a margin on every side of a column that has none to spare, and the
	 * transcript showed through the gaps around the card and the chips. The bar is in the stage's
	 * flow, so the stream shrinks to fit it; the stage's resize follow keeps it stuck to the bottom.
	 * The keyboard inset and the safe area are zero outside a phone. With the keyboard up the home
	 * indicator is under it, so the bar does not keep its inset above the keys.
	 */
	@container conversation (max-width: 680px) {
		.composer {
			position: relative;
			bottom: auto;
			flex: none;
			margin-bottom: var(--keyboard-inset, 0px);
			padding: 0 0 max(0px, calc(env(safe-area-inset-bottom, 0px) - var(--keyboard-inset, 0px)));
			gap: 0;
			background: var(--input-bg);
			border-top: 1px solid var(--line);
			pointer-events: auto;
			transition: border-color 0.15s ease;
		}

		.composer:focus-within {
			border-top-color: var(--accent-border);
		}

		.composer-dock {
			max-width: none;
		}

		/* Nothing floats, so there is nothing for the frost to lift off the transcript. */
		.composer-frost-shell::before {
			display: none;
		}

		.composer-suggest-bar {
			align-self: stretch;
			width: auto;
			max-width: none;
			margin: 0;
			border-radius: 0;
		}

		.composer-card-shell,
		.composer-card,
		.composer-card.is-locked {
			border-radius: 0;
		}

		.composer-card {
			border: 0;
			box-shadow: none;
			padding: 6px 8px;
			max-width: 100%;
		}

		.composer-card:focus-within {
			box-shadow: none;
		}

		.composer-card.is-locked {
			padding: 12px 14px;
		}

		.composer .attach-btn,
		.composer .suggest-btn {
			width: 34px;
			height: 34px;
			flex-basis: 34px;
		}

		.composer-hint {
			display: none;
		}

		/*
		 * With an empty input ✨ sits in room the placeholder does not use; once there is something
		 * to send it gives that room to the text, and send is never next to a button you meant.
		 */
		.suggest-btn.steps-aside {
			display: none;
		}

		/*
		 * A thumb, on a screen whose edges may curve away: a quad-curved phone reports no safe area
		 * for its curves, so the bar keeps its own margin from all three edges, and the buttons are
		 * big enough to hit with ✨ held apart from send.
		 */
		@media (pointer: coarse) {
			.composer-card {
				padding: 6px max(16px, env(safe-area-inset-right, 0px)) 12px max(16px, env(safe-area-inset-left, 0px));
			}

			.composer .attach-btn,
			.composer .suggest-btn {
				width: 40px;
				height: 40px;
				flex-basis: 40px;
			}

			.composer .suggest-btn {
				margin-right: 4px;
			}
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.composer,
		.composer-card,
		.composer .attach-btn,
		.composer .suggest-btn {
			transition: none;
		}

		.suggest-spinner {
			animation: none;
		}
	}
</style>

