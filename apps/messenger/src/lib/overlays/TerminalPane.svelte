<script lang="ts">
	import type { Terminal as TerminalRow, StreamFrame } from '@real-bot/protocol';
	import { backdropClick } from '../click-outside.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import TerminalView from './TerminalView.svelte';

	/**
	 * The narrow host for terminals: one slide-over page listing every session the daemon holds.
	 * On a wide desktop window the same `TerminalView` is a pane instead, holding its own handful
	 * of sessions, and there the tab's × takes a session out of that pane without stopping it.
	 * Here there is nowhere to remove a session to, so the only destructive action is the
	 * explicit 结束会话, behind a confirm.
	 */
	interface Props {
		api: MessengerApi | null;
		workspacePath: string | null;
		rows: TerminalRow[];
		t: Copy;
		onStream: (id: string, sink: (frame: StreamFrame) => void) => () => void;
		onChanged: () => void;
		onClose: () => void;
	}

	let { api, workspacePath, rows, t, onStream, onChanged, onClose }: Props = $props();
	const terminalBackdrop = backdropClick();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="terminal-overlay"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	aria-label={t.terminal.title}
	onmousedowncapture={terminalBackdrop.press}
	onclick={(e) => {
		if (terminalBackdrop.isOutside(e)) onClose();
	}}
>
	<div class="terminal-overlay-pane" transition:pageSlide>
		<TerminalView {api} {workspacePath} {rows} {t} {onStream} {onChanged} {onClose} tabIds="all" />
	</div>
</div>

<style>
	.terminal-overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		justify-content: flex-end;
		background: var(--scrim, rgba(0, 0, 0, 0.35));
	}

	.terminal-overlay-pane {
		display: flex;
		flex-direction: column;
		width: min(960px, 100vw);
		height: 100%;
		min-height: 0;
		border-left: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
	}
</style>
