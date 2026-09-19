<script lang="ts">
	import 'monaco-editor-css';
	import 'monaco-editor/esm/vs/platform/hover/browser/hover.css';
	import 'monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css';
	import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
	import { untrack } from 'svelte';
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

	interface Props {
		code: string;
		path: string;
		wrap: boolean;
		onDirty?: (dirty: boolean) => void;
	}

	let { code, path, wrap, onDirty }: Props = $props();
	let host = $state<HTMLDivElement | undefined>(undefined);
	let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	let saved = $state('');
	let dirty = $state(false);

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
		markSaved(value);
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
		void (async () => {
			try {
				const monaco = await ensureMonaco();
				if (cancelled || !el.isConnected) return;
				const lang = monacoLanguageFromPath(file);
				created = monaco.editor.create(el, {
					value: doc,
					language: 'plaintext',
					theme: monacoThemeName(themeManager.resolved),
					readOnly: false,
					wordWrap: wrapOn ? 'on' : 'off',
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					fontSize: 12,
					fontFamily: 'var(--mono)',
					automaticLayout: true,
					renderLineHighlight: 'line',
					tabSize: 2,
					padding: { top: 8 },
					contextmenu: true,
					...MONACO_EDITOR_BASE_OPTIONS,
				});
				editor = created;
				saved = doc;
				dirty = false;
				onDirty?.(false);
				created.layout();
				sub = created.onDidChangeModelContent(() => {
					const next = created?.getValue() ?? '';
					const isDirtyNow = next !== saved;
					dirty = isDirtyNow;
					onDirty?.(isDirtyNow);
				});
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
			sub?.dispose();
			themeUnsub?.();
			created?.dispose();
			if (editor === created) editor = null;
		};
	});

	$effect(() => {
		const wrapOn = wrap;
		editor?.updateOptions({ wordWrap: wrapOn ? 'on' : 'off' });
	});

	$effect(() => {
		const doc = code;
		const view = editor;
		if (!view || dirty) return;
		if (view.getValue() !== doc) {
			view.setValue(doc);
			saved = doc;
			onDirty?.(false);
		}
	});
</script>

<div class="artifact-cm-wrap">
	<pre class="artifact-text artifact-cm-fallback">{code}</pre>
	<div class="artifact-cm" bind:this={host}></div>
</div>

<style>
	.artifact-cm-wrap {
		min-height: 280px;
		flex: 1;
		height: 100%;
		position: relative;
		display: flex;
		flex-direction: column;
	}

	.artifact-cm {
		min-height: 0;
		flex: 1;
		height: 100%;
		position: relative;
		z-index: 1;
	}

	.artifact-cm-fallback {
		position: absolute;
		inset: 0;
		z-index: 0;
		margin: 0;
		padding: 8px 12px;
		overflow: auto;
		background: var(--pane);
		pointer-events: none;
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

	.artifact-cm :global(.monaco-editor) :global(.find-widget) {
		overflow: visible;
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

	.artifact-cm :global(.monaco-editor) :global(.find-widget) :global(.button),
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

	.artifact-text {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		line-height: 1.5;
	}
</style>
