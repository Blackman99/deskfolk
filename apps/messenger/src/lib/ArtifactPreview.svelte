<script lang="ts">
	import type { Attachment } from '@real-bot/protocol';
	import type { Copy } from './copy.ts';
	import type { LocalApi } from './api.ts';
	import {
		absWorkspacePath,
		artifactByteSource,
		artifactKind,
		htmlPreviewBlob,
		HTML_PREVIEW_SANDBOX,
		injectHtmlPreviewColorScheme,
		injectHtmlPreviewNonce,
		isInAppPreviewKind,
		pageCspNonce,
		stripSvgActiveContent,
		type ArtifactKind,
	} from './artifacts.ts';
	import {
		buildCitedPathTree,
		mergeWorkspaceChildren,
		workspaceEntriesToNodes,
		type ArtifactTreeNode,
	} from './artifact-tree.ts';
	import ArtifactTree from './ArtifactTree.svelte';
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';
	import FileIcon from './FileIcon.svelte';
	import { fileIconFor } from './file-icon.ts';
	import { markdownCode } from './code-blocks.ts';
	import { copyText } from './clipboard.ts';
	import { highlightLangFromPath, highlightLangLabel } from './highlight-lang.ts';
	import { renderMarkdown } from './markdown.ts';
	import { openWorkspacePath } from './open-workspace.ts';
	import {
		clampArtifactTreeWidth,
		loadArtifactTreeWidth,
		saveArtifactTreeWidth,
	} from './artifact-tree-width.ts';
	import { themeManager } from './theme.ts';
	import { onDestroy, untrack } from 'svelte';

	interface Props {
		attachment: Attachment | null;
		relpath: string;
		siblings: Attachment[];
		api: LocalApi | null;
		workspacePath: string | null;
		t: Copy;
		onClose: () => void;
		onSelect: (att: Attachment) => void;
		mode?: 'cited' | 'workspace';
		onSelectWorkspacePath?: (path: string) => void;
	}

	let {
		attachment,
		relpath,
		siblings,
		api,
		workspacePath,
		t,
		onClose,
		onSelect,
		mode = 'cited',
		onSelectWorkspacePath,
	}: Props = $props();

	let blobUrl = $state<string | null>(null);
	let text = $state<string | null>(null);
	let htmlSrc = $state<string | null>(null);
	let missing = $state(false);
	let openHint = $state(false);
	let wrap = $state(true);
	let showSource = $state(false);
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let liveBlob: string | null = null;
	let liveHtml: string | null = null;
	let loadGen = 0;
	let lastSourcePath = $state('');
	let editor = $state<{
		getValue: () => string;
		isDirty: () => boolean;
		markSaved: (next?: string) => void;
		revert: (value: string) => void;
		openFind: () => void;
		openReplace: () => void;
		findNext: () => void;
		findPrevious: () => void;
		isFindOpen: () => boolean;
		closeFind: () => boolean;
	} | null>(null);
	let dirty = $state(false);
	let saving = $state(false);
	let saveError = $state(false);
	let pendingNav = $state<null | { kind: 'close' } | { kind: 'node'; node: ArtifactTreeNode }>(null);
	let treeWidth = $state(loadArtifactTreeWidth());
	let treeDragging = $state(false);
	let paneEl = $state<HTMLElement | null>(null);
	let resolvedTheme = $state(themeManager.resolved);
	let kind = $derived(
		artifactKind(attachment?.original_filename ?? relpath, { isDir: attachment?.is_dir === true })
	);
	let citedTree = $derived(buildCitedPathTree(siblings.map((row) => row.workspace_relpath)));
	let workspaceTree = $state<ArtifactTreeNode[]>([]);
	let loadedDirs = $state(new Set<string>());
	let truncatedHint = $state(false);
	let tree = $derived(mode === 'workspace' ? workspaceTree : citedTree);
	let showTree = $derived(
		mode === 'workspace' || tree.length > 1 || tree.some((node) => node.kind === 'dir')
	);
	let textLang = $derived(highlightLangFromPath(relpath));
	let codeLabels = $derived({ copy: t.chat.copyCode, copied: t.chat.copied });
	let icon = $derived(fileIconFor(relpath, { isDir: kind === 'directory' }));
	let titleName = $derived(
		attachment?.original_filename ??
			(relpath ? (relpath.split('/').pop() ?? relpath) : t.stream.workspaceExplorer)
	);
	let canShowSource = $derived(kind === 'text' || kind === 'markdown' || kind === 'html');
	let sourceMode = $derived(kind === 'text' || (canShowSource && showSource));
	let byteSource = $derived(artifactByteSource({ mode, relpath, attachment }));
	let canOpenOnDisk = $derived(
		Boolean(workspacePath) && Boolean(relpath) && kind !== 'directory' && !missing
	);
	let canSave = $derived(Boolean(api && relpath && canShowSource && sourceMode && text !== null));

	$effect(() => {
		const path = relpath;
		const previewKind = kind;
		const source = byteSource;
		void attachment?.id;
		const att = untrack(() => attachment);
		void loadPreview(path, previewKind, source, att);
	});

	$effect(() => {
		return themeManager.subscribe(() => {
			resolvedTheme = themeManager.resolved;
		});
	});

	$effect(() => {
		const path = relpath;
		if (path === lastSourcePath) return;
		lastSourcePath = path;
		showSource = false;
	});

	$effect(() => {
		if (mode !== 'workspace' || !api) {
			workspaceTree = [];
			loadedDirs = new Set();
			truncatedHint = false;
			return;
		}
		if (loadedDirs.has('.')) return;
		void loadWorkspaceDir('.');
	});

	onDestroy(() => {
		revoke();
		if (copiedTimer) clearTimeout(copiedTimer);
	});

	function publishHtml(raw: string, scheme: "light" | "dark" = resolvedTheme): void {
		const next = URL.createObjectURL(
			htmlPreviewBlob(
				injectHtmlPreviewNonce(injectHtmlPreviewColorScheme(raw, scheme), pageCspNonce()),
			),
		);
		if (liveHtml) URL.revokeObjectURL(liveHtml);
		liveHtml = next;
		htmlSrc = next;
	}

	$effect(() => {
		const scheme = resolvedTheme;
		const raw = text;
		if (kind !== 'html' || raw == null) return;
		publishHtml(raw, scheme);
	});

	function revoke(): void {
		if (liveBlob) URL.revokeObjectURL(liveBlob);
		if (liveHtml) URL.revokeObjectURL(liveHtml);
		liveBlob = null;
		liveHtml = null;
		blobUrl = null;
		htmlSrc = null;
	}

	async function loadWorkspaceDir(dirPath: string): Promise<void> {
		if (!api) return;
		try {
			const page = await api.workspaceTree(dirPath === '.' ? '' : dirPath);
			const children = workspaceEntriesToNodes(page.items);
			if (dirPath === '.' || dirPath === '') {
				workspaceTree = children;
			} else {
				workspaceTree = mergeWorkspaceChildren(workspaceTree, dirPath, children, page.truncated);
			}
			const next = new Set(loadedDirs);
			next.add(dirPath === '' ? '.' : dirPath);
			loadedDirs = next;
			if (page.truncated) truncatedHint = true;
		} catch {
			truncatedHint = false;
		}
	}

	async function loadPreview(
		path: string,
		previewKind: ArtifactKind,
		source: ReturnType<typeof artifactByteSource>,
		att: Attachment | null,
	): Promise<void> {
		const gen = ++loadGen;
		missing = false;
		openHint = false;
		if (!source || !api || previewKind === 'directory' || !isInAppPreviewKind(previewKind)) {
			if (gen !== loadGen) return;
			revoke();
			text = null;
			return;
		}
		try {
			const blob =
				source === 'attachment' && att
					? await api.getAttachmentBlob(att.id)
					: await api.getWorkspaceFileBlob(path);
			if (gen !== loadGen) return;
			if (previewKind === 'text' || previewKind === 'markdown' || previewKind === 'svg') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				if (previewKind === 'svg') {
					const cleaned = stripSvgActiveContent(raw);
					const next = URL.createObjectURL(new Blob([cleaned], { type: 'image/svg+xml' }));
					if (liveBlob) URL.revokeObjectURL(liveBlob);
					liveBlob = next;
					blobUrl = next;
					text = null;
				} else {
					text = raw;
				}
				return;
			}
			if (previewKind === 'html') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				text = raw;
				publishHtml(raw);
				return;
			}
			const next = URL.createObjectURL(blob);
			if (liveBlob) URL.revokeObjectURL(liveBlob);
			liveBlob = next;
			blobUrl = next;
			text = null;
		} catch {
			if (gen !== loadGen) return;
			missing = true;
		}
	}

	async function download(): Promise<void> {
		if (!api || !relpath || kind === 'directory') return;
		try {
			const blob =
				byteSource === 'attachment' && attachment
					? await api.getAttachmentBlob(attachment.id)
					: await api.getWorkspaceFileBlob(relpath);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = attachment?.original_filename ?? relpath.split('/').pop() ?? relpath;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch {
			missing = true;
		}
	}

	async function openSystem(reveal = false): Promise<void> {
		const abs = workspacePath ? absWorkspacePath(workspacePath, relpath) : null;
		if (!abs) {
			openHint = true;
			return;
		}
		const ok = await openWorkspacePath(abs, reveal);
		if (!ok) {
			openHint = true;
			if (!reveal && kind !== 'directory') await download();
		}
	}

	function selectNode(node: ArtifactTreeNode): void {
		if (mode === 'workspace' && node.kind === 'dir') return;
		if (dirty) {
			pendingNav = { kind: 'node', node };
			return;
		}
		commitSelect(node);
	}

	function commitSelect(node: ArtifactTreeNode): void {
		if (mode === 'workspace') {
			onSelectWorkspacePath?.(node.path);
			return;
		}
		const next = siblings.find((row) => row.workspace_relpath === node.path);
		if (next) onSelect(next);
	}

	function requestClose(): void {
		if (dirty) {
			pendingNav = { kind: 'close' };
			return;
		}
		onClose();
	}

	async function save(): Promise<boolean> {
		if (!api || !relpath || !canSave) return false;
		saving = true;
		saveError = false;
		try {
			const value = editor?.getValue() ?? text ?? '';
			await api.putWorkspaceFile(relpath, value);
			text = value;
			editor?.markSaved(value);
			dirty = false;
			return true;
		} catch {
			saveError = true;
			return false;
		} finally {
			saving = false;
		}
	}

	async function confirmSave(): Promise<void> {
		const nav = pendingNav;
		const ok = await save();
		if (!ok) return;
		pendingNav = null;
		if (nav?.kind === 'close') onClose();
		else if (nav?.kind === 'node') commitSelect(nav.node);
	}

	function confirmDiscard(): void {
		const nav = pendingNav;
		pendingNav = null;
		editor?.revert(text ?? '');
		dirty = false;
		if (nav?.kind === 'close') onClose();
		else if (nav?.kind === 'node') commitSelect(nav.node);
	}

	export function closeFind(): boolean {
		return editor?.closeFind() ?? false;
	}

	export function requestCloseFromParent(): void {
		requestClose();
	}

	function startTreeResize(ev: PointerEvent): void {
		if (!showTree) return;
		ev.preventDefault();
		treeDragging = true;
		const originX = ev.clientX;
		const originW = treeWidth;
		const onMove = (move: PointerEvent) => {
			const paneW = paneEl?.clientWidth ?? 480;
			treeWidth = clampArtifactTreeWidth(originW + (move.clientX - originX), paneW);
		};
		const onUp = () => {
			treeDragging = false;
			saveArtifactTreeWidth(treeWidth);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function onPaneKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape' && closeFind()) {
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
		const mod = ev.metaKey || ev.ctrlKey;
		if (!mod || ev.altKey) return;
		const key = ev.key.toLowerCase();
		if (!ev.shiftKey && key === 's') {
			if (!canSave) return;
			ev.preventDefault();
			ev.stopPropagation();
			void save();
			return;
		}
		if (!sourceMode || !editor) return;
		if (!ev.shiftKey && key === 'f') {
			ev.preventDefault();
			ev.stopPropagation();
			editor.openFind();
		}
	}

	function copySource(): void {
		const value = editor?.getValue() ?? text;
		if (value == null) return;
		copyText(value);
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copied = false;
		}, 1800);
	}

