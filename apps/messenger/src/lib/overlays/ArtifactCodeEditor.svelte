<script lang="ts">
	// Monaco's CSS (editor.main.css plus the hover/contextview widget styles) is loaded lazily,
	// alongside the Monaco JS itself below, so it never lands in the page's own stylesheet — it
	// used to be roughly half of that file's bytes even though Monaco's JS was already dynamic.
	import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
	import type { Annotation } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import { decorationClass, isEmptyRange, rangeForAnnotation, wholeLineRange, type EditorRange } from '../annotations/text-range.ts';
	import {
		applyMonacoTheme,
		ensureMonaco,
		MONACO_EDITOR_BASE_OPTIONS,
		monacoLanguageFromPath,
		monacoThemeName,
		prepareMonacoLanguage,
		shouldHighlightMonaco,
	} from './artifact-monaco.ts';
	import { themeManager, type ResolvedTheme } from '../theme.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';

	type MonacoApi = typeof Monaco;

	interface Props {
		code: string;
		path: string;
		wrap: boolean;
		onDirty?: (dirty: boolean) => void;
		/** This file's annotations: drawn as gutter marks and inline ranges. */
		annotations?: Annotation[];
		/** The one to scroll to and flash, when a card or a row was clicked. */
		focusAnnotationId?: string | null;
		/** Bumped on every request to go to `focusAnnotationId`: the one already focused is shown again. */
		focusAnnotationSeq?: number;
		/**
		 * What is on disk. The buffer is unsaved whenever it differs from this — also right after the
		 * editor is made from a buffer carried over from the rendered view. Left out, what it was made with.
		 */
		baseline?: string | null;
		/** Whether a selection offers the annotate button, and what it says. */
		annotateEnabled?: boolean;
		annotateLabel?: string;
		onAnnotate?: (range: EditorRange, text: string) => void;
		/** A click on a drawn annotation. */
		onPickAnnotation?: (id: string) => void;
		/** Test seam: how Monaco is loaded; happy-dom cannot run the real one. */
		loadMonaco?: () => Promise<MonacoApi>;
	}

	let {
		code,
		path,
		wrap,
		onDirty,
		annotations = [],
		focusAnnotationId = null,
		focusAnnotationSeq = 0,
		baseline = null,
		annotateEnabled = false,
		annotateLabel = '',
		onAnnotate,
		onPickAnnotation,
		loadMonaco = ensureMonaco,
	}: Props = $props();
	let host = $state<HTMLDivElement | undefined>(undefined);
	let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	/** Set once the editor exists, so decoration effects re-run for it. */
	let editorReady = $state(0);
	let saved = $state('');
	let dirty = $state(false);
	let decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
	let flash: Monaco.editor.IEditorDecorationsCollection | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	let annotateWidget: Monaco.editor.IContentWidget | null = null;
	let annotateNode: HTMLButtonElement | null = null;
	let widgetPosition: Monaco.IPosition | null = null;
	let widgetShown = false;
	/** The drawn ranges by annotation id, for a click to find which one it landed on. */
	let drawn: Array<{ id: string; range: EditorRange }> = [];
	/**
	 * The annotation behind each margin mark, in the order the marks were set (every annotation
	 * adds a highlight, then its mark): the marks move with edits, so a click asks Monaco where they are now.
	 */
	let markIds: string[] = [];

	/** Scroll to one annotation and flash it. Idempotent for an id the file does not hold. */
	export function revealAnnotation(id: string): void {
		const view = editor;
		if (!view) return;
		const row = annotations.find((item) => item.id === id);
		// Where the highlight is now (Monaco carries it with edits), else where the anchor says.
		const k = markIds.indexOf(id);
		const live = k >= 0 ? decorations?.getRanges()[2 * k] : undefined;
		const range = live ?? (row ? rangeForAnnotation(row, view.getValue()) : null);
		if (!range) return;
		view.revealRangeInCenterIfOutsideViewport(range);
		flash?.set([{ range, options: { className: 'rb-annot-flash', isWholeLine: false } }]);
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => flash?.clear(), 1400);
	}

	function drawAnnotations(view: Monaco.editor.IStandaloneCodeEditor, rows: Annotation[]): void {
		const text = view.getValue();
		const next: Monaco.editor.IModelDeltaDecoration[] = [];
		drawn = [];
		markIds = [];
		for (const row of rows) {
			const range = rangeForAnnotation(row, text);
			if (!range) continue;
			drawn.push({ id: row.id, range });
			const cls = decorationClass(row);
			next.push({ range, options: { className: cls, hoverMessage: { value: row.body }, stickiness: 1 } });
			// One mark per annotation, at its first character: a range's own glyph repeats on every
			// wrapped row of every line it covers.
			const at = { startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.startLineNumber, endColumn: range.startColumn };
			next.push({ range: at, options: { glyphMarginClassName: `rb-annot-glyph ${cls}`, glyphMarginHoverMessage: { value: row.body }, stickiness: 1 } });
			markIds.push(row.id);
		}
		decorations?.set(next);
	}

	function annotationAt(position: Monaco.IPosition): string | null {
		for (const item of drawn) {
			const { range } = item;
			const afterStart = position.lineNumber > range.startLineNumber || (position.lineNumber === range.startLineNumber && position.column >= range.startColumn);
			const beforeEnd = position.lineNumber < range.endLineNumber || (position.lineNumber === range.endLineNumber && position.column <= range.endColumn);
			if (afterStart && beforeEnd) return item.id;
		}
		return null;
	}

	function showAnnotateButton(view: Monaco.editor.IStandaloneCodeEditor, at: Monaco.IPosition | null): void {
		widgetPosition = at;
		if (!annotateWidget) return;
		if (at && widgetShown) view.layoutContentWidget(annotateWidget);
		else if (at) view.addContentWidget(annotateWidget);
		else if (widgetShown) view.removeContentWidget(annotateWidget);
		widgetShown = at !== null;
	}

	function currentRange(view: Monaco.editor.IStandaloneCodeEditor): EditorRange | null {
		const sel = view.getSelection();
		if (!sel) return null;
		const range = { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.endLineNumber, endColumn: sel.endColumn };
		return isEmptyRange(range) ? null : range;
	}

	export function getValue(): string {
		return editor?.getValue() ?? code;
	}

	export function isDirty(): boolean {
		return dirty;
	}

	export function markSaved(next = getValue()): void {
		saved = next;
		dirty = false;
		onDirty?.(false);
	}

	export function revert(value: string): void {
		editor?.setValue(value);
		// What the model holds after its line-ending folding, or a no-op edit would read as unsaved.
		markSaved(editor?.getValue() ?? value);
	}

	export function openFind(): void {
		editor?.focus();
		void editor?.getAction('actions.find')?.run();
	}

	export function openReplace(): void {
		editor?.focus();
		void editor?.getAction('editor.action.startFindReplaceAction')?.run();
	}

	export function findNext(): void {
		void editor?.getAction('editor.action.nextMatchFindAction')?.run();
	}

	export function findPrevious(): void {
		void editor?.getAction('editor.action.previousMatchFindAction')?.run();
	}

	export function isFindOpen(): boolean {
		const widget = host?.querySelector('.editor-widget.find-widget');
		return Boolean(widget?.classList.contains('visible'));
	}

	export function closeFind(): boolean {
		if (!isFindOpen()) return false;
		editor?.trigger('keyboard', 'closeFindWidget', null);
		editor?.focus();
		return true;
	}

	$effect(() => {
		const el = host;
		if (!el) return;
		const file = path;
		const doc = untrack(() => code);
		const wrapOn = untrack(() => wrap);
		let cancelled = false;
		let created: Monaco.editor.IStandaloneCodeEditor | null = null;
		let sub: Monaco.IDisposable | null = null;
		let themeUnsub: (() => void) | null = null;
		// `automaticLayout` remeasures on every resize observation. A divider drag used to do
		// that for every visible editor, every frame. One layout when the drag ends.
		const stopResize = onPaneResize(el, () => created?.layout());
		void (async () => {
			try {
				// The editor and its stylesheet arrive together: nothing here reads the CSS
				// import's value, but it must resolve before `monaco.editor.create` paints below,
				// or the editor mounts unstyled for a frame. `loadMonaco` is `ensureMonaco` outside
				// tests (happy-dom cannot run the real editor).
				const [monaco] = await Promise.all([
					loadMonaco(),
					import('monaco-editor-css'),
					import('monaco-editor/esm/vs/platform/hover/browser/hover.css'),
					import('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css'),
				]);
				if (cancelled || !el.isConnected) return;
				const lang = monacoLanguageFromPath(file);
				created = monaco.editor.create(el, {
					value: doc,
					language: 'plaintext',
					theme: monacoThemeName(themeManager.resolved),
					readOnly: false,
					wordWrap: wrapOn ? 'on' : 'off',
					// The column for annotation marks, only while the file has some: a file nobody
					// annotated keeps its code where it always was.
					glyphMargin: untrack(() => annotations.length > 0),
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					fontSize: 12,
					fontFamily: 'var(--mono)',
					renderLineHighlight: 'line',
					tabSize: 2,
					padding: { top: 8 },
					contextmenu: true,
					...MONACO_EDITOR_BASE_OPTIONS,
					automaticLayout: false,
				});
				editor = created;
				// Made from a buffer the rendered view carried over, it is as unsaved as it was there.
				saved = untrack(() => baseline) ?? doc;
				// Monaco folds mixed or lone-CR line endings when it builds the model: a clean buffer is
				// measured against what the model holds, or it would read as edited before any edit; a
				// carried one against the disk text folded the same way.
				if (doc === saved) saved = created.getValue();
				else if (typeof monaco.editor.createModel === 'function') {
					const folded = monaco.editor.createModel(saved);
					saved = folded.getValue();
					folded.dispose();
				}
				dirty = created.getValue() !== saved;
				onDirty?.(dirty);
				created.layout();
				sub = created.onDidChangeModelContent(() => {
					const next = created?.getValue() ?? '';
					const isDirtyNow = next !== saved;
					dirty = isDirtyNow;
					onDirty?.(isDirtyNow);
				});
				decorations = created.createDecorationsCollection();
				flash = created.createDecorationsCollection();
				// The annotate button floats by the selection's end, inside the editor's own DOM
				// so the pane's Escape and shortcut guards treat it as part of the editor.
				const node = document.createElement('button');
				node.type = 'button';
				node.className = 'rb-annotate-btn';
				node.textContent = annotateLabel;
				node.addEventListener('mousedown', (ev) => ev.preventDefault());
				node.addEventListener('click', () => {
					const view = editor;
					const range = view ? currentRange(view) : null;
					if (!view || !range) return;
					onAnnotate?.(range, view.getValue());
					showAnnotateButton(view, null);
				});
				annotateNode = node;
				const widget: Monaco.editor.IContentWidget = {
					getId: () => 'real-bot.annotate',
					getDomNode: () => node,
					getPosition: () => (widgetPosition ? { position: widgetPosition, preference: [2, 1] } : null),
				};
				annotateWidget = widget;
				created.onDidChangeCursorSelection(() => {
					const view = editor;
					if (!view) return;
					const range = annotateEnabled && onAnnotate ? currentRange(view) : null;
					showAnnotateButton(view, range ? { lineNumber: range.endLineNumber, column: range.endColumn } : null);
				});
				created.onMouseDown((ev) => {
					const view = editor;
					if (!view) return;
					const type = ev.target.type;
					// A tap on a line number selects the line: what a touch selection cannot be trusted to do.
					if (type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && ev.target.position && annotateEnabled) {
						const range = wholeLineRange(view.getValue(), ev.target.position.lineNumber);
						view.setSelection(range);
						return;
					}
					// The mark in the margin opens its annotation; a click in the text is only a click in
					// the text (placing the cursor must not scroll a long range back to its top).
					if (type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && ev.target.position) {
						// A margin hit reports column 1; the mark sits on its range's first line — wherever
						// edits since it was drawn have moved that line.
						const line = ev.target.position.lineNumber;
						const ranges = decorations?.getRanges() ?? [];
						const k = markIds.findIndex((_, i) => ranges[2 * i + 1]?.startLineNumber === line);
						if (k >= 0) onPickAnnotation?.(markIds[k]!);
					}
				});
				editorReady += 1;
				applyMonacoTheme(monaco.editor);
				themeUnsub = themeManager.subscribe(() => {
					applyMonacoTheme(monaco.editor, themeManager.resolved as ResolvedTheme);
				});
				if (lang !== 'plaintext') {
					await prepareMonacoLanguage(lang, doc);
					if (cancelled || !created) return;
					const model = created.getModel();
					if (model) monaco.editor.setModelLanguage(model, lang);
					if (shouldHighlightMonaco(doc, lang)) applyMonacoTheme(monaco.editor);
				}
			} catch {
				editor = null;
			}
		})();
		return () => {
			cancelled = true;
			stopResize();
			sub?.dispose();
			themeUnsub?.();
			if (flashTimer) clearTimeout(flashTimer);
			decorations = null;
			flash = null;
			annotateWidget = null;
			annotateNode = null;
			widgetShown = false;
			created?.dispose();
			if (editor === created) editor = null;
		};
	});

	$effect(() => {
		const rows = annotations;
		const ready = editorReady;
		const view = editor;
		if (!ready || !view) return;
		drawAnnotations(view, rows);
	});

	$effect(() => {
		const label = annotateLabel;
		if (annotateNode) annotateNode.textContent = label;
	});

	$effect(() => {
		const enabled = annotateEnabled;
		const view = editor;
		if (!enabled && view) showAnnotateButton(view, null);
	});

	$effect(() => {
		const id = focusAnnotationId;
		void focusAnnotationSeq;
		const ready = editorReady;
		if (!id || !ready) return;
		// After the decorations for this batch of rows are on screen.
		queueMicrotask(() => revealAnnotation(id));
	});

	$effect(() => {
		const wrapOn = wrap;
		editor?.updateOptions({ wordWrap: wrapOn ? 'on' : 'off' });
	});

	$effect(() => {
		const marks = annotations.length > 0;
		editor?.updateOptions({ glyphMargin: marks });
	});

	// A new `code` (the file read again) replaces a buffer with nothing unsaved in it. Only a new
	// `code` runs this: `dirty` going false is the person's own edits matching the disk again.
	$effect(() => {
		const doc = code;
		const view = editor;
		if (!view || untrack(() => dirty)) return;
		if (view.getValue() !== doc) {
			view.setValue(doc);
			saved = untrack(() => baseline) ?? doc;
			if (doc === saved) saved = view.getValue();
			dirty = view.getValue() !== saved;
			onDirty?.(dirty);
		}
	});
