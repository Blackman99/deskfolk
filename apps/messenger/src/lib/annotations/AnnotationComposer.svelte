<script lang="ts">
	import type { Copy } from '../copy.ts';

	interface Props {
		t: Copy;
		/** Where the new annotation sits, as the card will say it: `第 12–18 行`. */
		position: string;
		busy: boolean;
		error: string | null;
		onSave: (body: string) => void;
		onCancel: () => void;
	}

	let { t, position, busy, error, onSave, onCancel }: Props = $props();
	let body = $state('');

	function save(): void {
		const text = body.trim();
		if (!text || busy) return;
		onSave(text);
	}

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			ev.stopPropagation();
			onCancel();
		} else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			save();
		}
	}
</script>

<div class="annot-composer flex flex-col gap-6 p-8" role="dialog" aria-label={t.stream.annotationAdd} data-annotation-composer>
	<span class="annot-composer-pos mono text-11">{position}</span>
	<!-- svelte-ignore a11y_autofocus -->
	<textarea class="annot-composer-input" rows="3" placeholder={t.stream.annotationPlaceholder} bind:value={body} autofocus onkeydown={onKey} disabled={busy}></textarea>
	{#if error}<p class="annot-composer-error text-11 m-0">{error}</p>{/if}
	<div class="flex gap-6 justify-end">
		<button type="button" class="artifact-tool-btn annot-composer-btn" onclick={onCancel} disabled={busy}>{t.stream.annotationCancel}</button>
		<button type="button" class="annot-composer-save" onclick={save} disabled={busy || !body.trim()}>{t.stream.annotationSaveDraft}</button>
	</div>
</div>

<style>
	.annot-composer {
		width: min(360px, calc(100% - 16px));
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-md);
	}
	.annot-composer-pos {
		color: var(--muted);
	}
	.annot-composer-input {
		width: 100%;
		resize: vertical;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12.5px;
	}
	.annot-composer-input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.annot-composer-error {
		color: var(--danger);
	}
	.annot-composer-save {
		min-height: 28px;
		padding: 0 12px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.annot-composer-save:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.annot-composer-btn {
		min-height: 28px;
	}
	@media (max-width: 680px) {
		.annot-composer {
			width: calc(100% - 16px);
		}
		.annot-composer-save,
		.annot-composer-btn {
			min-height: 40px;
		}
	}
</style>
