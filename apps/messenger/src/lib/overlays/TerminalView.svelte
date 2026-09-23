<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { Terminal as TerminalRow, StreamFrame, TerminalScreenSnapshot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { copyText, readClipboardText } from '../clipboard.ts';
	import { openExternalLink } from '../open-link.ts';
	import { registerPaneEdit } from '../workbench/pane-edit.ts';
	import { macEditingBytes, terminalShortcut, type TerminalShortcut } from './terminal-keys.ts';
	import {
		documentTheme,
		findDecorations,
		minimumContrast,
		terminalColors,
		terminalTheme
	} from './terminal-theme.ts';
	import { terminalFontSize } from './terminal-font.svelte.ts';
	import { silenceRequests } from './terminal-requests.ts';
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
		terminalNames,
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
		/**
		 * Which sessions this container shows. On a phone that is every one the daemon has, as
		 * tabs to switch between — there is nowhere else for them to be. On the desktop each
		 * workbench tab is one terminal, so it names its one session (or none yet) and has
		 * nothing to switch between.
		 */
		tabIds?: readonly string[] | 'all';
		/**
		 * The session a container that had none started, so the tab it sits in is that terminal
		 * from now on and a restart comes back to it.
		 */
		onBind?: (id: string) => void;
	}

	let {
		api,
		workspacePath,
		rows,
		t,
		onStream,
		onChanged,
		onClose,
		tabIds = 'all',
		onBind
	}: Props = $props();

	/** The session an "end this" is waiting on confirmation for. Ending one stops what it runs. */
	let endConfirmId = $state<string | null>(null);

	let host = $state<HTMLDivElement>();
	let activeId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	/**
	 * One xterm per visible container, reset and refilled when you switch sessions. The
	 * scrollback lives in the daemon, so re-reading it costs one round trip and saves keeping an
	 * emulator alive for every tab in every pane, which is unbounded.
	 */
	let term: import('@xterm/xterm').Terminal | null = null;
	let fit: import('@xterm/addon-fit').FitAddon | null = null;
	let search: import('@xterm/addon-search').SearchAddon | null = null;
	let stopFit: (() => void) | null = null;
	let stopTheme: (() => void) | null = null;
	let stopEdit: (() => void) | null = null;
	let stopQuiet: (() => void) | null = null;
	/** What pressed last, read by a link's activation: that arrives as a plain mouse event either way. */
	let lastPointer = 'mouse';
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
	/** Whether what xterm is parsing is a session's history rather than its live output. */
	let replaying = false;
	/**
	 * Whether the daemon keeps this session's screen, and so answers what its programs ask. It
	 * does once it has handed over a snapshot; one that predates that is attached the old way.
	 */
	let daemonAnswers = false;
	let replaySeq = 0;
	/** The size this pane last asked the pty for, until the session reports it back. */
	let told: { id: string; rows: number; cols: number } | null = null;

	/** ⌘F. The query outlives the bar, so ⌘G goes on finding the last thing you looked for. */
	let findOpen = $state(false);
	let findQuery = $state('');
	let findResult = $state<{ resultIndex: number; resultCount: number } | null>(null);
	let findInput = $state<HTMLInputElement>();
	const findCount = $derived.by(() => {
		if (!findQuery || !findResult) return '';
		if (findResult.resultCount === 0) return t.terminal.findNone;
		// Past xterm's highlight limit it stops numbering the one you are on.
		if (findResult.resultIndex < 0) return t.terminal.findMany.replace('{count}', String(findResult.resultCount));
		return `${findResult.resultIndex + 1}/${findResult.resultCount}`;
	});

	/** One named session: a workbench tab. Its title is on the tab, so there is no strip here. */
	const single = $derived(tabIds !== 'all');
	const ordered = $derived(
		tabIds === 'all'
			? orderTerminals(rows)
			: orderTerminals(rows.filter((row) => tabIds.includes(row.id)))
	);
	const active = $derived(ordered.find((row) => row.id === activeId) ?? null);
	const names = $derived(terminalNames(rows));
	/** Whether there is a session on screen. A tab's own session can be a moment ahead of the list. */
	const showing = $derived(single ? activeId !== null : ordered.length > 0);

	/**
	 * The session to show. A tab shows the one it names and never another: picking "the newest
	 * live one" there turned every terminal tab into the same shell as soon as it was switched to.
	 */
	function choose(items: readonly TerminalRow[]): string | null {
		if (tabIds !== 'all') return tabIds[0] ?? null;
		return pickActive([...items], activeId);
	}

	onMount(async () => {
		const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }, { SearchAddon }, { WebglAddon }] =
			await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit'),
				import('@xterm/addon-unicode11'),
				import('@xterm/addon-web-links'),
				import('@xterm/addon-search'),
				import('@xterm/addon-webgl')
			]);
		await import('@xterm/xterm/css/xterm.css');
		if (!host) return;
		const theme = documentTheme();
		term = new Terminal({
			// Unicode 11 widths and find's highlights are both still "proposed" API in xterm 5.
			allowProposedApi: true,
			convertEol: false,
			cursorBlink: true,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			fontSize: terminalFontSize.current,
			scrollback: 5000,
			// A program that takes the mouse (vim, htop, a TUI) still lets ⌥-drag select, as Terminal.app does.
			macOptionClickForcesSelection: true,
			theme: xtermTheme(theme),
			minimumContrastRatio: minimumContrast(theme),
			// OSC 8 links a program prints on purpose, next to the URLs found in plain text below.
			linkHandler: { activate: (event, uri) => openLink(event, uri) }
		});
		fit = new FitAddon();
		term.loadAddon(fit);
		// Emoji and wide symbols take two cells, as the programs printing them assume; xterm's
		// default table is Unicode 6, which has them as one and walks every TUI border out of line.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = '11';
		term.loadAddon(new WebLinksAddon((event, uri) => openLink(event, uri)));
		search = new SearchAddon();
		term.loadAddon(search);
		search.onDidChangeResults((result) => (findResult = result));
		const quiet = silenceRequests(term.parser, () => replaying || daemonAnswers);
		stopQuiet = () => quiet.dispose();
		term.open(host);
		host.addEventListener('pointerdown', (event) => (lastPointer = event.pointerType), { capture: true });
		loadGpuRenderer(term, WebglAddon);
		fit.fit();
		term.onData((data) => {
			// Typing here takes the size back from the phone, or whichever other client last
			// showed this session: the pty fits the screen you are using, as tmux's "latest" does.
			if (active && term && (active.rows !== term.rows || active.cols !== term.cols)) resizeToFit();
			// Bytes, not keystrokes: `^C` is 0x03 and the pty's line discipline owns what that means.
			input?.push(new TextEncoder().encode(data));
		});
		term.attachCustomKeyEventHandler(onTerminalKey);
		stopFit = onPaneResize(host, () => resizeToFit());
		stopTheme = followTheme();
		stopEdit = registerPaneEdit(host, {
			canCopy: () => term?.hasSelection() ?? false,
			copy: () => {
				const text = term?.getSelection();
				if (text) copyText(text);
				term?.focus();
			},
			paste: () => void pasteClipboard()
		});
		await refresh();
		// The session is usually attached before the emulator exists, and that attach had nothing
		// to measure with; now there is.
		resizeToFit();
	});

	onDestroy(() => {
		stopFit?.();
		stopFit = null;
		stopTheme?.();
		stopTheme = null;
		stopEdit?.();
		stopEdit = null;
		stopQuiet?.();
		stopQuiet = null;
		detach();
		search = null;
		term?.dispose();
		term = null;
	});

	/**
	 * Draw on the GPU, which is what keeps a build's output or a busy TUI from stuttering. The DOM
	 * renderer is what xterm falls back to on its own when WebGL is refused or its context is
	 * later taken away, so either failure just leaves the terminal as it was.
	 */
	function loadGpuRenderer(
		target: import('@xterm/xterm').Terminal,
		Addon: typeof import('@xterm/addon-webgl').WebglAddon
	): void {
		try {
			const gpu = new Addon();
			gpu.onContextLoss(() => gpu.dispose());
			target.loadAddon(gpu);
		} catch {
			// No WebGL here; the DOM renderer stays.
		}
	}

	/** Light and dark follow the window, including the switch "follow the system" makes at dusk. */
	function followTheme(): () => void {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			if (!term) return;
			const theme = documentTheme(root);
			term.options.theme = xtermTheme(theme);
			term.options.minimumContrastRatio = minimumContrast(theme);
			if (findOpen) find(0);
			if (activeId) tellColors(activeId);
		});
		observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
		return () => observer.disconnect();
	}

	/** A plain click selects, as in Terminal.app; ⌘-click opens. A finger has no ⌘, so a tap opens. */
	function openLink(event: MouseEvent, uri: string): void {
		if (!event.metaKey && lastPointer !== 'touch') return;
		void openExternalLink(uri);
	}

	/**
	 * The keys a Mac terminal answers that xterm leaves to the app. Swallowed on every phase so
	 * xterm never sends its own bytes for them too; acted on once, on the way down.
	 */
	function onTerminalKey(event: KeyboardEvent): boolean {
		const bytes = macEditingBytes(event);
		const shortcut = bytes ? null : terminalShortcut(event);
		if (!bytes && !shortcut) return true;
		if (event.type === 'keydown') {
			event.preventDefault();
			if (bytes) input?.push(new TextEncoder().encode(bytes));
			else if (shortcut) runShortcut(shortcut);
		}
		return false;
	}

	function runShortcut(shortcut: TerminalShortcut): void {
		switch (shortcut) {
			case 'clear':
				// Scrollback and screen, keeping the line you are on, as ⌘K does in Terminal.app —
				// and the daemon's too, or the next pane to attach would bring it all back.
				term?.clear();
				if (activeId && daemonAnswers) void api?.clearTerminalScreen(activeId).catch(() => undefined);
				break;
			case 'find':
				openFind();
				break;
			case 'find-next':
			case 'find-previous':
				if (!findQuery) openFind();
				else find(shortcut === 'find-next' ? 1 : -1);
				break;
			case 'font-bigger':
				terminalFontSize.step(1);
				break;
			case 'font-smaller':
				terminalFontSize.step(-1);
				break;
			case 'font-reset':
				terminalFontSize.step(0);
				break;
		}
	}

	/** Once the session reports the size asked for, the request is spent: what it says from then on is the truth. */
	$effect(() => {
		const row = active;
		if (told && row && told.id === row.id && told.rows === row.rows && told.cols === row.cols) told = null;
	});

	$effect(() => {
		const size = terminalFontSize.current;
		if (!term || term.options.fontSize === size) return;
		term.options.fontSize = size;
		resizeToFit();
	});

	function openFind(): void {
		findOpen = true;
		queueMicrotask(() => {
			findInput?.focus();
			findInput?.select();
		});
	}

	function closeFind(): void {
		findOpen = false;
		findResult = null;
		search?.clearDecorations();
		term?.focus();
	}

	/** 0 is as you type: stay on the match you are on if it still matches. */
	function find(step: 1 | -1 | 0): void {
		if (!search) return;
		if (!findQuery) {
			search.clearDecorations();
			findResult = null;
			return;
		}
		const options = { decorations: findDecorations(documentTheme()) };
		if (step === -1) search.findPrevious(findQuery, options);
		else search.findNext(findQuery, { ...options, incremental: step === 0 });
	}

	function onFindKey(event: KeyboardEvent): void {
		const shortcut = terminalShortcut(event);
		if (event.key === 'Enter') {
			event.preventDefault();
			find(event.shiftKey ? -1 : 1);
		} else if (event.key === 'Escape') {
			// Kept here: the shell unwinds Escape from the window, and this one only closes the bar.
			event.preventDefault();
			event.stopPropagation();
			closeFind();
		} else if (shortcut === 'find-next' || shortcut === 'find-previous') {
			event.preventDefault();
			find(shortcut === 'find-next' ? 1 : -1);
		} else if (shortcut === 'find') {
			event.preventDefault();
			findInput?.select();
		}
	}

	/** Paste from the right-click menu. Into the shell as a paste, so bracketed-paste mode holds. */
	async function pasteClipboard(): Promise<void> {
		const text = await readClipboardText();
		if (text && term && active?.status === 'live') term.paste(text);
		term?.focus();
	}

	/** The pane's own tokens as they resolve right now, so the terminal is the pane it sits in. */
	function xtermTheme(theme: 'light' | 'dark') {
		const styles = getComputedStyle(document.documentElement);
		return terminalTheme(theme, (name) => styles.getPropertyValue(name));
	}

	function report(cause: unknown): void {
		error = cause instanceof Error ? cause.message : String(cause);
	}

	async function refresh(): Promise<void> {
		if (!api) return;
		try {
			const items = await api.terminals();
			onChanged();
			const next = choose(items);
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
			const screen = await readScreen(id);
			const history = screen ? null : await api.terminalScrollback(id, 0);
			if (activeId !== id) return;
			daemonAnswers = screen !== null;
			// History goes in with its requests unanswered; see `silenceRequests`. xterm parses
			// writes in order and runs a write's callback once it is through, so the empty write
			// marks where the history ends and the live frames begin.
			const replay = ++replaySeq;
			if (term) replaying = true;
			if (screen) {
				// Drawn at the size it was taken at, so it lands where the program put it; the fit
				// below then takes the pane's size, and the pty and the daemon follow.
				cursor = startCursor(screen.offset);
				term?.resize(screen.cols, screen.rows);
				term?.write(decodeBase64(screen.data));
			} else if (history) {
				write(history.offset, decodeBase64(history.data));
			}
			term?.write('', () => {
				if (replay === replaySeq) replaying = false;
			});
			for (const frame of pending) write(frame.offset, frame.bytes);
			tellColors(id);
		} catch (cause) {
			report(cause);
		} finally {
			pending = [];
			filling = false;
			resizeToFit();
		}
	}

	/** The daemon's screen for this session, or null from a daemon that does not keep one. */
	async function readScreen(id: string): Promise<TerminalScreenSnapshot | null> {
		try {
			return (await api?.terminalScreen(id)) ?? null;
		} catch {
			return null;
		}
	}

	/** What colour requests are answered with: this pane's, now that it is the one attached. */
	function tellColors(id: string): void {
		if (!api || !daemonAnswers || !term) return;
		const theme = documentTheme();
		void api.terminalColors(id, terminalColors(theme, xtermTheme(theme))).catch(() => undefined);
	}

	function write(offset: number, bytes: Uint8Array): void {
		if (!term) return;
		const taken = accept(cursor, offset, bytes);
		if (!taken) return;
		cursor = taken.cursor;
		if (taken.gap) term.write(gapNotice(taken.gap, t));
		term.write(taken.bytes);
	}

	/**
	 * Measured against the pty's size, not this xterm's last one. A session is opened at 80×24
	 * before any pane has measured it, and one opened on the phone has the phone's size, so a
	 * pane that has not itself changed still has to tell the pty what it is showing — or the
	 * shell wraps at 80 columns and a full-screen program draws in the top left corner.
	 */
	function resizeToFit(): void {
		if (!term || !fit || !host?.isConnected) return;
		try {
			fit.fit();
		} catch {
			return; // a pane mid-transition has no usable size yet
		}
		const id = activeId;
		if (!id || !api || !active || active.status !== 'live') return;
		// What the pty has, or is about to have once the last request lands. A drag that ends
		// where it started, and the second observation of one real change, must not redraw.
		if (told?.id !== id) told = null;
		const pty = told ?? active;
		if (term.rows === pty.rows && term.cols === pty.cols) return;
		const asked = { id, rows: term.rows, cols: term.cols };
		told = asked;
		void api.terminalResize(id, asked.rows, asked.cols).catch(() => {
			if (told === asked) told = null;
		});
	}

	async function create(): Promise<void> {
		if (!api || !workspacePath || busy) return;
		busy = true;
		error = null;
		try {
			const created = await api.openTerminal(workspacePath, term?.rows ?? 24, term?.cols ?? 80);
			onChanged();
			// A tab that had no session is this one's now; the phone's page just switches to it.
			if (single) onBind?.(created.id);
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
		// The list changes under the page when a session exits or another client opens one.
		const next = choose(rows);
		// Not before the emulator exists: history read then has nowhere to go and is never read
		// again. The mount's own refresh attaches once it does.
		if (!term) return;
		if (next !== activeId) void activate(next);
	});
