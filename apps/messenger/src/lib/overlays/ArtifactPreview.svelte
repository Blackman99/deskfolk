<script lang="ts">
	import type { Attachment, TaskArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { ApiError, etagForBlob } from '../api.ts';
	import type { MessengerApi } from '../messenger-api.ts';
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
		previewLoadKey,
		stripSvgActiveContent,
		svgDisplayBlob,
		type ArtifactKind,
	} from './artifacts.ts';
	import {
		buildCitedPathTree,
		buildTaskArtifactTree,
		mergeWorkspaceChildren,
		workspaceEntriesToNodes,
		type ArtifactTreeNode,
	} from './artifact-tree.ts';
	import ArtifactTree from './ArtifactTree.svelte';
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';
	import FileIcon from './FileIcon.svelte';
	import { fileIconFor } from './file-icon.ts';
	import { copyText } from '../clipboard.ts';
	import { highlightLangFromPath, highlightLangLabel } from '../highlight-lang.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { openWorkspacePath } from './open-workspace.ts';
	import {
		clampArtifactTreeWidth,
		loadArtifactTreeWidth,
		saveArtifactTreeWidth,
	} from './artifact-tree-width.ts';
	import { themeManager } from '../theme.ts';
	import { onDestroy, untrack } from 'svelte';

	interface Props {
		attachment: Attachment | null;
		relpath: string;
		siblings: Attachment[];
		api: MessengerApi | null;
		workspacePath: string | null;
		t: Copy;
		onClose: () => void;
		onSelect: (att: Attachment) => void;
		mode?: 'cited' | 'workspace';
		onSelectWorkspacePath?: (path: string) => void;
		forceTree?: boolean;
		/** The work dir this message belongs to; its whole job is listed, not just this message. */
		taskId?: string | null;
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
		forceTree = false,
		taskId = null,
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
	/** The key of the bytes on screen; a repeat of it must not swap the object URL. */
	let loadedKey: string | null = null;
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
	let saveConflict = $state(false);
	let loadedEtag = $state<string | null>(null);
	let pendingNav = $state<null | { kind: 'close' } | { kind: 'node'; node: ArtifactTreeNode }>(null);
	let treePreferred = $state(loadArtifactTreeWidth());
	let treeDragging = $state(false);
	/** Phone only: the list of files is one screen and the file itself is the next. */
	let mobileTab = $state<'file' | 'tree'>('file');
	const treeLabel = $derived(mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactTree);
	let paneEl = $state<HTMLElement | null>(null);
	let paneWidth = $state(Number.POSITIVE_INFINITY);
	const treeWidth = $derived(clampArtifactTreeWidth(treePreferred, paneWidth));

	$effect(() => {
		const el = paneEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const apply = () => {
			paneWidth = el.clientWidth || Number.POSITIVE_INFINITY;
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(el);
		return () => observer.disconnect();
	});
	let resolvedTheme = $state(themeManager.resolved);
	let kind = $derived(
		artifactKind(attachment?.original_filename ?? relpath, { isDir: attachment?.is_dir === true })
	);
	// Pulled once when the entry opens; there is no push event for it, the same as the route log.
	let taskArtifacts = $state<TaskArtifacts | null>(null);
	$effect(() => {
		const id = taskId;
		const client = api;
		if (!id || !client || mode === 'workspace') {
			taskArtifacts = null;
			return;
		}
		const controller = new AbortController();
		client
			.taskArtifacts(id, controller.signal)
			.then((rows) => {
				taskArtifacts = rows;
			})
			.catch(() => {
				// An entry that lists only this message is still a working entry.
				taskArtifacts = null;
			});
		return () => controller.abort();
	});

	let ownPaths = $derived(siblings.map((row) => row.workspace_relpath));
	/**
	 * The job's files, anchored at its work dir, with this message's own marked — relevance is
	 * "somebody cited it", so a file an earlier turn produced is still one click away. Falls back
	 * to this message alone when the job is unknown or the pull failed.
	 */
	let citedTree = $derived(
		taskArtifacts
			? buildTaskArtifactTree(
					taskArtifacts.dir,
					taskArtifacts.items.map((row) => row.path),
					ownPaths
				)
			: buildCitedPathTree(ownPaths)
	);
	let workspaceTree = $state<ArtifactTreeNode[]>([]);
	let loadedDirs = $state(new Set<string>());
	let truncatedHint = $state(false);
	let tree = $derived(mode === 'workspace' ? workspaceTree : citedTree);
	let showTree = $derived(
		mode === 'workspace' ||
			(forceTree && tree.length > 0) ||
			tree.length > 1 ||
			tree.some((node) => node.kind === 'dir')
	);
	let textLang = $derived(highlightLangFromPath(relpath));
	let icon = $derived(fileIconFor(relpath, { isDir: kind === 'directory' }));
	let titleName = $derived(
		attachment?.original_filename ??
			(relpath ? (relpath.split('/').pop() ?? relpath) : t.stream.workspaceExplorer)
	);
	let canShowSource = $derived(kind === 'text' || kind === 'markdown' || kind === 'html');
	let sourceMode = $derived(kind === 'text' || (canShowSource && showSource));
	let byteSource = $derived(artifactByteSource({ mode, relpath, attachment }));
	let remoteClient = $derived(api?.kind === 'remote');
	let canOpenOnDisk = $derived(
		!remoteClient && Boolean(workspacePath) && Boolean(relpath) && kind !== 'directory' && !missing
	);
	let canRemoteFile = $derived(remoteClient && Boolean(relpath) && kind !== 'directory' && !missing);
	let canSave = $derived(Boolean(api && relpath && canShowSource && sourceMode && text !== null));

	$effect(() => {
		const path = relpath;
		const previewKind = kind;
		const source = byteSource;
		const key = previewLoadKey({ path, kind: previewKind, source, attachmentId: attachment?.id });
		// Losing the citing message flips the source, not the file: reloading here would restart a
		// playing video every time you switch sessions or continue an interrupted turn.
		if (key !== null && key === loadedKey) return;
		loadedKey = key;
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
			loadedEtag = etagForBlob(blob);
			if (previewKind === 'text' || previewKind === 'markdown' || previewKind === 'svg') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				if (previewKind === 'svg') {
					const next = URL.createObjectURL(await svgDisplayBlob(raw));
					if (gen !== loadGen) return;
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
			loadedKey = null;
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
		// Picking a file is a request to look at it, not to stay in the list.
		if (node.kind !== 'dir') mobileTab = 'file';
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
		else onSelect({ workspace_relpath: node.path } as Attachment);
	}

	function openMarkdownPath(path: string): void {
		selectNode({
			name: path.split('/').pop() ?? path,
			path,
			kind: 'file'
		});
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
		saveConflict = false;
		try {
			const value = editor?.getValue() ?? text ?? '';
			loadedEtag = await api.putWorkspaceFile(relpath, value, loadedEtag);
			text = value;
			editor?.markSaved(value);
			dirty = false;
			return true;
		} catch (error) {
			saveConflict = error instanceof ApiError && error.status === 409;
			saveError = true;
			if (error instanceof ApiError && error.code === 'file_limit') missing = true;
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
			treePreferred = clampArtifactTreeWidth(originW + (move.clientX - originX), paneW);
		};
		const onUp = () => {
			treeDragging = false;
			saveArtifactTreeWidth(treePreferred);
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

	function copyRelpath(): void {
		if (!relpath) return;
		copyText(relpath);
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
	data-mobile-tab={mobileTab}
	class:is-tree-dragging={treeDragging}
	aria-label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactPreview}
	bind:this={paneEl}
	style:--artifact-tree-width="{treeWidth}px"
	onkeydown={onPaneKey}
>
	<header class="artifact-pane-head">
		{#if showTree}
			<button
				type="button"
				class="artifact-back"
				title={treeLabel}
				aria-label={treeLabel}
				onclick={() => (mobileTab = 'tree')}
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="15 18 9 12 15 6"></polyline>
				</svg>
			</button>
		{/if}
		<div class="artifact-pane-titles min-w-0">
			<div class="artifact-pane-title-row flex items-center gap-4 min-w-0">
				<FileIcon {icon} size={16} />
				<h2 class:is-dirty={dirty}>{titleName}</h2>
			</div>
			<p class="mono">{relpath || (workspacePath ?? '')}</p>
			<p class="artifact-list-title">{treeLabel}</p>
		</div>
		<button type="button" class="modal-close" title={t.common.close} onclick={requestClose}>✕</button>
	</header>
	{#if canShowSource || canOpenOnDisk || canRemoteFile}
		<div class="artifact-toolbar">
			{#if canShowSource}
				<span class="artifact-code-meta mono text-10 tracking-[0.04em] text-muted">{highlightLangLabel(textLang)}</span>
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
			{#if canRemoteFile}
				<button type="button" class="artifact-tool-btn" onclick={() => void download()}>{t.settings.downloadFile}</button>
				<button type="button" class="artifact-tool-btn" onclick={copyRelpath}>{t.settings.copyRelpath}</button>
			{/if}
		</div>
	{/if}
	{#if saveError}
		<p class="muted artifact-save-error pt-0 px-8 pb-3">{saveConflict ? t.stream.artifactSaveConflict : t.stream.artifactSaveFailed}</p>
	{/if}
	{#if remoteClient}
		<p class="muted artifact-save-error pt-0 px-8 pb-3">{t.settings.fileLimitRemote}</p>
	{/if}
	<div
		class="artifact-pane-main flex-1 min-h-0 min-w-0 flex"
		class:has-tree={showTree}
		data-mobile-tab={mobileTab}
	>
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
		<div class="artifact-pane-body flex-1 min-h-0 min-w-0 overflow-auto p-8" class:is-editor={sourceMode && text !== null}>
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
					<img src={blobUrl} alt={relpath} class="artifact-img max-w-full max-h-full block my-0 mx-auto" />
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
				<MarkdownBody
					source={text}
					copyLabel={t.chat.copyCode}
					copiedLabel={t.chat.copied}
					onOpenArtifact={openMarkdownPath}
					loadArtifactImage={(path) => {
						if (!api) return Promise.reject(new Error('API unavailable'));
						return api.getWorkspaceFileBlob(path);
					}}
				/>
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

<style>
	.artifact-pane {
		background: var(--pane);
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-left: 0;
	}

	/* Desktop shows the tree beside the file: no stepping back and forth. */
	.artifact-back,
	.artifact-list-title {
		display: none;
	}

	.artifact-pane-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px 10px;
		border-bottom: 1px solid var(--line);
	}

	.artifact-pane-title-row h2 {
		min-width: 0;
	}

	.artifact-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
	}

	.artifact-tool-btn {
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		border-radius: var(--radius-sm);
		padding: 2px 8px;
		font-size: 12px;
		color: var(--ink);
		cursor: pointer;
	}

	.artifact-tool-btn:hover:not(:disabled) {
		background: var(--btn-secondary-hover);
	}

	.artifact-tool-btn.is-on {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.artifact-tool-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.artifact-pane-body.is-editor {
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.artifact-pane-titles h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artifact-pane-titles p {
		margin: 4px 0 0;
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artifact-pane-main.has-tree {
		display: grid;
		grid-template-columns: var(--artifact-tree-width, 168px) 8px minmax(0, 1fr);
	}

	.artifact-tree-split {
		width: 8px;
		padding: 0;
		border: 0;
		cursor: col-resize;
		position: relative;
		background: transparent;
		z-index: 2;
	}

	.artifact-tree-split::before {
		content: "";
		position: absolute;
		inset: 0 3px;
		background: var(--line);
		border-radius: 99px;
	}

	.artifact-tree-split:hover::before,
	.artifact-pane.is-tree-dragging .artifact-tree-split::before {
		background: var(--accent);
		inset: 0 2px;
	}

	.artifact-pane-title-row :global(h2.is-dirty::after) {
		content: "•";
		margin-left: 6px;
		color: var(--accent);
	}

	.artifact-dirty-foot button:first-child {
		background: var(--btn-secondary-bg);
		color: var(--ink);
		border-color: var(--line);
		box-shadow: var(--shadow-xs);
	}

	.artifact-dirty-foot button:first-child:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.artifact-dirty-save {
		background: var(--accent) !important;
		color: #ffffff !important;
		border-color: transparent !important;
	}

	.artifact-frame {
		width: 100%;
		height: 100%;
		min-height: 280px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.artifact-pane-body audio,
	.artifact-pane-body video {
		width: 100%;
		max-height: 100%;
	}

@media (max-width: 680px) {
		/*
		 * On a phone this pane used to be dealt a second grid row under the composer, and then
		 * split its 390px between a tree and the file. It is a sheet now: it covers the
		 * conversation, and the file and the list of files take turns.
		 */
		.artifact-pane {
			padding-bottom: env(safe-area-inset-bottom);
			box-shadow: none;
		}

		.artifact-pane-head {
			padding: 12px 12px 10px;
		}

		.artifact-pane-head :global(.modal-close) {
			width: 40px;
			height: 40px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}

		/* Looking at a file is one step in from the list, and steps back the same way. */
		.artifact-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			height: 40px;
			margin-left: -6px;
			flex-shrink: 0;
			border-radius: var(--radius-md);
			color: var(--ink-secondary);
		}

		.artifact-pane[data-mobile-tab='tree'] .artifact-back,
		.artifact-pane[data-mobile-tab='tree'] .artifact-pane-title-row,
		.artifact-pane[data-mobile-tab='tree'] .artifact-pane-titles .mono,
		.artifact-pane[data-mobile-tab='tree'] .artifact-toolbar {
			display: none;
		}

		.artifact-pane[data-mobile-tab='tree'] .artifact-list-title {
			display: block;
			margin: 0;
			font-size: 14px;
			font-weight: 600;
			color: var(--ink);
		}

		.artifact-pane-main[data-mobile-tab='file'] :global(.artifact-tree) {
			display: none;
		}

		.artifact-pane-main[data-mobile-tab='tree'] .artifact-pane-body {
			display: none;
		}

		/* One column either way: the grid that splits tree from file is a desktop shape. */
		.artifact-pane-main.has-tree {
			display: flex;
			grid-template-columns: none;
		}

		.artifact-pane-main[data-mobile-tab='tree'] :global(.artifact-tree) {
			flex: 1;
			width: auto;
			max-width: none;
			border-right: 0;
		}

		/* Dragging a divider is a mouse idea. */
		.artifact-tree-split {
			display: none;
		}
	}
</style>
