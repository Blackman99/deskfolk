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
	import type { StagedAttachment } from '../session-view.svelte.ts';
	import { isLiveStatus } from './transcript.ts';
	import { isOutside } from '../click-outside.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		/** The stage owns scrolling, so sending goes back through it. */
		onSend: (files: File[]) => Promise<boolean>;
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

	let editorEl = $state<HTMLDivElement | null>(null);

	let composerIme = $state<ComposerImeState>(COMPOSER_IME_IDLE);

	/** Staged on the conversation, so they wait there when you look at another one. */
	const pendingAttachments = $derived(view?.stagedAttachments ?? []);
	function stageAttachments(next: StagedAttachment[]): void {
		if (view) view.stagedAttachments = next;
	}

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

	const placeholder = $derived(
		fileDrop
			? t.sidebar.fileDropPlaceholder
			: selectedKind === 'you-bot' && selectedPeerBot
				? `${t.chat.replyPrompt} ${selectedPeerBot.name}...`
				: t.composer.send
	);

	/** Something to send: text, or files staged without any. */
	const hasContent = $derived(Boolean(view?.draft.trim()) || pendingAttachments.length > 0);

	const primaryAction = $derived(composerAction({
		connected,
		hasSession: Boolean(selected),
		locked: lockedComposer,
		hasLiveTurn: Boolean(liveTurn),
		pendingJudgement: pendingHere.length > 0,
		busy: view?.sending ?? false,
		hasContent,
		sessionKind: fileDrop ? 'file-drop' : (selected?.kind ?? null),
	}));

	/**
	 * A send the Mac next door answers at once shows nothing. One still on its way after this long —
	 * over the relay, behind a picture already downloading, a file uploading — says so on the
	 * button, where a greyed-out one looked exactly like a composer with nothing to send.
	 */
	const SENDING_SHOW_MS = 250;
	let sendingShown = $state(false);
	$effect(() => {
		if (!view?.sending) {
			sendingShown = false;
			return;
		}
		const timer = setTimeout(() => {
			sendingShown = true;
		}, SENDING_SHOW_MS);
		return () => clearTimeout(timer);
	});
	/** 0–1 across every file of the send in flight, once the link reports it. */
	const uploadFraction = $derived.by(() => {
		const upload = view?.upload;
		if (!upload) return null;
		const total = upload.files.reduce((n, file) => n + file.size, 0);
		return total > 0 ? Math.min(1, upload.loaded / total) : null;
	});
	/** A staged file's own share: the files go out one after the other, in the order they were sent. */
	function uploadedPercent(file: File): number | null {
		const upload = view?.upload;
		const at = upload ? upload.files.indexOf(file) : -1;
		if (!upload || at < 0 || file.size === 0) return null;
		const before = upload.files.slice(0, at).reduce((n, row) => n + row.size, 0);
		return Math.floor(Math.max(0, Math.min(1, (upload.loaded - before) / file.size)) * 100);
	}
	/** The ring drawn on the send button while files upload. */
	const RING_RADIUS = 8;
	const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

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

	let suggestScrollEl = $state<HTMLDivElement | null>(null);
	let suggestMoreStart = $state(false);
	let suggestMoreEnd = $state(false);

	/**
	 * The chips stay one row and scroll sideways. A mouse wheel only scrolls down, which in a
	 * narrow pane left the chips past the edge out of reach, so it is turned sideways here; the
	 * edges fade while there is more that way, rather than a chip ending in a hard cut.
	 */
	$effect(() => {
		const row = suggestScrollEl;
		void view?.composerSuggestions;
		if (!row) return;
		const edges = () => {
			const max = row.scrollWidth - row.clientWidth;
			suggestMoreStart = row.scrollLeft > 1;
			suggestMoreEnd = row.scrollLeft < max - 1;
		};
		const onWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
			e.preventDefault();
			row.scrollLeft += e.deltaY;
		};
		edges();
		row.addEventListener('scroll', edges, { passive: true });
		row.addEventListener('wheel', onWheel, { passive: false });
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(edges);
		observer?.observe(row);
		return () => {
			row.removeEventListener('scroll', edges);
			row.removeEventListener('wheel', onWheel);
			observer?.disconnect();
		};
	});

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
		view?.replyingToId
			? (snapshot.messages.find((m) => m.id === view.replyingToId) ?? null)
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
		if (view) view.draft = serializeEditorText(editorEl);
	}

	function checkMentionTrigger(): void {
		// No Bot reads the file conversation, so there is no one to mention.
		if (!editorEl || fileDrop) {
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
		const next: StagedAttachment[] = [];
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
		stageAttachments([...pendingAttachments, ...next]);
	}

	function removePendingAttachment(id: string): void {
		const target = pendingAttachments.find((a) => a.id === id);
		if (target?.previewUrl) {
			URL.revokeObjectURL(target.previewUrl);
		}
		stageAttachments(pendingAttachments.filter((a) => a.id !== id));
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
		if (lockedComposer || !connected || !selected || view?.sending) return;
		fileInputEl?.click();
	}

	function onFileDragOver(ev: DragEvent): void {
		if (!fileDrop || lockedComposer || !connected || view?.sending) return;
		if (!ev.dataTransfer?.types.includes('Files')) return;
		ev.preventDefault();
	}

	function onFileDrop(ev: DragEvent): void {
		if (!fileDrop || lockedComposer || !connected || view?.sending) return;
		const dropped = ev.dataTransfer?.files;
		if (!dropped || dropped.length === 0) return;
		ev.preventDefault();
		addFiles(dropped);
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
		if (view) view.replyingToId = null;
	}

	/** Only the mention popup closes on an outside click; Escape order is the shell's. */
	function onWindowClick(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (showMentionPopup && isOutside(target, editorEl, mentionPopupEl)) {
			showMentionPopup = false;
			mentionDismissed = false;
		}
	}

	/**
	 * Another conversation in this composer clears whatever was half-typed into the mention popup.
	 * This one's, not the selected one's: clicking into another pane is not a change here.
	 */
	$effect(() => {
		void selected?.id;
		attachLimitHit = false;
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
		const staged = [...pendingAttachments];
		if (!(await onSend(staged.map((a) => a.file)))) return;
		for (const a of staged) {
			if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
		}
		const sent = new Set(staged.map((a) => a.id));
		target.stagedAttachments = target.stagedAttachments.filter((a) => !sent.has(a.id));
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

<svelte:window onclick={onWindowClick} />

		<footer class="composer" bind:this={composerEl} ondragover={onFileDragOver} ondrop={onFileDrop}>
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
{#if canSuggest && view && suggestionsShown}
	<div class="composer-frost-shell composer-suggest-bar" role="group" aria-label={t.chat.suggestNext}>
		<div
			bind:this={suggestScrollEl}
			class="suggest-scroll"
			class:has-more-start={suggestMoreStart}
			class:has-more-end={suggestMoreEnd}
		>
			{#each view.composerSuggestions as suggestion (suggestion.id)}
				<button
					type="button"
					class="suggest-chip"
					title={suggestion.prompt}
					onclick={() => onPickPrompt(suggestion.prompt)}
				>
					{suggestion.label}
				</button>
			{:else}
				<span class="suggest-note" role="status">{t.composer.suggestNone}</span>
			{/each}
		</div>
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
				{@const uploaded = uploadedPercent(att.file)}
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
						<span class="attachment-size mono text-10 text-muted">{formatFileSize(att.size)}{uploaded === null ? '' : ` · ${t.composer.uploaded(uploaded)}`}</span>
					</div>
					<button
						type="button"
						class="attachment-delete-btn"
						title={t.composer.removeAttachment}
						aria-label="Remove attachment {att.name}"
						disabled={view?.sending}
						onclick={() => removePendingAttachment(att.id)}
					>
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
					</button>
				</div>
			{/each}
		</div>
	{/if}

	<div
		class="composer-row flex items-end gap-2 w-full"
		class:is-file-drop={fileDrop}
		ondragover={onFileDragOver}
		ondrop={onFileDrop}
	>
		<button
			type="button"
			class="attach-btn"
			title={runtime.remote ? `${t.composer.attach} · ${t.composer.attachLimit}` : t.composer.attach}
			aria-label={runtime.remote ? `${t.composer.attach} · ${t.composer.attachLimit}` : t.composer.attach}
			disabled={!connected || !selected || lockedComposer || view?.sending}
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
		<div class="composer-editor-wrap" class:is-file-drop={fileDrop}>
		<div
			bind:this={editorEl}
			class="composer-input"
			class:is-empty={!view?.draft}
			role="textbox"
			aria-multiline="true"
			aria-label={placeholder}
			aria-describedby={!lockedComposer ? 'composer-hint' : undefined}
			data-placeholder={placeholder}
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
		{#if runtime.remote && !view?.draft}
			<span class="composer-inline-limit">{t.composer.attachLimit}</span>
		{/if}
		</div>
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
					<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"></path><path d="M20 3v4"></path><path d="M22 5h-4"></path></svg>
				{/if}
			</button>
		{/if}
		<button
			type="button"
			class="composer-action"
			class:send={primaryAction.kind === 'send'}
			class:stop={primaryAction.kind === 'stop'}
			class:is-sending={primaryAction.kind === 'send' && sendingShown}
			disabled={primaryAction.disabled}
			aria-busy={primaryAction.kind === 'send' && sendingShown ? 'true' : undefined}
			aria-label={primaryAction.kind === 'stop' ? t.composer.stopGeneration : sendingShown ? t.composer.sending : t.composer.send}
			title={primaryAction.kind === 'stop' ? t.composer.stopGeneration : sendingShown ? t.composer.sending : t.chat.sendHintShortcut}
			onclick={() => primaryAction.kind === 'stop' ? void runtime.stopTurn(selected?.id) : void send()}
		>
			{#if primaryAction.kind === 'stop'}
				<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
			{:else if sendingShown && uploadFraction !== null}
				<svg class="send-progress" aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
					<circle class="send-progress-track" cx="10" cy="10" r={RING_RADIUS} stroke-width="2.2"></circle>
					<circle
						class="send-progress-fill"
						cx="10"
						cy="10"
						r={RING_RADIUS}
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-dasharray={RING_LENGTH}
						stroke-dashoffset={RING_LENGTH * (1 - uploadFraction)}
					></circle>
				</svg>
			{:else if sendingShown}
				<svg class="send-spinner" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"></path></svg>
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
		/* Above the card, so the chips keep sitting on its left shoulder. */
		z-index: 3;
		align-self: flex-start;
		width: max-content;
		max-width: 100%;
		display: flex;
		min-width: 0;
		margin: 0 0 -8px;
		border-radius: 22px 22px 8px 8px;
		pointer-events: auto;
	}

	/* The scroller is inside the frost, so fading its edges does not cut the frost's halo off. */
	.suggest-scroll {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: nowrap;
		min-width: 0;
		padding: 4px 8px 10px 4px;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}

	.suggest-scroll::-webkit-scrollbar {
		display: none;
	}

	.suggest-scroll.has-more-end {
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
	}

	.suggest-scroll.has-more-start {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 28px);
		mask-image: linear-gradient(to right, transparent, #000 28px);
	}

	.suggest-scroll.has-more-start.has-more-end {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent);
	}

	.suggest-note {
		padding: 4px 6px;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
		white-space: nowrap;
	}

	/* Stop the chip row before the jump button. Padding inside a full-width bar would still cover it. */
	.composer-dock:has(.scroll-bottom-slot.is-shown) .composer-suggest-bar {
		max-width: calc(100% - 52px);
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
		/* Above the card's frost, under the card, so the circle sinks behind the input. */
		z-index: 1;
		/* 32px circle, 12px of air, then 32px of travel behind the card. The slot's own clip stays inside the card. */
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
		/* The slot is this box exactly. An outer shadow is clipped into a square halo. */
		box-shadow: none;
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		pointer-events: none;
		transform: translateY(76px);
		transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
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
		/* Same clip: an offset outline or outer glow is cut into a square. Draw the ring inside. */
		outline: none;
		border-color: transparent !important;
		box-shadow: inset 0 0 0 2px var(--accent);
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

	/* On its way: still the send button, not a composer with nothing to send. */
	.composer-action.is-sending:disabled {
		background: var(--accent);
		color: #ffffff;
		cursor: progress;
	}

	.send-spinner {
		animation: suggestSpin 0.9s linear infinite;
	}

	/* Filled clockwise from twelve o'clock. */
	.send-progress {
		transform: rotate(-90deg);
	}

	.send-progress-track {
		stroke: currentColor;
		opacity: 0.35;
	}

	.send-progress-fill {
		stroke: currentColor;
		transition: stroke-dashoffset 0.2s linear;
	}

	.composer-action:focus-visible,
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

	.attachment-delete-btn:hover:not(:disabled) {
		background: var(--danger);
		color: #ffffff;
	}

	/* On its way to the Mac: the chip stays as the sign of it, and cannot be taken back. */
	.attachment-delete-btn:disabled {
		opacity: 0.4;
		cursor: default;
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

		.suggest-scroll {
			flex: 1;
			padding: 8px 10px 2px;
		}

		.suggest-chip {
			min-height: 30px;
			max-width: 85%;
			padding: 4px 10px;
			font-size: 12px;
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

		.composer .composer-input {
			font-size: 15px;
			max-height: min(120px, 25dvh);
			padding: 6px 4px;
		}

		.composer-inline-limit {
			margin: -2px 4px 3px;
			font-size: 10px;
		}

		.composer .composer-input.is-empty::before {
			left: 4px;
			right: 4px;
			top: 6px;
		}

		.composer .composer-action,
		.composer .attach-btn,
		.composer .suggest-btn {
			width: 34px;
			height: 34px;
			flex-basis: 34px;
		}

		.composer-hint {
			display: none;
		}

		/* Clear of the bar's top edge, which it used to overlap by the card's rounding. */
		.mention-autocomplete-popup {
			bottom: calc(100% + 6px);
			left: 10px;
			width: calc(100% - 20px);
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

			.suggest-scroll {
				padding-left: max(16px, env(safe-area-inset-left, 0px));
				padding-right: max(16px, env(safe-area-inset-right, 0px));
			}

			.composer .composer-action,
			.composer .attach-btn,
			.composer .suggest-btn {
				width: 40px;
				height: 40px;
				flex-basis: 40px;
			}

			.composer .suggest-btn {
				margin-right: 4px;
			}

			.composer .composer-input {
				min-height: 40px;
				padding-top: 9px;
				padding-bottom: 9px;
			}

			.composer .composer-input.is-empty::before {
				top: 9px;
			}

			/* Centred over send, and off the curve with it. */
			.scroll-bottom-slot {
				right: max(20px, calc(env(safe-area-inset-right, 0px) + 4px));
			}

			.mention-autocomplete-popup {
				left: 16px;
				width: calc(100% - 32px);
			}
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.composer,
		.composer-card,
		.composer-action,
		.composer .attach-btn,
		.composer .suggest-btn,
		.scroll-bottom-btn {
			transition: none;
		}

		.suggest-spinner,
		.send-spinner {
			animation: none;
		}

		.send-progress-fill {
			transition: none;
		}
	}
</style>
