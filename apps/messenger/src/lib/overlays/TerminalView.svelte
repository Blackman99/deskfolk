<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { Terminal as TerminalRow, StreamFrame, TerminalScreenSnapshot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { copyText, readClipboardText } from '../clipboard.ts';
	import { openExternalLink } from '../open-link.ts';
	import { registerPaneEdit } from '../workbench/pane-edit.ts';
	import {
		arrowBytes,
		controlByte,
		macEditingBytes,
		terminalShortcut,
		type Arrow,
		type TerminalShortcut
	} from './terminal-keys.ts';
	import {
		documentTheme,
		findDecorations,
		minimumContrast,
		terminalColors,
		terminalTheme
	} from './terminal-theme.ts';
	import { terminalFontSize } from './terminal-font.svelte.ts';
	import { silenceRequests } from './terminal-requests.ts';
	import { swipeAsWheel } from './terminal-touch.ts';
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
		TERMINAL_KEY_ROWS,
		terminalNames,
		tildePath,
		type PhoneKey,
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

	/** The phone page's two menus: the session list under the title, and ⋯. */
	let switcherOpen = $state(false);
	let moreOpen = $state(false);
	/** The bar's Ctrl: on for the next key, from the bar or the software keyboard, then off. */
	let ctrlArmed = $state(false);
	/** Whether the shell has the keyboard. On a phone that is whether the software keyboard is up. */
	let keyboardUp = $state(false);
	/** An arrow held down on the bar repeats, as a key on a keyboard does. */
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	/** The press already sent this key on the way down; the click that ends it must not again. */
	let sentOnPress: string | null = null;

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

	/**
	 * xterm's public class keeps the viewport on a private core, created during `open`. A macOS
	 * scrollbar that measures as nothing is still given 15px; zero that before fit, or the
	 * columns stop short of the pane.
	 */
	function claimNoScrollbar(opened: import('@xterm/xterm').Terminal): void {
		const core = (opened as unknown as { _core?: { viewport?: { scrollBarWidth: number } } })._core;
		if (core?.viewport) core.viewport.scrollBarWidth = 0;
	}
	let fit: import('@xterm/addon-fit').FitAddon | null = null;
	let search: import('@xterm/addon-search').SearchAddon | null = null;
	let stopFit: (() => void) | null = null;
	let stopTheme: (() => void) | null = null;
	let stopEdit: (() => void) | null = null;
	let stopQuiet: (() => void) | null = null;
	let stopSwipe: (() => void) | null = null;
	/**
	 * What pressed last anywhere in the pane: a link's activation arrives as a plain mouse event
	 * either way, and a finger is what must not be handed a keyboard it did not ask for.
	 */
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
	/** Which attach is the current one. One a later switch overtook must leave the page alone. */
	let attachSeq = 0;
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
		claimNoScrollbar(term);
		// A finger has no wheel, and a full-screen program's history only moves by one.
		stopSwipe = swipeAsWheel(host, term);
		loadGpuRenderer(term, WebglAddon);
		fit.fit();
		term.onData((data) => {
			// Typing here takes the size back from the phone, or whichever other client last
			// showed this session: the pty fits the screen you are using, as tmux's "latest" does.
			if (active && term && (active.rows !== term.rows || active.cols !== term.cols)) resizeToFit();
			// The bar's Ctrl applies to one key typed on the software keyboard. A paste or a
			// composed word is not a key, and leaves it on for the key that comes after.
			if (ctrlArmed && data.length === 1) {
				ctrlArmed = false;
				data = controlByte(data) ?? data;
			}
			// Bytes, not keystrokes: `^C` is 0x03 and the pty's line discipline owns what that means.
			input?.push(new TextEncoder().encode(data));
		});
		host.addEventListener('focusin', () => (keyboardUp = true));
		host.addEventListener('focusout', (event) => {
			if (!(event.relatedTarget instanceof Node && host?.contains(event.relatedTarget))) keyboardUp = false;
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
		releaseKey();
		stopFit?.();
		stopFit = null;
		stopTheme?.();
		stopTheme = null;
		stopEdit?.();
		stopEdit = null;
		stopQuiet?.();
		stopQuiet = null;
		stopSwipe?.();
		stopSwipe = null;
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
		if (!touchFirst()) term?.focus();
	}

	/** The page's Back and Escape close the bar first. True when there was one to close. */
	export function closeFindBar(): boolean {
		if (!findOpen) return false;
		closeFind();
		return true;
	}

	/** The session list and ⋯ close before the page does. True when one was open. */
	export function closeMenus(): boolean {
		if (!switcherOpen && !moreOpen) return false;
		switcherOpen = false;
		closeMore();
		return true;
	}

	/**
	 * Whether what just happened was a finger. Handing the shell the focus then raises the
	 * software keyboard over half the screen, so after a tap only a tap on the terminal itself, or
	 * the bar's keyboard key, does it.
	 */
	function touchFirst(): boolean {
		return lastPointer === 'touch';
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

	/**
	 * Paste from the right-click menu or the phone's bar. Into the shell as a paste, so
	 * bracketed-paste mode holds. The bar's leaves the keyboard as it was.
	 */
	async function pasteClipboard(refocus = true): Promise<void> {
		const text = await readClipboardText();
		if (text && term && active?.status === 'live') term.paste(text);
		if (refocus) term?.focus();
	}

	/**
	 * A key on the phone's bar. It never takes the focus: the bar stops the press from moving it,
	 * and nothing here hands it to the shell, so a tap with the keyboard down leaves it down and
	 * one with it up leaves it up. The keyboard key is the one that changes that, on purpose.
	 */
	function pressKey(key: PhoneKey): void {
		switch (key.kind) {
			case 'ctrl':
				ctrlArmed = !ctrlArmed;
				return;
			case 'keyboard':
				if (keyboardUp) term?.blur();
				else term?.focus();
				return;
			case 'paste':
				void pasteClipboard(false);
				return;
			case 'arrow':
				sendArrow(key.arrow, takeCtrl());
				return;
			case 'bytes':
				// Its own bytes already say what it is; Ctrl-Esc and Ctrl-Tab have no other meaning.
				takeCtrl();
				input?.push(new TextEncoder().encode(key.bytes));
				return;
		}
	}

	function takeCtrl(): boolean {
		const was = ctrlArmed;
		ctrlArmed = false;
		return was;
	}

	function sendArrow(arrow: Arrow, ctrl: boolean): void {
		const application = term?.modes.applicationCursorKeysMode ?? false;
		input?.push(new TextEncoder().encode(arrowBytes(arrow, { application, ctrl })));
	}

	/** An arrow goes on the way down and then repeats while held; the click at the end is spent. */
	function holdKey(event: PointerEvent, key: PhoneKey): void {
		sentOnPress = null;
		if (key.kind !== 'arrow' || event.button !== 0) return;
		releaseKey();
		const ctrl = takeCtrl();
		sendArrow(key.arrow, ctrl);
		sentOnPress = key.id;
		const repeat = (delay: number) => {
			holdTimer = setTimeout(() => {
				sendArrow(key.arrow, ctrl);
				repeat(60);
			}, delay);
		};
		repeat(400);
	}

	function releaseKey(): void {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = null;
	}

	function clickKey(key: PhoneKey): void {
		if (sentOnPress === key.id) {
			sentOnPress = null;
			return;
		}
		pressKey(key);
	}

	/**
	 * Anything but the bar and the menus closes the menus, the terminal included. Read on the way
	 * down: by the time a tap bubbles to the window, 结束会话 has already swapped itself for its
	 * confirm, and a button that is off the page is inside nothing — the menu closed on every tap.
	 */
	function onWindowClick(event: MouseEvent): void {
		if (!switcherOpen && !moreOpen) return;
		const target = event.target instanceof Element ? event.target : null;
		// Back closes these itself, and only then the page. Closing them here would make one
		// tap do both, because this listener runs before the button's own.
		if (target?.closest('.terminal-back')) return;
		if (switcherOpen && !target?.closest('.terminal-switch')) switcherOpen = false;
		if (moreOpen && !target?.closest('.terminal-more')) closeMore();
	}

	function closeMore(): void {
		moreOpen = false;
		endConfirmId = null;
	}

	function fromMenu(action: () => void): void {
		closeMore();
		action();
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
		const attempt = ++attachSeq;
		const current = () => attempt === attachSeq;
		detach();
		activeId = id;
		input = id && api
			? new InputQueue((bytes) => api.terminalInput(id, encodeBase64(bytes)), report)
			: null;
		cursor = startCursor();
		pending = [];
		filling = false;
		term?.reset();
		if (!id || !api) return;
		filling = true;
		attached = id;
		unwatch = onStream(id, (frame) => {
			const bytes = decodeBase64(frame.data);
			if (filling) {
				pending.push({ offset: frame.offset, bytes });
				return;
			}
			write(frame.offset, bytes);
		});
		try {
			// Read first, then watch from where the read ends. The daemon's ring still holds every
			// byte since, so none fall between the two. Watching from 0 had it send the whole ring
			// again, only for all of it to be cut here: over a phone's link, the first second or
			// so of every attach.
			const screen = await readScreen(id);
			const history = screen ? null : await api.terminalScrollback(id, 0);
			if (!current()) return;
			const historyBytes = history ? decodeBase64(history.data) : new Uint8Array(0);
			await api.watchTerminal(id, screen ? screen.offset : (history?.offset ?? 0) + historyBytes.length);
			if (!current()) return;
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
				write(history.offset, historyBytes);
			}
			term?.write('', () => {
				if (replay === replaySeq) replaying = false;
			});
			for (const frame of pending) write(frame.offset, frame.bytes);
			tellColors(id);
		} catch (cause) {
			report(cause);
		} finally {
			// A switch that overtook this attach owns the page now. Clearing its state from here let
			// its live frames in ahead of its screen, as a gap the size of the whole stream.
			if (current()) {
				pending = [];
				filling = false;
				resizeToFit();
			}
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
			if (!touchFirst()) term?.focus();
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

<svelte:window onclickcapture={onWindowClick} />

<div
	class="terminal-pane"
	class:is-gathered={!single}
	onpointerdowncapture={(event) => (lastPointer = event.pointerType)}
>
	<header class="terminal-head">
		{#if !single}
			<!--
				The phone's page, one screen high: Back, which shell this is and where, a new one, and
				everything else behind ⋯. The tabs a desktop has would not fit a thumb's width here, so
				the title is the switch between them.
			-->
			<button type="button" class="terminal-icon terminal-back" aria-label={t.common.back} title={t.common.back} onclick={onClose}>
				<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<div class="terminal-switch">
				<button
					type="button"
					class="terminal-title"
					aria-haspopup="menu"
					aria-expanded={switcherOpen}
					aria-label={t.terminal.sessions}
					disabled={ordered.length < 2}
					onclick={() => {
						closeMore();
						switcherOpen = !switcherOpen;
					}}
				>
					<span class="terminal-title-name">
						<span class="terminal-title-text">{active ? (names.get(active.id) ?? active.title) : t.terminal.title}</span>
						{#if ordered.length > 1}
							<span class="terminal-title-count">{ordered.length}</span>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
						{/if}
					</span>
					{#if active}
						{@const label = statusLabel(active, t)}
						<span class="terminal-title-where" title={active.cwd}>
							{tildePath(active.cwd)}{#if label}<span class="terminal-tab-status"> · {label}</span>{/if}
						</span>
					{/if}
				</button>
				{#if switcherOpen}
					<div class="terminal-menu terminal-sessions" role="menu" aria-label={t.terminal.sessions}>
						{#each ordered as row (row.id)}
							{@const label = statusLabel(row, t)}
							<button
								type="button"
								role="menuitemradio"
								aria-checked={row.id === activeId}
								class="terminal-tab"
								class:is-active={row.id === activeId}
								class:is-done={row.status !== 'live'}
								title={row.cwd}
								onclick={() => {
									switcherOpen = false;
									void activate(row.id);
								}}
							>
								<span class="terminal-tab-name">{names.get(row.id) ?? row.title}</span>
								<span class="terminal-tab-where">{tildePath(row.cwd)}{#if label} · {label}{/if}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<button
				type="button"
				class="terminal-icon terminal-add"
				aria-label={t.terminal.newTab}
				title={t.terminal.newTab}
				disabled={!workspacePath || busy}
				onclick={() => {
					switcherOpen = false;
					closeMore();
					void create();
				}}
			>
				<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
			</button>
			{#if active}
				<div class="terminal-more">
					<button
						type="button"
						class="terminal-icon"
						class:is-active={moreOpen}
						aria-haspopup="menu"
						aria-expanded={moreOpen}
						aria-label={t.terminal.more}
						title={t.terminal.more}
						onclick={() => {
							switcherOpen = false;
							if (moreOpen) closeMore();
							else moreOpen = true;
						}}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
					</button>
					{#if moreOpen}
						<div class="terminal-menu" role="menu" aria-label={t.terminal.more}>
							{#if active.status === 'live'}
								<button type="button" role="menuitem" onclick={() => fromMenu(() => void stop())}>{t.terminal.stop}</button>
							{/if}
							<button type="button" role="menuitem" onclick={() => fromMenu(openFind)}>{t.terminal.find}</button>
							<button type="button" role="menuitem" onclick={() => fromMenu(() => runShortcut('clear'))}>{t.terminal.clear}</button>
							<!-- Stays open: text size is something you step until it looks right. -->
							<div class="terminal-menu-font" role="group" aria-label={t.terminal.fontSize}>
								<span>{t.terminal.fontSize}</span>
								<button type="button" aria-label={t.terminal.fontSmaller} title={t.terminal.fontSmaller} onclick={() => terminalFontSize.step(-1)}>A−</button>
								<span class="terminal-menu-font-size">{terminalFontSize.current}</span>
								<button type="button" aria-label={t.terminal.fontBigger} title={t.terminal.fontBigger} onclick={() => terminalFontSize.step(1)}>A+</button>
							</div>
							<div class="terminal-menu-sep" role="separator"></div>
							{#if endConfirmId === active.id}
								<p class="terminal-confirm">{t.terminal.endConfirm}</p>
								<div class="terminal-menu-confirm">
									<button type="button" onclick={closeMore}>{t.detail.cancel}</button>
									<button
										type="button"
										class="terminal-end is-armed"
										onclick={() => {
											const id = active.id;
											closeMore();
											void close(id);
										}}>{t.terminal.end}</button
									>
								</div>
							{:else}
								<button
									type="button"
									role="menuitem"
									class="terminal-end"
									onclick={() => {
										if (active.status === 'live') endConfirmId = active.id;
										else fromMenu(() => void close(active.id));
									}}>{t.terminal.end}</button
								>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		{:else}
			<!-- The tab above already carries the title; here is where the shell is and how it is. -->
			<div class="terminal-where">
				{#if active}
					{@const label = statusLabel(active, t)}
					<span class="terminal-cwd" title={active.cwd}>{active.cwd}</span>
					{#if label}<span class="terminal-tab-status">{label}</span>{/if}
				{/if}
			</div>
		{/if}
		{#if single}
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
			</div>
		{/if}
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
			A software keyboard has no Ctrl, no Tab, no arrows and no Escape, so without this bar a
			phone could watch a command run but never stop one. Bytes straight into the queue. The
			press is kept from moving the focus: a tap on a key must not raise the keyboard, nor
			drop it when it is up.
		-->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="terminal-keys"
			role="toolbar"
			tabindex="-1"
			aria-label={t.terminal.keys}
			onmousedown={(event) => event.preventDefault()}
			ontouchstart={() => {}}
		>
			{#each TERMINAL_KEY_ROWS as keys, row (row)}
				<div class="terminal-keys-row">
					{#each keys as key (key.id)}
						<button
							type="button"
							class="terminal-key"
							class:is-action={key.kind === 'paste' || key.kind === 'keyboard'}
							class:is-glyph={'label' in key && key.label.length === 1}
							class:is-armed={key.kind === 'ctrl' && ctrlArmed}
							aria-pressed={key.kind === 'ctrl' ? ctrlArmed : key.kind === 'keyboard' ? keyboardUp : undefined}
							aria-label={key.kind === 'paste'
								? t.terminal.paste
								: key.kind === 'keyboard'
									? keyboardUp
										? t.terminal.hideKeyboard
										: t.terminal.showKeyboard
									: key.kind === 'ctrl'
										? t.terminal.ctrl
										: undefined}
							data-key={key.id}
							onpointerdown={(event) => holdKey(event, key)}
							onpointerup={releaseKey}
							onpointercancel={releaseKey}
							onpointerleave={releaseKey}
							onclick={() => clickKey(key)}
						>
							{#if key.kind === 'paste'}
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg>
							{:else if key.kind === 'keyboard'}
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<rect x="2" y="4" width="20" height="12" rx="2"></rect>
									<path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M7 12h10"></path>
									{#if keyboardUp}<polyline points="9 19 12 22 15 19"></polyline>{:else}<polyline points="9 22 12 19 15 22"></polyline>{/if}
								</svg>
							{:else}
								{key.label}
							{/if}
						</button>
					{/each}
				</div>
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
	.terminal-stop {
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

	/* xterm keeps a classic scrollbar (`overflow-y: scroll`). On macOS that is a white bar down
	   the dark pane. The wheel still scrolls the viewport; only the bar is gone. */
	.terminal-host :global(.xterm-viewport) {
		overflow-y: hidden;
		scrollbar-width: none;
	}

	.terminal-host :global(.xterm-viewport)::-webkit-scrollbar {
		width: 0;
		height: 0;
		display: none;
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

	/* A real keyboard has all of these; the bar is for a finger. */
	.terminal-keys {
		display: none;
	}

	/* The phone's page: Back, the shell and where it is, a new one, and ⋯. */
	.is-gathered .terminal-head {
		position: relative;
		/* Over the terminal, so the menus that drop from it are too. */
		z-index: 10;
		justify-content: flex-start;
		gap: 2px;
		min-height: 56px;
		/* The notch above, and the rounded corners on either side in landscape. */
		padding: env(safe-area-inset-top) max(4px, env(safe-area-inset-right)) 0 max(4px, env(safe-area-inset-left));
	}

	/* A thumb, not a mouse: the same 44px every other target on a phone screen gets. */
	.terminal-icon {
		flex: 0 0 auto;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.terminal-icon:active,
	.terminal-icon.is-active {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.terminal-icon:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.terminal-switch,
	.terminal-more {
		position: relative;
	}

	.terminal-switch {
		flex: 1;
		min-width: 0;
	}

	.terminal-more {
		flex: 0 0 auto;
	}

	.terminal-title {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 4px 6px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	/* One shell has nothing to switch to; the title is just a title then. */
	.terminal-title:disabled {
		color: var(--ink);
		cursor: default;
	}

	.terminal-title:not(:disabled):active {
		background: var(--line-subtle);
	}

	.terminal-title-name {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		font-size: 16px;
		font-weight: 600;
		line-height: 21px;
	}

	.terminal-title-text,
	.terminal-title-where,
	.terminal-tab-name,
	.terminal-tab-where {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.terminal-title-count {
		flex: 0 0 auto;
		min-width: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		text-align: center;
	}

	.terminal-title-name svg {
		flex: 0 0 auto;
		color: var(--muted);
	}

	.terminal-title-where,
	.terminal-tab-where {
		color: var(--muted);
		font: 12px/17px var(--mono);
	}

	.terminal-tab-status {
		font-size: 11px;
		opacity: 0.75;
	}

	.terminal-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 224px;
		padding: 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
	}

	.terminal-sessions {
		right: auto;
		left: 0;
		width: min(320px, calc(100vw - 64px));
		max-height: 60dvh;
		overflow-y: auto;
	}

	.terminal-menu > button,
	.terminal-menu-confirm button {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 14px;
		text-align: left;
		cursor: pointer;
	}

	.terminal-menu > button:hover,
	.terminal-menu > button:active {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.terminal-menu > .terminal-tab {
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 1px;
		padding: 6px 12px;
	}

	.terminal-tab-name {
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
	}

	.terminal-tab.is-active {
		background: var(--accent-tint);
	}

	.terminal-tab.is-active .terminal-tab-name {
		color: var(--accent);
	}

	.terminal-tab.is-done {
		opacity: 0.6;
	}

	.terminal-menu-font {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 44px;
		padding: 0 4px 0 12px;
		color: var(--ink-secondary);
		font-size: 14px;
	}

	.terminal-menu-font > span:first-child {
		flex: 1;
	}

	.terminal-menu-font button {
		width: 40px;
		height: 34px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.terminal-menu-font-size {
		min-width: 2.2em;
		color: var(--muted);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}

	.terminal-menu-sep {
		height: 1px;
		margin: 4px 6px;
		background: var(--line);
	}

	.terminal-menu .terminal-end {
		color: var(--danger);
	}

	.terminal-menu .terminal-confirm {
		margin: 0;
		padding: 4px 12px;
		white-space: normal;
		line-height: 1.5;
	}

	.terminal-menu-confirm {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}

	.terminal-menu-confirm button {
		justify-content: center;
		border: 1px solid var(--line);
	}

	.terminal-menu-confirm .is-armed {
		border-color: var(--danger);
		color: var(--danger);
	}

	.is-gathered .terminal-host {
		margin: 8px max(10px, env(safe-area-inset-right)) 8px max(10px, env(safe-area-inset-left));
	}

	/*
		Two rows of seven across the full width, so none sits off the edge of a 390px screen.
		Its bottom clears the home indicator, except while the keyboard is up and covers that:
		the page sets the inset to 0 then.
	*/
	@media (max-width: 720px), (pointer: coarse) {
		.terminal-keys {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 6px max(6px, env(safe-area-inset-right))
				calc(6px + var(--terminal-bottom-inset, env(safe-area-inset-bottom))) max(6px, env(safe-area-inset-left));
			border-top: 1px solid var(--line);
			outline: none;
			-webkit-user-select: none;
			user-select: none;
			-webkit-touch-callout: none;
		}

		.terminal-keys-row {
			display: grid;
			grid-template-columns: repeat(7, minmax(0, 1fr));
			gap: 6px;
		}

		.terminal-key {
			display: grid;
			place-items: center;
			min-width: 0;
			height: 40px;
			padding: 0;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: var(--btn-secondary-bg);
			box-shadow: 0 1px 0 var(--line);
			color: var(--ink);
			font: 500 13px/1 var(--mono);
			cursor: pointer;
			/* Two quick taps on ↓ are two keys, not a zoom. */
			touch-action: manipulation;
			-webkit-tap-highlight-color: transparent;
		}

		.terminal-key:active {
			background: var(--row-hover);
			box-shadow: none;
			transform: translateY(1px);
		}

		.terminal-key.is-action {
			color: var(--ink-secondary);
		}

		/* Arrows and ⏎ are a single glyph, which a monospace face draws at half the size of a letter. */
		.terminal-key.is-glyph {
			font: 500 18px/1 var(--font);
		}

		.terminal-key[data-key='keyboard'][aria-pressed='true'] {
			border-color: var(--accent-border);
			background: var(--accent-tint);
			color: var(--accent);
		}

		.terminal-key.is-armed {
			border-color: var(--accent);
			background: var(--accent);
			box-shadow: none;
			color: #fff;
		}
	}
</style>
