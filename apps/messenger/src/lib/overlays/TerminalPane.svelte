<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { Terminal as TerminalRow, StreamFrame } from '@real-bot/protocol';
	import { backdropClick } from '../click-outside.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import {
		accept,
		decodeBase64,
		encodeBase64,
		gapNotice,
		InputQueue,
		orderTerminals,
		pickActive,
		startCursor,
		statusLabel,
		TERMINAL_KEYS,
		terminalLabel,
		type StreamCursor
	} from './terminals.ts';

	interface Props {
		api: MessengerApi | null;
		/** Where a new session starts. Not a cage — you can `cd` anywhere from there. */
		workspacePath: string | null;
		rows: TerminalRow[];
		t: Copy;
		onStream: (id: string, sink: (frame: StreamFrame) => void) => () => void;
		onChanged: () => void;
		onClose: () => void;
	}

	let { api, workspacePath, rows, t, onStream, onChanged, onClose }: Props = $props();
	const terminalBackdrop = backdropClick();

	let host = $state<HTMLDivElement>();
	let activeId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	/**
	 * One xterm for the pane, reset and refilled when you switch sessions. The scrollback lives
	 * in the daemon, so re-reading it costs one round trip and saves keeping an emulator alive
	 * per tab.
	 */
	let term: import('@xterm/xterm').Terminal | null = null;
	let fit: import('@xterm/addon-fit').FitAddon | null = null;
	let observer: ResizeObserver | null = null;
	let unwatch: (() => void) | null = null;
	let cursor: StreamCursor = startCursor();
	/**
	 * Frames that arrive before the scrollback read lands. Watching starts first so no bytes fall
	 * between the two, which means the live ones have to wait their turn rather than racing the
	 * history into the buffer.
	 */
	let pending: Array<{ offset: number; bytes: Uint8Array }> = [];
	let filling = false;
	let attached: string | null = null;
	/** One session's keystrokes at a time, in order. Rebuilt when the active session changes. */
	let input: InputQueue | null = null;

	const ordered = $derived(orderTerminals(rows));
	const active = $derived(ordered.find((row) => row.id === activeId) ?? null);

	onMount(async () => {
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit')
		]);
		await import('@xterm/xterm/css/xterm.css');
		if (!host) return;
		term = new Terminal({
			convertEol: false,
			cursorBlink: true,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			fontSize: 12,
			scrollback: 5000,
			theme: xtermTheme()
		});
		fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		term.onData((data) => {
			// Bytes, not keystrokes: `^C` is 0x03 and the pty's line discipline owns what that means.
			input?.push(new TextEncoder().encode(data));
		});
		observer = new ResizeObserver(() => resizeToFit());
		observer.observe(host);
		await refresh();
	});

	onDestroy(() => {
		observer?.disconnect();
		detach();
		term?.dispose();
		term = null;
	});

	/** Reads the tokens the rest of the app is themed with, so the terminal is not a bright hole. */
	function xtermTheme() {
		const styles = getComputedStyle(document.documentElement);
		const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
		return {
			background: token('--surface-raised', '#101014'),
			foreground: token('--text-primary', '#e8e8ea'),
			cursor: token('--text-primary', '#e8e8ea')
		};
	}

	function report(cause: unknown): void {
		error = cause instanceof Error ? cause.message : String(cause);
	}

	async function refresh(): Promise<void> {
		if (!api) return;
		try {
			const items = await api.terminals();
			onChanged();
			const next = pickActive(items, activeId);
			if (next !== activeId) await activate(next);
		} catch (cause) {
			report(cause);
		}
	}

	function detach(): void {
		if (unwatch) {
			unwatch();
			unwatch = null;
		}
		if (attached && api) void api.unwatchTerminal(attached).catch(() => undefined);
		attached = null;
	}

	async function activate(id: string | null): Promise<void> {
		detach();
		activeId = id;
		input = id && api
			? new InputQueue((bytes) => api.terminalInput(id, encodeBase64(bytes)), report)
			: null;
		cursor = startCursor();
		pending = [];
		term?.reset();
		if (!id || !api) return;
		filling = true;
		attached = id;
		// Watch first, read second: the other order leaves a hole between the two.
		unwatch = onStream(id, (frame) => {
			const bytes = decodeBase64(frame.data);
			if (filling) {
				pending.push({ offset: frame.offset, bytes });
				return;
			}
			write(frame.offset, bytes);
		});
		try {
			await api.watchTerminal(id, 0);
			const history = await api.terminalScrollback(id, 0);
			if (activeId !== id) return;
			write(history.offset, decodeBase64(history.data));
			for (const frame of pending) write(frame.offset, frame.bytes);
		} catch (cause) {
			report(cause);
		} finally {
			pending = [];
			filling = false;
			resizeToFit();
		}
	}

	function write(offset: number, bytes: Uint8Array): void {
		if (!term) return;
		const taken = accept(cursor, offset, bytes);
		if (!taken) return;
		cursor = taken.cursor;
		if (taken.gap) term.write(gapNotice(taken.gap, t));
		term.write(taken.bytes);
	}

	function resizeToFit(): void {
		if (!term || !fit || !host?.isConnected) return;
		try {
			fit.fit();
		} catch {
			return; // a pane mid-transition has no usable size yet
		}
		const id = activeId;
		if (!id || !api || active?.status !== 'live') return;
		void api.terminalResize(id, term.rows, term.cols).catch(() => undefined);
	}

	async function create(): Promise<void> {
		if (!api || !workspacePath || busy) return;
		busy = true;
		error = null;
		try {
			const created = await api.openTerminal(workspacePath, term?.rows ?? 24, term?.cols ?? 80);
			onChanged();
			await activate(created.id);
			term?.focus();
		} catch (cause) {
			report(cause);
		} finally {
			busy = false;
		}
	}

	async function stop(): Promise<void> {
		if (!api || !activeId) return;
		try {
			await api.terminalSignal(activeId, 'SIGINT');
		} catch (cause) {
			report(cause);
		}
	}

	async function close(id: string): Promise<void> {
		if (!api) return;
		try {
			if (id === activeId) detach();
			await api.closeTerminal(id);
			onChanged();
			await refresh();
		} catch (cause) {
			report(cause);
		}
	}

	$effect(() => {
		// The list changes under the pane when a session exits or another client opens one.
		const next = pickActive(rows, activeId);
		if (next !== activeId) void activate(next);
	});
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
	<div class="terminal-pane" transition:pageSlide>
		<header class="terminal-head">
			<div class="terminal-tabs">
				{#each ordered as row (row.id)}
					{@const label = statusLabel(row, t)}
					<button
						type="button"
						class="terminal-tab"
						class:is-active={row.id === activeId}
						class:is-done={row.status !== 'live'}
						title={row.cwd}
						onclick={() => activate(row.id)}
					>
						<span class="terminal-tab-name">{terminalLabel(row)}</span>
						{#if label}<span class="terminal-tab-status">{label}</span>{/if}
						<span
							class="terminal-tab-close"
							role="button"
							tabindex="-1"
							aria-label={t.terminal.close}
							onclick={(e) => {
								e.stopPropagation();
								void close(row.id);
							}}>×</span
						>
					</button>
				{/each}
				<button
					type="button"
					class="terminal-new"
					disabled={!workspacePath || busy}
					onclick={create}>{t.terminal.newSession}</button
				>
			</div>
			<div class="terminal-actions">
				{#if active?.status === 'live'}
					<button type="button" class="terminal-stop" onclick={stop}>{t.terminal.stop}</button>
				{/if}
				<button type="button" class="terminal-close" aria-label={t.common.close} onclick={onClose}
					>✕</button
				>
			</div>
		</header>

		{#if !workspacePath}
			<p class="terminal-empty">{t.terminal.needsWorkspace}</p>
		{:else if !ordered.length}
			<div class="terminal-empty">
				<p>{t.terminal.empty}</p>
				<p class="terminal-hint">{t.terminal.emptyHint}</p>
				<p class="terminal-hint">{t.terminal.survivesWindow}</p>
			</div>
		{/if}
		{#if error}<p class="terminal-error">{error}</p>{/if}

		<div class="terminal-host" bind:this={host} class:is-hidden={!ordered.length}></div>

		{#if ordered.length}
			<!--
				A software keyboard has no Ctrl, no Tab, no arrows and no Escape, so without this row
				a phone could watch a command run but never stop one. Bytes straight into the queue.
			-->
			<div class="terminal-keys" aria-label={t.terminal.keys}>
				{#each TERMINAL_KEYS as key (key.id)}
					<button
						type="button"
						onclick={() => {
							input?.push(new TextEncoder().encode(key.bytes));
							term?.focus();
						}}>{key.label}</button
					>
				{/each}
			</div>
		{/if}
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

	.terminal-pane {
		display: flex;
		flex-direction: column;
		width: min(960px, 100vw);
		height: 100%;
		background: var(--surface-raised, #101014);
		border-left: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
	}

	.terminal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
	}

	.terminal-tabs {
		display: flex;
		align-items: center;
		gap: 4px;
		/* The tabs give way to the actions; a Stop button broken across two lines is not a button. */
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.terminal-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary, #9a9aa2);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
	}

	.terminal-tab.is-active {
		background: var(--surface-sunken, rgba(128, 128, 128, 0.16));
		color: var(--text-primary, #e8e8ea);
	}

	.terminal-tab.is-done {
		opacity: 0.6;
	}

	.terminal-tab-status {
		font-size: 11px;
		opacity: 0.75;
	}

	.terminal-tab-close {
		opacity: 0.5;
	}

	.terminal-new,
	.terminal-stop,
	.terminal-close {
		flex: 0 0 auto;
		padding: 4px 8px;
		white-space: nowrap;
		border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.25));
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.terminal-new:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.terminal-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 6px;
	}

	.terminal-host {
		flex: 1;
		min-height: 0;
		/* Margin, not padding. Fit reads the host's height as the cell grid and ignores the
		   parent's padding, so padding here just lets the last row paint over the gap. */
		margin: 10px 12px 16px;
	}

	.terminal-host.is-hidden {
		display: none;
	}

	/* Desktop has a real keyboard; this row is for the phone. */
	.terminal-keys {
		display: none;
	}

	.terminal-empty {
		padding: 24px 16px;
		color: var(--text-secondary, #9a9aa2);
		font-size: 13px;
	}

	.terminal-hint {
		margin-top: 6px;
		font-size: 12px;
		opacity: 0.8;
	}

	.terminal-error {
		margin: 0;
		padding: 8px 12px;
		color: var(--danger, #e05c5c);
		font-size: 12px;
	}

	@media (max-width: 720px) {
		.terminal-pane {
			width: 100vw;
			height: 100dvh;
			border-left: none;
		}

		/* The notch above, the home indicator below, and a gutter the text is not pressed against. */
		.terminal-head {
			padding: calc(6px + env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 6px
				max(8px, env(safe-area-inset-left));
		}

		/* A thumb, not a mouse: the same 44px every other target on a phone screen gets. */
		.terminal-tab,
		.terminal-new,
		.terminal-stop,
		.terminal-close {
			min-height: 44px;
		}

		.terminal-tab-close {
			padding: 0 4px;
		}

		.terminal-host {
			margin: 10px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left));
		}

		.terminal-keys {
			display: flex;
			/* Six keys, spread across the width: none of them should sit half off the screen. */
			justify-content: space-between;
			gap: 6px;
			padding: 8px max(12px, env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom))
				max(12px, env(safe-area-inset-left));
			overflow-x: auto;
			border-top: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
			scrollbar-width: none;
		}

		.terminal-keys button {
			flex: 1 1 auto;
			min-width: 44px;
			max-width: 72px;
			min-height: 40px;
			border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.25));
			border-radius: 8px;
			background: transparent;
			color: inherit;
			font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		}
	}
</style>
