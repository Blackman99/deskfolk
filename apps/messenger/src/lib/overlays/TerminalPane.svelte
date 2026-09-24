<script lang="ts">
	import type { Terminal as TerminalRow, StreamFrame } from '@real-bot/protocol';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import TerminalView from './TerminalView.svelte';
	import { keyboardViewport } from './terminal-viewport.ts';

	/**
	 * The narrow host for terminals: one slide-over page with every session the daemon holds as
	 * its tabs. On a wide desktop window each of those sessions is a workbench tab of its own, and
	 * that tab's × takes it off the screen without stopping it; here they are gathered back into
	 * one page, there is nowhere to remove a session to, and the only destructive action is the
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

	/** The page's own find bar and menus close before the page does. */
	let view = $state<{ closeFindBar: () => boolean; closeMenus: () => boolean } | null>(null);

	/** The part of the screen a software keyboard leaves, while one is up; see `keyboardViewport`. */
	let above = $state<{ top: number; height: number } | null>(null);

	$effect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const follow = () => (above = keyboardViewport(window.innerHeight, viewport));
		follow();
		viewport.addEventListener('resize', follow);
		viewport.addEventListener('scroll', follow);
		return () => {
			viewport.removeEventListener('resize', follow);
			viewport.removeEventListener('scroll', follow);
		};
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="terminal-overlay"
	class:has-keyboard={above !== null}
	style:top={above ? `${above.top}px` : null}
	style:bottom={above ? 'auto' : null}
	style:height={above ? `${above.height}px` : null}
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	aria-label={t.terminal.title}
	onmousedowncapture={terminalBackdrop.press}
	onclick={(e) => {
		if (terminalBackdrop.isOutside(e)) onClose();
	}}
>
	<div class="terminal-overlay-pane">
		<TerminalView
			bind:this={view}
			{api}
			{workspacePath}
			{rows}
			{t}
			{onStream}
			{onChanged}
			onClose={() => {
				if (view?.closeFindBar()) return;
				if (view?.closeMenus()) return;
				onClose();
			}}
			tabIds="all"
		/>
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
		border-left: 1px solid var(--line);
	}

	/* The keyboard covers the home indicator, so the key bar sits right on top of it. */
	.terminal-overlay.has-keyboard {
		--terminal-bottom-inset: 0px;
	}

	@media (max-width: 680px) {
		.terminal-overlay-pane {
			border-left: none;
		}
	}
</style>