</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
	class="artifact-pane"
	class:is-tree-dragging={treeDragging}
	aria-label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactPreview}
	bind:this={paneEl}
	style:--artifact-tree-width="{treeWidth}px"
	onkeydown={onPaneKey}
>
	<header class="artifact-pane-head">
		<div class="artifact-pane-titles">
			<div class="artifact-pane-title-row">
				<FileIcon {icon} size={16} />
				<h2 class:is-dirty={dirty}>{titleName}</h2>
			</div>
			<p class="mono">{relpath || (workspacePath ?? '')}</p>
		</div>
		<button type="button" class="modal-close" title={t.common.close} onclick={requestClose}>✕</button>
	</header>
	{#if canShowSource || canOpenOnDisk}
		<div class="artifact-toolbar">
			{#if canShowSource}
				<span class="artifact-code-meta mono">{highlightLangLabel(textLang)}</span>
				{#if sourceMode}
					<button
						type="button"
						class="artifact-tool-btn"
						class:is-on={wrap}
						onclick={() => (wrap = !wrap)}
					>{t.stream.artifactWrap}</button>
					<button
						type="button"
						class="artifact-tool-btn"
						onclick={() => editor?.openFind()}
					>{t.stream.artifactFind}</button>
				{/if}
				{#if kind === 'markdown' || kind === 'html'}
					<button
						type="button"
						class="artifact-tool-btn"
						class:is-on={!showSource}
						onclick={() => {
							if (editor) text = editor.getValue();
							showSource = false;
						}}
					>{t.stream.artifactRendered}</button>
					<button
						type="button"
						class="artifact-tool-btn"
						class:is-on={showSource}
						onclick={() => (showSource = true)}
					>{t.stream.artifactSource}</button>
				{/if}
				{#if sourceMode}
					<button
						type="button"
						class="artifact-tool-btn"
						onclick={() => void save()}
						disabled={!dirty || saving || !relpath}
					>{saving ? t.stream.artifactSaving : t.stream.artifactSave}</button>
				{/if}
				<button type="button" class="artifact-tool-btn" onclick={copySource} disabled={text == null}>
					{copied ? t.chat.copied : t.chat.copyCode}
				</button>
			{/if}
			{#if canOpenOnDisk}
				<button type="button" class="artifact-tool-btn" onclick={() => void openSystem(false)}>{t.stream.artifactOpenSystem}</button>
				<button type="button" class="artifact-tool-btn" onclick={() => void openSystem(true)}>{t.stream.artifactReveal}</button>
			{/if}
		</div>
	{/if}
	{#if saveError}
		<p class="muted artifact-save-error">{t.stream.artifactSaveFailed}</p>
	{/if}
	<div class="artifact-pane-main" class:has-tree={showTree}>
		{#if showTree}
			<ArtifactTree
				nodes={tree}
				selected={relpath}
				label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactTree}
				onSelect={selectNode}
				lazyDirs={mode === 'workspace'}
				{loadedDirs}
				onExpandDir={(path) => void loadWorkspaceDir(path)}
				truncatedLabel={t.stream.workspaceTruncated}
			/>
			<button
				type="button"
				class="artifact-tree-split"
				aria-label={t.stream.artifactTreeResize}
				onpointerdown={startTreeResize}
			></button>
		{/if}
		<div class="artifact-pane-body" class:is-editor={sourceMode && text !== null}>
			{#if truncatedHint && mode === 'workspace'}
				<p class="muted">{t.stream.workspaceTruncated}</p>
			{/if}
			{#if missing}
				<p class="muted">{t.stream.artifactMissing}</p>
			{:else if mode === 'workspace' && !relpath}
				<p class="muted">{t.stream.workspacePickFile}</p>
			{:else if kind === "directory"}
				<p class="muted">{mode === 'workspace' ? t.stream.workspaceEmpty : t.stream.artifactDirectory}</p>
			{:else if sourceMode}
				{#if text !== null}
					<ArtifactCodeEditor
						bind:this={editor}
						code={text}
						path={relpath}
						{wrap}
						onDirty={(next) => (dirty = next)}
					/>
				{/if}
			{:else if kind === "image" || kind === "svg"}
				{#if blobUrl}
					<img src={blobUrl} alt={relpath} class="artifact-img" />
				{/if}
			{:else if kind === "audio" && blobUrl}
				<audio controls src={blobUrl}></audio>
			{:else if kind === "video" && blobUrl}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video controls src={blobUrl}></video>
			{:else if kind === "pdf" && blobUrl}
				<iframe title={relpath} class="artifact-frame" src={blobUrl}></iframe>
			{:else if kind === "html" && htmlSrc}
				<iframe
					title={relpath}
					class="artifact-frame"
					src={htmlSrc}
					sandbox={HTML_PREVIEW_SANDBOX}
					referrerpolicy="no-referrer"
					style:color-scheme={resolvedTheme}
				></iframe>
			{:else if kind === "markdown" && text !== null}
				<div class="artifact-md" use:markdownCode={codeLabels}>{@html renderMarkdown(text)}</div>
			{:else}
				<p class="muted">{attachment?.original_filename ?? relpath}</p>
			{/if}
			{#if openHint}
				<p class="muted">{t.stream.artifactOpenUnavailable}</p>
			{/if}
		</div>
	</div>
</aside>
{#if pendingNav}
	<div class="modal-backdrop confirm-backdrop" role="presentation">
		<div class="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-dirty-title">
			<div class="modal-body">
				<h3 id="artifact-dirty-title">{t.stream.artifactDirtyTitle}</h3>
				<p class="confirm-copy">{t.stream.artifactDirtyBody}</p>
			</div>
			<div class="modal-foot artifact-dirty-foot">
				<button type="button" onclick={() => (pendingNav = null)}>{t.sidebar.cancel}</button>
				<button type="button" onclick={confirmDiscard}>{t.stream.artifactDiscard}</button>
				<button type="button" class="artifact-dirty-save" onclick={() => void confirmSave()}>{t.stream.artifactSave}</button>
			</div>
		</div>
	</div>
{/if}
