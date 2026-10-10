<script lang="ts">
	import type { Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { backdropClick } from '../click-outside.ts';
	import PromptEditor from './PromptEditor.svelte';
	import type { PromptView } from './prompts-view.ts';

	/**
	 * One built-in prompt's editor as a page over settings: a dialog on a wide window, an inner page
	 * with Back on a phone. Settings › Prompts and the call map (ADR 0082) both open it.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		item: PromptSummary;
		open: { id: string; locale: Locale };
		/** The view shown; bound, so switching the language keeps you where you were. */
		view?: PromptView;
		/** A change to open in the history the first time the editor shows it (a card's 「在设置里看」). */
		reveal?: string | null;
		/** Back, ✕, Escape or a click outside. */
		onclose: () => void;
		onlocale: (locale: Locale) => void;
		onopenmessage: (sessionId: string, messageId: string) => void;
	}

	let { runtime, t, item, open, view = $bindable('text'), reveal = null, onclose, onlocale, onopenmessage }: Props = $props();
	const c = $derived(t.prompts);
	const ui = $derived<Locale>(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const editorBackdrop = backdropClick();
	let editor = $state<PromptEditor>();

	/** Saves what was typed and not yet saved. */
	export function flush(): Promise<void> {
		return editor?.flush() ?? Promise.resolve();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		event.preventDefault();
		onclose();
	}
</script>

<div
	class="modal-backdrop prompt-editor-backdrop z-[110]"
	role="dialog"
	aria-modal="true"
	aria-labelledby="prompt-editor-title"
	tabindex="-1"
	onmousedowncapture={editorBackdrop.press}
	onclick={(event) => {
		if (editorBackdrop.isOutside(event)) onclose();
	}}
	onkeydown={onKeydown}
>
	<div class="modal-dialog prompt-editor-modal settings-subpage">
		<div class="modal-head settings-subpage-head">
			<button type="button" class="settings-subpage-back" aria-label={c.back} onclick={() => onclose()}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<div class="prompt-editor-heading">
				<h2 id="prompt-editor-title">{item.title[ui]}</h2>
				<code class="prompt-editor-id">{item.id}</code>
			</div>
			<button type="button" class="modal-close" aria-label={t.common.close} onclick={() => onclose()}>✕</button>
		</div>
		<div class="modal-body prompt-editor-body">
			{#key `${open.id}:${open.locale}`}
				<PromptEditor
					bind:this={editor}
					bind:view
					{runtime}
					{t}
					id={open.id}
					locale={open.locale}
					revealRevision={reveal}
					onLocale={onlocale}
					onOpenMessage={onopenmessage}
				/>
			{/key}
		</div>
	</div>
</div>

<style>
	/* The editor: a page over settings, tall enough that a long prompt reads as a document. */
	.modal-dialog.prompt-editor-modal {
		width: min(860px, calc(100vw - 48px));
		height: min(820px, calc(100vh - 48px));
		display: flex;
		flex-direction: column;
	}

	.prompt-editor-modal > :global(.modal-head) {
		gap: 12px;
	}

	/* ✕ on a wide window, Back on a phone — as the MCP editor has it. */
	.settings-subpage-back {
		display: none;
	}

	.prompt-editor-heading {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.prompt-editor-heading h2 {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 16px;
		font-weight: 650;
		color: var(--ink);
	}

	.prompt-editor-id {
		flex: none;
		padding: 0 6px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font: 11px/1.6 var(--mono);
	}

	.modal-body.prompt-editor-body {
		padding: 0;
		gap: 0;
		overflow: hidden;
	}

	@media (max-width: 720px) {
		/* On a phone the editor is an inner page of settings, as the MCP editor is. */
		.prompt-editor-backdrop {
			padding: 0;
			align-items: stretch;
			background: var(--sidebar-bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		/* It slides in over the list, one level deeper, as the MCP and endpoint editors do. */
		.modal-dialog.prompt-editor-modal {
			width: 100%;
			max-width: none;
			height: 100%;
			max-height: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			animation: prompt-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
			background: var(--sidebar-bg);
		}

		.prompt-editor-modal > :global(.settings-subpage-head) {
			height: calc(56px + env(safe-area-inset-top));
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 8px 0;
			gap: 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.prompt-editor-heading {
			justify-content: center;
			padding-right: 40px;
		}

		.prompt-editor-id {
			display: none;
		}

		.prompt-editor-modal :global(.modal-close) {
			display: none;
		}

		.settings-subpage-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: none;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}

		.settings-subpage-back:active {
			background: var(--row-hover);
		}
	}

	@keyframes prompt-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