</script>

<div class="artifact-cm-wrap min-h-[280px] flex-1 h-full relative flex flex-col">
	<pre class="artifact-text artifact-cm-fallback absolute inset-0 z-0 m-0 py-4 px-6 overflow-auto bg-pane pointer-events-none">{code}</pre>
	<div class="artifact-cm" bind:this={host}></div>
</div>

<style>

	.artifact-cm {
		min-height: 0;
		flex: 1;
		height: 100%;
		position: relative;
		z-index: 1;
	}

	.artifact-cm-wrap:has(:global(.monaco-editor)) .artifact-cm-fallback {
		display: none;
	}

	.artifact-cm :global(.monaco-editor),

	.artifact-cm :global(.monaco-editor-background),

	.artifact-cm :global(.monaco-editor) :global(.margin) {
		background: var(--pane);
		--vscode-editorHoverWidget-background: var(--pane);
		--vscode-editorHoverWidget-foreground: var(--ink);
		--vscode-editorHoverWidget-border: var(--line);
		--vscode-editorWidget-background: var(--pane);
		--vscode-editorWidget-foreground: var(--ink);
		--vscode-widget-border: var(--line);
		--vscode-input-background: var(--input-bg);
		--vscode-input-foreground: var(--ink);
		--vscode-focusBorder: var(--accent);
		--vscode-errorForeground: var(--danger);
	}

	.artifact-cm :global(.find-widget) {
		z-index: 10;
	}

	/*
	 * Monaco sizes the widget to one row (or two once replace is open) and clips the rest.
	 * `overflow: visible` lets a mis-measured row paint over the source. A pane narrower than
	 * the widget's 419px default collapses it and hides the match buttons; keep them.
	 */
	.artifact-cm :global(.monaco-editor) :global(.find-widget) {
		max-width: min(419px, calc(100% - 16px)) !important;
	}

	.artifact-cm :global(.monaco-editor) :global(.find-widget.collapsed-find-widget),

	.artifact-cm :global(.monaco-editor) :global(.find-widget.narrow-find-widget),

	.artifact-cm :global(.monaco-editor) :global(.find-widget.reduced-find-widget) {
		max-width: min(419px, calc(100% - 16px)) !important;
	}

	.artifact-cm :global(.monaco-editor) :global(.find-widget.collapsed-find-widget) :global(.button.previous),

	.artifact-cm :global(.monaco-editor) :global(.find-widget.collapsed-find-widget) :global(.button.next),

	.artifact-cm :global(.monaco-editor) :global(.find-widget.collapsed-find-widget) > :global(.find-part) :global(.monaco-findInput) :global(.controls) {
		display: flex;
	}

	/*
	 * The replace chevron and the close button are absolutely placed on the widget. A blanket
	 * `position: relative` on every button pulled them into the row, so the replace line and
	 * its actions spilled onto the source.
	 */
	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.button:not(.toggle):not(.codicon-widget-close)),

	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.monaco-custom-toggle) {
		position: relative;
	}

	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.button:hover::after),

	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.monaco-custom-toggle:hover::after) {
		content: attr(aria-label);
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		z-index: 60;
		padding: 4px 8px;
		font-family: var(--font);
		font-size: 12px;
		font-weight: 400;
		line-height: 16px;
		white-space: nowrap;
		color: var(--ink);
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-md);
		pointer-events: none;
		transform: translateX(-50%);
	}

	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.button.toggle.left:hover::after) {
		left: 0;
		transform: none;
	}

	.artifact-cm :global(.cm-editor) {
		height: 100%;
	}

	/* An annotation: a tinted range in the text, a mark in the gutter; a dashed one is stale. */
	.artifact-cm :global(.rb-annot) {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
	}
	.artifact-cm :global(.rb-annot-draft) {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-bottom-style: dotted;
	}
	.artifact-cm :global(.rb-annot-resolved) {
		background: color-mix(in srgb, var(--muted) 16%, transparent);
		border-bottom-color: color-mix(in srgb, var(--muted) 60%, transparent);
	}
	.artifact-cm :global(.rb-annot.is-stale) {
		border-bottom-style: dashed;
	}
	.artifact-cm :global(.rb-annot-glyph) {
		background: none;
		border-bottom: 0;
	}
	.artifact-cm :global(.rb-annot-glyph)::after {
		content: '';
		position: absolute;
		left: 4px;
		top: 50%;
		width: 8px;
		height: 8px;
		margin-top: -4px;
		border-radius: 50%;
		background: var(--accent);
	}
	.artifact-cm :global(.rb-annot-glyph.rb-annot-draft)::after {
		background: transparent;
		border: 2px solid var(--accent);
		width: 6px;
		height: 6px;
	}
	.artifact-cm :global(.rb-annot-glyph.rb-annot-resolved)::after {
		background: var(--muted);
	}
	.artifact-cm :global(.rb-annot-flash) {
		background: color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.artifact-cm :global(.rb-annotate-btn) {
		margin: 4px 0 0 -2px;
		padding: 2px 10px;
		border: 1px solid var(--accent-border);
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		line-height: 20px;
		white-space: nowrap;
		cursor: pointer;
		box-shadow: var(--shadow-md);
	}
	@media (max-width: 680px) {
		.artifact-cm :global(.rb-annotate-btn) {
			line-height: 32px;
			padding: 4px 14px;
		}
	}

	.artifact-text {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		line-height: 1.5;
	}
</style>