</script>

<div class="terminal-pane">
	<header class="terminal-head">
		{#if single}
			<!-- The tab above already carries the title; here is where the shell is and how it is. -->
			<div class="terminal-where">
				{#if active}
					{@const label = statusLabel(active, t)}
					<span class="terminal-cwd" title={active.cwd}>{active.cwd}</span>
					{#if label}<span class="terminal-tab-status">{label}</span>{/if}
				{/if}
			</div>
		{:else}
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
						<span class="terminal-tab-name">{names.get(row.id) ?? row.title}</span>
						{#if label}<span class="terminal-tab-status">{label}</span>{/if}
					</button>
				{/each}
				<button
					type="button"
					class="terminal-new"
					disabled={!workspacePath || busy}
					onclick={create}>{t.terminal.newSession}</button
				>
			</div>
		{/if}
		<div class="terminal-actions">
			{#if active?.status === 'live'}
				<button type="button" class="terminal-stop" onclick={stop}>{t.terminal.stop}</button>
			{/if}
			{#if active}
				{#if endConfirmId === active.id}
					<span class="terminal-confirm">{t.terminal.endConfirm}</span>
					<button
						type="button"
						class="terminal-end is-armed"
						onclick={() => {
							const id = active.id;
							endConfirmId = null;
							void close(id);
						}}>{t.terminal.end}</button
					>
					<button type="button" class="terminal-new" onclick={() => (endConfirmId = null)}
						>{t.detail.cancel}</button
					>
				{:else}
					<button
						type="button"
						class="terminal-end"
						onclick={() => {
							if (active.status === 'live') endConfirmId = active.id;
							else void close(active.id);
						}}>{t.terminal.end}</button
					>
				{/if}
			{/if}
			{#if tabIds === 'all'}
				<button type="button" class="terminal-close" aria-label={t.common.close} onclick={onClose}
					>✕</button
				>
			{/if}
		</div>
	</header>

	{#if !workspacePath}
		<p class="terminal-empty">{t.terminal.needsWorkspace}</p>
	{:else if !showing}
		<div class="terminal-empty">
			<p>{t.terminal.empty}</p>
			<p class="terminal-hint">{t.terminal.emptyHint}</p>
			<p class="terminal-hint">{t.terminal.survivesWindow}</p>
			{#if single}
				<!-- A tab whose shell could not be started when it opened: start one here. -->
				<button type="button" class="terminal-new" disabled={busy} onclick={create}
					>{t.terminal.newSession}</button
				>
			{/if}
		</div>
	{/if}
	{#if error}<p class="terminal-error">{error}</p>{/if}

	<div class="terminal-stage" class:is-hidden={!showing}>
		<div class="terminal-host" bind:this={host}></div>
		{#if findOpen}
			<div class="terminal-find" role="search">
				<input
					bind:this={findInput}
					bind:value={findQuery}
					type="text"
					placeholder={t.terminal.find}
					aria-label={t.terminal.find}
					spellcheck="false"
					autocomplete="off"
					oninput={() => find(0)}
					onkeydown={onFindKey}
				/>
				<span class="terminal-find-count" aria-live="polite">{findCount}</span>
				<button type="button" aria-label={t.terminal.findPrevious} title={t.terminal.findPrevious} onclick={() => find(-1)}
					>↑</button
				>
				<button type="button" aria-label={t.terminal.findNext} title={t.terminal.findNext} onclick={() => find(1)}
					>↓</button
				>
				<button type="button" aria-label={t.terminal.findClose} title={t.terminal.findClose} onclick={closeFind}
					>✕</button
				>
			</div>
		{/if}
	</div>

	{#if showing}
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

<style>
	.terminal-pane {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: var(--pane);
	}

	.terminal-end {
		flex: 0 0 auto;
	}

	.terminal-end.is-armed {
		color: var(--danger);
	}

	.terminal-confirm {
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
	}

	.terminal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--line);
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
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
	}

	.terminal-tab.is-active {
		background: var(--chip);
		color: var(--ink);
	}

	.terminal-tab.is-done {
		opacity: 0.6;
	}

	.terminal-tab-status {
		font-size: 11px;
		opacity: 0.75;
	}

	/* Where a tab's shell is. The tab above names it; the path is what tells two apart. */
	.terminal-where {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		color: var(--muted);
	}

	.terminal-cwd {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.terminal-new,
	.terminal-stop,
	.terminal-close {
		flex: 0 0 auto;
		padding: 4px 8px;
		white-space: nowrap;
		border: 1px solid var(--line);
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

	/* Holds the terminal and the find bar that floats over its top right corner. */
	.terminal-stage {
		position: relative;
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
	}

	.terminal-stage.is-hidden {
		display: none;
	}

	.terminal-host {
		flex: 1;
		min-height: 0;
		/* Margin, not padding. Fit reads the host's height as the cell grid and ignores the
		   parent's padding, so padding here just lets the last row paint over the gap. */
		margin: 10px 12px 16px;
	}

	.terminal-find {
		position: absolute;
		top: 6px;
		right: 12px;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 3px 4px 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm, 6px);
		background: var(--pane);
		box-shadow: var(--shadow-md);
	}

	.terminal-find input {
		width: 180px;
		min-width: 0;
		padding: 3px 4px;
		border: none;
		outline: none;
		background: transparent;
		color: var(--ink);
		font: 12px/1.4 var(--font);
	}

	.terminal-find-count {
		min-width: 3em;
		padding: 0 4px;
		color: var(--muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: right;
		white-space: nowrap;
	}

	.terminal-find button {
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}

	.terminal-find button:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	/* Desktop has a real keyboard; this row is for the phone. */
	.terminal-keys {
		display: none;
	}

	.terminal-empty {
		padding: 24px 16px;
		color: var(--muted);
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
		color: var(--danger);
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
			border-top: 1px solid var(--line);
			scrollbar-width: none;
		}

		.terminal-keys button {
			flex: 1 1 auto;
			min-width: 44px;
			max-width: 72px;
			min-height: 40px;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: transparent;
			color: inherit;
			font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		}
	}
</style>
