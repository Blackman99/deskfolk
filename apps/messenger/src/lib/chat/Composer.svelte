<script lang="ts">
	import { tick } from 'svelte';
	import { USER_MEMBER, type Bot, type Message, type SessionSummary } from '@real-bot/protocol';
	import { formatFileSize } from './attachments.ts';
	import { avatarSrc } from '../avatar.ts';
	import { botAvatarColor } from './chat-view.ts';
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
	import type { Copy } from '../copy.ts';
	import { presentBotIds } from '../panels/group-edit.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
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
	};

	let { runtime, t, selected, onSend, onPickPrompt }: Props = $props();

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
</script>

<svelte:window onclick={onWindowClick} />

		<footer class="composer">
{#if selected && !lockedComposer && runtime.composerSuggestions.length > 0}
	<div class="composer-suggest-bar" aria-label={t.chat.suggestNext}>
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
{#if !lockedComposer}
	<div class="composer-hint" id="composer-hint">
		<span class="send-shortcut-hint">{selected?.kind !== 'group' && (liveTurn || pendingHere.length > 0) ? t.composer.waitingHint : t.chat.sendHint}</span>
	</div>
{/if}
		</footer>
