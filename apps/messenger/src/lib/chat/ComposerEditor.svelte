<script lang="ts">
	type Props = {
		/** The contenteditable itself; the composer reads and drives it. */
		el?: HTMLDivElement | null;
		placeholder: string;
		/** No draft yet: the placeholder shows. */
		empty: boolean;
		lockedComposer: boolean;
		editable: boolean;
		fileDrop: boolean;
		onInput: () => void;
		onKey: (ev: KeyboardEvent) => void;
		onKeyUp: (ev: KeyboardEvent) => void;
		onCompositionStart: () => void;
		onCompositionUpdate: () => void;
		onCompositionEnd: () => void;
		onClick: (ev: MouseEvent) => void;
		onPaste: (ev: ClipboardEvent) => void;
	};

	let {
		el = $bindable(null),
		placeholder,
		empty,
		lockedComposer,
		editable,
		fileDrop,
		onInput,
		onKey,
		onKeyUp,
		onCompositionStart,
		onCompositionUpdate,
		onCompositionEnd,
		onClick,
		onPaste
	}: Props = $props();
</script>

<div class="composer-editor-wrap" class:is-file-drop={fileDrop}>
<div
	bind:this={el}
	class="composer-input"
	class:is-empty={empty}
	role="textbox"
	aria-multiline="true"
	aria-label={placeholder}
	aria-describedby={!lockedComposer ? 'composer-hint' : undefined}
	data-placeholder={placeholder}
	contenteditable={editable}
	tabindex="0"
	oninput={onInput}
	onkeydown={onKey}
	onkeyup={onKeyUp}
	oncompositionstart={onCompositionStart}
	oncompositionupdate={onCompositionUpdate}
	oncompositionend={onCompositionEnd}
	onclick={onClick}
	onpaste={onPaste}
></div>
</div>

<style>
	.composer-editor-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	:global(.composer) .composer-input {
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

	:global(.composer) .composer-input.is-empty::before {
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

	:global(.composer) .composer-input:focus-visible {
		outline: none !important;
	}

	:global(.composer) .composer-input[contenteditable="false"] {
		opacity: 0.45;
		cursor: not-allowed;
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
		border-radius: var(--radius-full);
		font-size: 13px;
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
		font-size: 10px;
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
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
		cursor: pointer;
		padding: 0;
		margin-left: 2px;
		transition: 0.1s ease;
		transition-property: var(--transition-props);
	}

	.composer-input :global(.inline-mention-chip .chip-close-btn:hover) {
		background: color-mix(in srgb, var(--accent) 25%, transparent);
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
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent);
		cursor: pointer;
		padding: 0;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}

	.composer-input :global(.chip-close-btn:hover) {
		background: var(--accent);
		color: var(--on-accent);
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

	@container conversation (max-width: 680px) {
		:global(.composer) .composer-input {
			font-size: 15px;
			max-height: min(120px, 25dvh);
			padding: 6px 4px;
		}

		:global(.composer) .composer-input.is-empty::before {
			left: 4px;
			right: 4px;
			top: 6px;
		}

		@media (pointer: coarse) {
			:global(.composer) .composer-input {
				min-height: 40px;
				padding-top: 9px;
				padding-bottom: 9px;
			}

			:global(.composer) .composer-input.is-empty::before {
				top: 9px;
			}
		}
	}
</style>
