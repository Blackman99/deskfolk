<script lang="ts">
	import { tick } from 'svelte';
	import { USER_MEMBER, type Bot, type Message, type SessionSummary } from '@real-bot/protocol';
	import { REMOTE_FILE_LIMIT } from '@real-bot/remote';
	import { formatFileSize } from './attachments.ts';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { composerAction, composerLocked, lockedReason } from './composer-mode.ts';
	import { insertComposerNewline } from './composer-editor.ts';
	import { keyboardInset } from './composer-inset.ts';
	import {
		COMPOSER_IME_IDLE,
		composerImeKeyAction,
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate,
		type ComposerImeState
	} from './composer-ime.ts';
	import type { Copy } from '../copy.ts';
	import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from '../sidebar/session-groups.ts';
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
	import { quotePreview, quotedBotName } from './quote-reply.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isLiveStatus } from './transcript.ts';
	import { isOutside } from '../click-outside.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		/** The stage owns scrolling, so sending goes back through it. */
		onSend: (files: File[]) => Promise<void>;
		/** A starter chip or a suggestion fills the draft; the mirror effect puts it in the editor. */
		onPickPrompt: (prompt: string) => void;
		/** The stage owns stick-to-bottom; this only draws the jump control on the card. */
		showScrollBottom?: boolean;
		onScrollToBottom?: () => void;
	};

	let {
		runtime,
		t,
		selected,
		onSend,
		onPickPrompt,
		showScrollBottom = false,
		onScrollToBottom
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const connected = $derived(runtime.connection === 'connected');
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);
	const liveTurnsHere = $derived(
		selected
			? snapshot.turns.filter((turn) => turn.session_id === selected.id && isLiveStatus(turn.status))
			: []
	);
	const liveTurn = $derived(
		liveTurnsHere.find((turn) => turn.id === runtime.focusedTurnId) ?? liveTurnsHere[0]
	);
	const pendingHere = $derived(
		selected ? snapshot.pendingJudgements.filter((j) => j.session_id === selected.id) : []
	);

	type MentionCandidate = {
		id: string;
		name: string;
		isEveryone: boolean;
		avatar?: string | null;
		duties?: string;
	};

	/** Focus from outside: a quote reply or a starter chip lands the caret here. */
	export function focus(): void {
		editorEl?.focus();
	}

	type PendingAttachment = {
		id: string;
		file: File;
		name: string;
		size: number;
		isImage: boolean;
		previewUrl: string | null;
	};

	let editorEl = $state<HTMLDivElement | null>(null);

	let composerIme = $state<ComposerImeState>(COMPOSER_IME_IDLE);

	let pendingAttachments = $state<PendingAttachment[]>([]);

	let fileInputEl = $state<HTMLInputElement | null>(null);

	let showMentionPopup = $state(false);

	let mentionQuery = $state('');

	let mentionAnchorIndex = $state(-1);

	let mentionHighlightIndex = $state(0);

	let mentionDismissed = $state(false);

	let mentionPopupEl = $state<HTMLDivElement | null>(null);

	const lockedComposer = $derived(composerLocked(selected, botsById));
	const lockedNotice = $derived.by(() => {
		const reason = lockedReason(selected, botsById);
		if (reason === 'archived') return t.chat.groupLockedNotice;
		if (reason === 'bot-bot') return t.chat.botBotLockedNotice;
		return t.chat.lockedNotice;
	});

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

	const quoteTarget = $derived(
		runtime.replyingToId
			? (snapshot.messages.find((m) => m.id === runtime.replyingToId) ?? null)
			: null
	);

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

	let attachLimitHit = $state(false);

	function addFiles(files: FileList | File[]): void {
		const next: PendingAttachment[] = [];
		attachLimitHit = false;
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) continue;
			if (runtime.remote && file.size > REMOTE_FILE_LIMIT) {
				attachLimitHit = true;
				continue;
			}
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
			void send();
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

	function quoteLabel(message: Message): string {
		if (message.author === USER_MEMBER) return t.chat.replyToYou;
		const name = quotedBotName(message, botsById);
		return name ? t.chat.replyTo(name) : t.chat.replyToDeleted;
	}

	function cancelQuoteReply(): void {
		runtime.replyingToId = null;
	}

	/** Only the mention popup closes on an outside click; Escape order is the shell's. */
	function onWindowClick(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (showMentionPopup && isOutside(target, editorEl, mentionPopupEl)) {
			showMentionPopup = false;
			mentionDismissed = false;
		}
	}

	/** A session change clears whatever was half-typed into the mention popup. */
	$effect(() => {
		void runtime.selectedId;
		showMentionPopup = false;
		mentionDismissed = false;
		mentionQuery = '';
		mentionAnchorIndex = -1;
	});

	$effect(() => {
		if (mentionHighlightIndex >= mentionCandidates.length && mentionCandidates.length > 0) {
			mentionHighlightIndex = mentionCandidates.length - 1;
		}
	});

	/** The draft belongs to the runtime; the contenteditable follows it, whoever set it. */
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

	async function send(): Promise<void> {
		if (editorEl) syncDraftFromEditor();
		if (primaryAction.kind !== 'send' || primaryAction.disabled) return;
		const files = pendingAttachments.map((a) => a.file);
		for (const a of pendingAttachments) {
			if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
		}
		pendingAttachments = [];
		await onSend(files);
		if (editorEl) editorEl.innerHTML = '';
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

<svelte:window onclick={onWindowClick} />

		<footer class="composer" bind:this={composerEl}>
{#if showMentionPopup && mentionCandidates.length > 0}
	<div
		bind:this={mentionPopupEl}
		class="mention-autocomplete-popup"
		role="listbox"
		tabindex="-1"
		onmousedown={(e) => e.preventDefault()}
	>
		<div class="autocomplete-header text-11 font-semibold uppercase text-muted pt-3 px-5 pb-2 tracking-[0.04em]">{t.chat.mentionTooltip}</div>
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
					<img src={avatarSrc(cand.avatar)} alt="" class="autocomplete-avatar-img w-13 h-13 rounded-[50%] object-cover shrink-0" />
				{:else if pal}
					<span class="autocomplete-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border}">
						{rosterLetter(cand.name)}
					</span>
				{/if}
				<div class="autocomplete-info flex flex-col min-w-0 flex-1">
					<span class="autocomplete-name text-13 font-semibold text-ink">@{cand.name}</span>
					{#if cand.duties}
						<span class="autocomplete-desc text-11 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{cand.duties}</span>
					{/if}
				</div>
			</button>
		{/each}
	</div>
{/if}

<div class="composer-dock">
{#if selected && !lockedComposer && runtime.composerSuggestions.length > 0}
	<div class="composer-frost-shell composer-suggest-bar" aria-label={t.chat.suggestNext}>
		{#each runtime.composerSuggestions as suggestion (suggestion.id)}
			<button
				type="button"
				class="suggest-chip"
				title={suggestion.prompt}
				onclick={() => onPickPrompt(suggestion.prompt)}
			>
				{suggestion.label}
			</button>
		{/each}
	</div>
{/if}

<div class="composer-card-wrap">
<div class="composer-frost-shell composer-card-shell">
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
	{#if attachLimitHit}
		<p class="composer-limit-error">{t.settings.fileLimitHit}</p>
	{/if}
	{#if quoteTarget}
		<div class="composer-quote-bar">
			<div class="composer-quote-meta min-w-0 flex-1 flex flex-col gap-1">
				<span class="composer-quote-who">{quoteLabel(quoteTarget)}</span>
				<span class="composer-quote-body text-12 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{quotePreview(quoteTarget.body)}</span>
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
		<div class="composer-locked-message flex items-center justify-center gap-4 py-1 px-0 text-muted text-13 font-medium">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
			<span>{lockedNotice}</span>
		</div>
	{/if}

	{#if pendingAttachments.length > 0}
		<div class="composer-attachments-bar">
			{#each pendingAttachments as att (att.id)}
				<div class="composer-attachment-item" class:is-img={att.isImage}>
					{#if att.isImage && att.previewUrl}
						<img src={att.previewUrl} alt={att.name} class="attachment-preview-img" data-copy-image />
					{:else}
						<div class="attachment-file-icon">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
						</div>
					{/if}
					<div class="attachment-meta flex flex-col min-w-0 flex-1">
						<span class="attachment-name text-12 font-medium text-ink overflow-hidden text-ellipsis whitespace-nowrap" title={att.name}>{att.name}</span>
						<span class="attachment-size mono text-10 text-muted">{formatFileSize(att.size)}</span>
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

	<div class="composer-row flex items-end gap-2 w-full">
		<button
			type="button"
			class="attach-btn"
			title={runtime.remote ? `${t.composer.attach} · ${t.composer.attachLimit}` : t.composer.attach}
			aria-label={runtime.remote ? `${t.composer.attach} · ${t.composer.attachLimit}` : t.composer.attach}
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
		<div class="composer-editor-wrap">
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
		{#if runtime.remote && !runtime.draft}
			<span class="composer-inline-limit">{t.composer.attachLimit}</span>
		{/if}
		</div>
		<button
			type="button"
			class="composer-action"
			class:send={primaryAction.kind === 'send'}
			class:stop={primaryAction.kind === 'stop'}
			disabled={primaryAction.disabled}
			aria-label={primaryAction.kind === 'stop' ? t.composer.stopGeneration : t.composer.send}
			title={primaryAction.kind === 'stop' ? t.composer.stopGeneration : t.chat.sendHintShortcut}
			onclick={() => primaryAction.kind === 'stop' ? void runtime.stopTurn() : void send()}
		>
			{#if primaryAction.kind === 'stop'}
				<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
			{:else}
				<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"></path></svg>
			{/if}
		</button>
	</div>
</div>
</div>
<div class="scroll-bottom-slot" class:is-shown={showScrollBottom} aria-hidden={showScrollBottom ? undefined : true}>
	<button
		type="button"
		class="scroll-bottom-btn"
		tabindex={showScrollBottom ? 0 : -1}
		title={t.chat.scrollToBottom}
		aria-label={t.chat.scrollToBottom}
		onclick={() => onScrollToBottom?.()}
	>
		<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
	</button>
</div>
</div>
{#if !lockedComposer}
	<div class="composer-hint" id="composer-hint">
		<span class="composer-frost-shell composer-hint-shell">
			<span class="send-shortcut-hint">{selected?.kind !== 'group' && (liveTurn || pendingHere.length > 0) ? t.composer.waitingHint : t.chat.sendHint}</span>
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
		z-index: 2;
		align-self: flex-start;
		width: max-content;
		max-width: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: nowrap;
		padding: 4px 8px 10px 4px;
		margin: 0 0 -8px;
		border-radius: 22px 22px 8px 8px;
		pointer-events: auto;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}

	.composer-suggest-bar::-webkit-scrollbar {
		display: none;
	}

	/* The floating jump control sits over the card's right shoulder. */
	.composer-dock:has(.scroll-bottom-slot.is-shown) .composer-suggest-bar {
		padding-right: 52px;
	}

	.composer-suggest-bar::before {
		inset: -8px -8px 4px -8px;
		border-radius: 22px 22px 8px 8px;
	}

	.suggest-chip {
		position: relative;
		z-index: 1;
		pointer-events: auto;
		flex: 0 0 auto;
		max-width: none;
		padding: 4px 10px;
		border-radius: 9999px;
		font-size: 12px;
		font-weight: 500;
		line-height: 1.3;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--ink);
		cursor: pointer;
		transition: all 0.12s ease;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.suggest-chip:hover {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	/* The jump control floats above the card's top-right and grows out of the card. */
	.composer-card-wrap {
		position: relative;
		width: 100%;
	}

	.scroll-bottom-slot {
		position: absolute;
		z-index: 4;
		/* 32px circle, 12px of air, then 32px buried in the card so the slide has somewhere to hide. */
		top: -44px;
		right: 8px;
		width: 32px;
		height: 76px;
		overflow: hidden;
		pointer-events: none;
	}

	.scroll-bottom-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 50%;
		background: var(--input-bg);
		box-shadow: var(--shadow-md);
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		pointer-events: none;
		transform: translateY(76px);
		transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease, background-color 0.15s ease;
	}

	.scroll-bottom-slot.is-shown {
		pointer-events: auto;
	}

	.scroll-bottom-slot.is-shown .scroll-bottom-btn {
		transform: translateY(0);
		pointer-events: auto;
	}

	.scroll-bottom-btn:hover {
		color: var(--accent);
		background: var(--line-subtle);
	}

	.scroll-bottom-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.composer-card-shell {
		position: relative;
		width: 100%;
		border-radius: 24px;
		z-index: 1;
	}

	.composer-card-shell::before {
		inset: -8px;
		border-radius: 32px;
	}

	.composer-card {
		position: relative;
		z-index: 1;
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

	.composer-card.is-locked {
		background: var(--sidebar-bg);
		border-style: dashed;
		border-radius: 18px;
		padding: 10px 14px;
	}

	.composer-card.is-locked .composer-row {
		display: none;
	}

	.composer-editor-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.composer .composer-input {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 34px;
		max-height: 180px;
		border: 0;
		outline: none;
		box-shadow: none;
		padding: 6px 6px 6px 4px;
		background: transparent;
		color: var(--ink);
		font-size: 14px;
		line-height: 22px;
		overflow-y: auto;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		scrollbar-width: thin;
	}

	.composer .composer-input.is-empty::before {
		content: attr(data-placeholder);
		color: var(--muted);
		pointer-events: none;
		position: absolute;
		top: 6px;
		left: 4px;
		right: 6px;
		line-height: 22px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.composer .composer-input:focus-visible {
		outline: none !important;
	}

	.composer .composer-input[contenteditable="false"] {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.composer-inline-limit {
		display: block;
		margin: -3px 4px 4px;
		font-size: 10.5px;
		line-height: 1.25;
		color: var(--muted);
		pointer-events: none;
	}

	.composer-limit-error {
		margin: 2px 8px 0;
		font-size: 11px;
		line-height: 1.3;
		color: var(--danger);
	}

	.attach-btn {
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

	.attach-btn:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.attach-btn:active:not(:disabled) {
		transform: scale(0.96);
	}

	.attach-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.composer-action {
		width: 34px;
		height: 34px;
		flex: 0 0 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 50%;
		margin-bottom: 0;
		transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
	}

	.composer-action:active:not(:disabled) {
		transform: scale(0.96);
	}

	.composer-action.send {
		background: var(--accent);
		color: #ffffff;
	}

	.composer-action.send:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.composer-action.stop {
		background: var(--ink);
		color: var(--pane);
	}

	.composer-action.stop:hover:not(:disabled) {
		background: var(--ink-secondary);
	}

	.composer-action:disabled {
		background: var(--chip);
		color: var(--muted);
		cursor: not-allowed;
	}

	.composer-action:focus-visible,
	.composer .attach-btn:focus-visible {
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
		border-radius: 9999px;
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









	/* Mention Autocomplete Popup */
	.mention-autocomplete-popup {
		position: absolute;
		bottom: calc(100% - 6px);
		left: max(24px, calc(50% - (var(--chat-max-width) / 2)));
		width: min(380px, calc(100% - 48px));
		max-height: 240px;
		overflow-y: auto;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 1px 3px rgba(15, 23, 42, 0.08);
		padding: 6px;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 2px;
		pointer-events: auto;
	}

	.autocomplete-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		border: none;
		background: transparent;
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.autocomplete-item:hover,
	.autocomplete-item.is-highlighted {
		background: var(--accent-tint);
	}

	.autocomplete-avatar {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		flex-shrink: 0;
		border: 1px solid var(--line);
	}

	.autocomplete-avatar.is-everyone {
		background: var(--chip);
		font-size: 14px;
	}

	/* Inline Mention Chip inside Composer Input */
	/*
	 * The chips are built by `mention-chips.ts` and dropped into the contenteditable,
 so they
	 * never carry a scope class — `:global` is the only thing that reaches them. Anchoring on
	 * `.composer-input` keeps them the composer's business rather than the whole app's.
	 */
	.composer-input :global(.inline-mention-chip) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 6px 1px 3px;
		margin: 0 2px;
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		border-radius: 999px;
		font-size: 12.5px;
		color: var(--accent-hover);
		font-weight: 600;
		line-height: 1.2;
		vertical-align: middle;
		user-select: none;
		cursor: default;
		animation: chipIn 0.12s ease;
	}

	.composer-input :global(.inline-mention-chip .chip-avatar-icon) {
		font-size: 12px;
		line-height: 1;
	}

	.composer-input :global(.inline-mention-chip .chip-avatar-img) {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		object-fit: cover;
		display: block;
	}

	.composer-input :global(.inline-mention-chip .chip-avatar-letter) {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 9.5px;
		font-weight: 700;
		border: 1px solid transparent;
	}

	.composer-input :global(.inline-mention-chip .chip-name) {
		line-height: 1;
		white-space: nowrap;
	}

	.composer-input :global(.inline-mention-chip .chip-close-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: none;
		background: rgba(37, 99, 235, 0.12);
		color: var(--accent);
		cursor: pointer;
		padding: 0;
		margin-left: 2px;
		transition: all 0.1s ease;
	}

	.composer-input :global(.inline-mention-chip .chip-close-btn:hover) {
		background: rgba(37, 99, 235, 0.25);
		color: var(--accent-hover);
	}

	.composer-input :global(.chip-close-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: none;
		background: rgba(37, 99, 235, 0.12);
		color: var(--accent);
		cursor: pointer;
		padding: 0;
		transition: all 0.12s ease;
	}

	.composer-input :global(.chip-close-btn:hover) {
		background: var(--accent);
		color: #ffffff;
	}

	/* Pending Attachments in Composer */
	.composer-attachments-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--line-subtle);
		margin-bottom: 4px;
	}

	.composer-attachment-item {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 4px 8px 4px 6px;
		max-width: 220px;
	}

	.composer-attachment-item.is-img {
		padding: 4px 8px 4px 4px;
	}

	.attachment-preview-img {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		object-fit: cover;
		border: 1px solid var(--line);
		flex-shrink: 0;
	}

	.attachment-file-icon {
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		background: var(--pane);
		border: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		flex-shrink: 0;
	}

	.attachment-delete-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: none;
		background: rgba(15, 23, 42, 0.08);
		color: var(--muted);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		transition: all 0.12s ease;
	}

	.attachment-delete-btn:hover {
		background: var(--danger);
		color: #ffffff;
	}

	@keyframes chipIn {
		from { opacity: 0; transform: scale(0.92); }
		to { opacity: 1; transform: scale(1); }
	}

	.composer-input :global(.chip-avatar-icon) {
		font-size: 13px;
		line-height: 1;
	}

	.composer-input :global(.chip-avatar-img) {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		object-fit: cover;
	}

	.composer-input :global(.chip-avatar-letter) {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: 700;
		border: 1px solid transparent;
	}

	.composer-input :global(.chip-name) {
		line-height: 1;
	}

	.composer-quote-bar {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 8px 10px 8px 12px;
		margin: 0 0 4px;
		border-bottom: 1px solid var(--line-subtle);
		border-left: 2px solid var(--accent);
	}

	.composer-quote-who {
		font-size: 12px;
		font-weight: 650;
		color: var(--accent);
	}

	.composer-quote-cancel {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.composer-quote-cancel:hover {
		background: var(--line-subtle);
		color: var(--text);
	}

	@media (max-width: 680px) {
		.composer {
			bottom: var(--keyboard-inset, 0px);
			padding: 8px 10px max(12px, env(safe-area-inset-bottom));
			gap: 4px;
		}

		.composer-suggest-bar {
			align-self: stretch;
			width: 100%;
			padding: 2px 2px 8px;
			margin: 0 0 -6px;
			flex-wrap: nowrap;
		}

		.composer-suggest-bar::before {
			inset: -6px -6px 2px;
		}

		.suggest-chip {
			min-height: 30px;
			max-width: 85%;
			padding: 4px 9px;
			font-size: 11.5px;
		}

		.composer-card-shell::before {
			inset: -6px;
			border-radius: 28px;
		}
	}
	@media (max-width: 680px) {
	.composer-card {
	padding: 4px 5px 4px 6px;
	border-radius: 22px;
	max-width: 100%;
	}
	}
	@media (max-width: 680px) {
	.composer .composer-input {
	font-size: 15px;
	max-height: min(120px, 25dvh);
	padding: 6px 4px;
	}

	.composer-inline-limit {
		margin: -2px 4px 3px;
		font-size: 10px;
	}
	}
	@media (max-width: 680px) {
	.composer .composer-input.is-empty::before {
	left: 4px;
	right: 4px;
	top: 6px;
	}
	}
	@media (max-width: 680px) {
	.composer .composer-action,
	.composer .attach-btn {
	width: 34px;
	height: 34px;
	flex-basis: 34px;
	}
	}
	@media (max-width: 680px) {
	.composer-hint {
	display: none;
	}
	}
	@media (max-width: 680px) {
	.mention-autocomplete-popup {
	left: 10px;
	width: calc(100% - 20px);
	}
	}
	@media (prefers-reduced-motion: reduce) {
	.composer-card,
	.composer-action,
	.composer .attach-btn,
	.scroll-bottom-btn {
	transition: none;
	}
	}
</style>
