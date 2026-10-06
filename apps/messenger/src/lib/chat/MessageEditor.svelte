<script lang="ts">
	/**
	 * A line of yours, changed in its own bubble (ADR 0063). Enter keeps the change, Shift+Enter
	 * starts a new line, Esc leaves the line as it was; an Enter that only confirms an input method's
	 * candidate is not a save. The words are plain text — a name you mention is its `@Name`, as the
	 * line itself stores it.
	 */
	import { onMount } from 'svelte';
	import type { Copy } from '../copy.ts';
	import {
		COMPOSER_IME_IDLE,
		composerImeKeyAction,
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate
	} from './composer-ime.ts';

	type Props = {
		t: Copy;
		value: string;
		saving: boolean;
		/** Why the last save did not land, already in words. */
		error: string | null;
		onInput: (value: string) => void;
		onSave: () => void;
		onCancel: () => void;
	};

	let { t, value, saving, error, onInput, onSave, onCancel }: Props = $props();

	let field = $state<HTMLTextAreaElement | null>(null);
	let ime = COMPOSER_IME_IDLE;

	/** As tall as what it holds, up to the cap in the stylesheet; no inner scrollbar for a short line. */
	function fit(): void {
		if (!field) return;
		field.style.height = 'auto';
		field.style.height = `${field.scrollHeight}px`;
	}

	onMount(() => {
		fit();
		field?.focus({ preventScroll: true });
		// The caret goes where you would go on typing: after the last word.
		const end = field?.value.length ?? 0;
		field?.setSelectionRange(end, end);
		field?.scrollIntoView?.({ block: 'nearest' });
	});

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') {
			// Before the window's own Escape chain: this one closes the editor, nothing behind it.
			ev.preventDefault();
			ev.stopPropagation();
			onCancel();
			return;
		}
		if (ev.key !== 'Enter' || ev.shiftKey) return;
		const action = composerImeKeyAction(ev, ime, Date.now());
		if (action === 'ignore') return;
		ev.preventDefault();
		if (action === 'pass' && !saving) onSave();
	}
</script>

<div class="msg-editor" role="group" aria-label={t.chat.editThisLine}>
	<textarea
		bind:this={field}
		class="msg-editor-field"
		{value}
		rows="1"
		aria-label={t.chat.editThisLine}
		aria-invalid={error ? 'true' : undefined}
		disabled={saving}
		oninput={(ev) => {
			onInput((ev.currentTarget as HTMLTextAreaElement).value);
			fit();
		}}
		oncompositionstart={() => (ime = composerImeOnStart())}
		oncompositionupdate={() => (ime = composerImeOnUpdate(ime))}
		oncompositionend={() => (ime = composerImeOnEnd(Date.now()))}
		onkeydown={onKeydown}
	></textarea>
	{#if error}
		<p class="msg-editor-error" role="alert">{error}</p>
	{/if}
	<div class="msg-editor-foot">
		<span class="msg-editor-hint">{t.chat.editHint}</span>
		<span class="msg-editor-actions">
			<button type="button" class="msg-editor-cancel" disabled={saving} onclick={onCancel}>{t.chat.editCancel}</button>
			<button type="button" class="msg-editor-save" disabled={saving} aria-busy={saving ? 'true' : undefined} onclick={onSave}>
				{saving ? t.chat.editSaving : t.chat.editSave}
			</button>
		</span>
	</div>
</div>

<style>
	.msg-editor {
		display: grid;
		gap: 8px;
		min-width: 0;
		width: 100%;
	}

	/* A phone keeps a bubble from selecting on long-press; the words being changed must select and paste. */
	.msg-editor-field {
		-webkit-user-select: text;
		user-select: text;
		-webkit-touch-callout: default;
		display: block;
		width: 100%;
		min-width: 0;
		max-height: min(50vh, 360px);
		box-sizing: border-box;
		resize: none;
		overflow-y: auto;
		padding: 8px 10px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		color: var(--ink);
		background: var(--pane);
		font: inherit;
		font-size: var(--text-body);
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.msg-editor-field:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.msg-editor-error {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--danger-text);
	}

	.msg-editor-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.msg-editor-hint {
		font-size: var(--text-caption);
		color: var(--muted);
	}

	.msg-editor-actions {
		display: inline-flex;
		gap: 8px;
		margin-inline-start: auto;
	}

	.msg-editor-actions button {
		min-height: 30px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		font-size: var(--text-caption);
		font-weight: 600;
		cursor: pointer;
		/* Never `all`: a button that slides while laid out reads as broken. */
		transition-property: background-color, color, border-color, opacity;
		transition-duration: 0.15s;
	}

	.msg-editor-cancel {
		border: 1px solid var(--line);
		color: var(--ink);
		background: var(--pane);
	}

	.msg-editor-save {
		border: 1px solid var(--accent);
		color: var(--on-accent);
		background: var(--accent);
	}

	.msg-editor-save:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.msg-editor-actions button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	@media (pointer: coarse) {
		.msg-editor-actions button {
			min-height: 40px;
		}

		/* A phone's keyboard has its own return key; the key list is for a desk. */
		.msg-editor-hint {
			display: none;
		}
	}
</style>
