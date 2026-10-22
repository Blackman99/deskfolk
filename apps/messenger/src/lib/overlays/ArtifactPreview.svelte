<script lang="ts">
	import Icon from '../Icon.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import BottomSheet from '../BottomSheet.svelte';
	import type {
		Annotation,
		Attachment,
		CreateAnnotationRequest,
		PatchAnnotationRequest,
		SessionSummary,
	} from '@real-bot/protocol';
	import { ANNOTATION_BATCH_MAX } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';
	import { ApiError } from '../api.ts';
	import AnnotationSendBar from '../annotations/AnnotationSendBar.svelte';
	import {
		ADAPTER_ANCHOR_KIND,
		adapterFor,
		annotateGate,
		destinationLabel,
		drawnAnnotations,
		type AnnotationTarget,
	} from '../annotations/model.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import {
		absWorkspacePath,
		artifactByteSource,
		artifactKind,
		citedInWorkspace,
		isInAppPreviewKind,
		type ArtifactKind,
	} from './artifacts.ts';
	import type { ArtifactTreeNode } from './artifact-tree.ts';
	import ArtifactTree from './ArtifactTree.svelte';
	import ArtifactTreeMenu from './ArtifactTreeMenu.svelte';
	import DangerDialog from './DangerDialog.svelte';
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';
	import MessageImageLightbox, { type ImageOrigin } from '../chat/MessageImageLightbox.svelte';
	import { openWorkspacePath } from './open-workspace.ts';
	import FileDownload from './FileDownload.svelte';
	import { isTauri } from '../tauri.ts';
	import { copyText } from '../clipboard.ts';
	import {
		clampArtifactTreeWidth,
		loadArtifactTreeWidth,
		saveArtifactTreeWidth,
	} from './artifact-tree-width.ts';
	import { themeManager } from '../theme.ts';
	import { onDestroy, untrack, type ComponentProps } from 'svelte';
	import { ArtifactAnnotations } from './artifact-annotations.svelte.ts';
	import { ArtifactLoader } from './artifact-loader.svelte.ts';
	import { ArtifactTreeSource } from './artifact-tree-source.svelte.ts';
	import ArtifactAnnotBar from './ArtifactAnnotBar.svelte';
	import ArtifactBody from './ArtifactBody.svelte';
	import ArtifactDirtyDialog from './ArtifactDirtyDialog.svelte';
	import { trackPointerDrag } from '../pointer-drag.ts';
	import { baseName } from '../paths.ts';

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
		/** Starts a terminal in this folder (absolute); without it the tree offers none. */
		onOpenTerminal?: (dir: string) => void;
		forceTree?: boolean;
		/** One file and nothing beside it: a file opened over the whole app has no tree, however deep. */
		noTree?: boolean;
		/** The job the flow chart opened this from: its whole job is listed, not just this step. */
		taskId?: string | null;
		/** A project session's directory, when this is its preview: a file inside it is shown in that folder's tree. */
		projectDir?: string | null;
		/** 挂到谁：the Bot message this preview hangs on; null means nothing can be annotated here. */
		target?: AnnotationTarget | null;
		/** Every annotation the runtime holds; the pane keeps this file's. */
		annotations?: Annotation[];
		annotationFocusId?: string | null;
		/** The file this path resolves to, as the daemon names it; rows on other spellings of it show too. */
		annotationFileKey?: string | null;
		bots?: ReadonlyMap<string, { name: string }>;
		locale?: 'zh' | 'en';
		sessions?: SessionSummary[];
		viewedSessionId?: string | null;
		onLoadAnnotations?: (relpath: string) => void;
		onCreateAnnotation?: (input: CreateAnnotationRequest) => Promise<ApiError | null>;
		onPatchAnnotation?: (id: string, patch: PatchAnnotationRequest) => Promise<ApiError | null>;
		onDeleteAnnotation?: (id: string) => Promise<ApiError | null>;
		onSendAnnotations?: (sessionId: string, summary: string, ids: string[]) => Promise<ApiError | null>;
		/** Test seam: how the source editor loads Monaco; happy-dom cannot run the real one. */
		loadMonaco?: ComponentProps<typeof ArtifactCodeEditor>['loadMonaco'];
		/**
		 * The pane is a whole screen of its own: the phone flow, whatever the window width. A hosted
		 * tablet has no workbench tab to name or close this pane, so it gets the phone's bar back.
		 */
		sheet?: boolean;
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
		onOpenTerminal,
		forceTree = false,
		noTree = false,
		taskId = null,
		projectDir = null,
		target = null,
		annotations = [],
		annotationFocusId = null,
		annotationFileKey = null,
		bots = new Map(),
		locale = 'zh',
		sessions = [],
		viewedSessionId = null,
		onLoadAnnotations,
		onCreateAnnotation,
		onPatchAnnotation,
		onDeleteAnnotation,
		onSendAnnotations,
		loadMonaco,
		sheet = false,
	}: Props = $props();

	/**
	 * A picture enlarged over the whole app, the way one in a message is: this file when it is an
	 * image (`own`, shown from the bytes already here), or an image in this Markdown. Only while
	 * the preview still shows the file it was opened from, so it never outlives what it borrows.
	 */
	let enlarged = $state<{ from: string; relpath: string; own: boolean; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
	const shownEnlarged = $derived(enlarged?.from === relpath ? enlarged : null);
	let wrap = $state(true);
	let showSource = $state(false);
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
		revealAnnotation: (id: string) => void;
	} | null>(null);
	/** The source editor's word on its buffer, which it compares with `diskText`. */
	let editorDirty = $state(false);
	const loader = new ArtifactLoader({
		api: () => api,
		relpath: () => relpath,
		attachment: () => attachment,
		kind: () => kind,
		byteSource: () => byteSource
	});
	const annot = new ArtifactAnnotations({
		relpath: () => relpath,
		mode: () => mode,
		target: () => target,
		annotations: () => annotations,
		annotationFocusId: () => annotationFocusId,
		annotationFileKey: () => annotationFileKey,
		workspacePath: () => workspacePath,
		viewedSessionId: () => viewedSessionId,
		onLoadAnnotations: () => onLoadAnnotations,
		onCreateAnnotation: () => onCreateAnnotation,
		onPatchAnnotation: () => onPatchAnnotation,
		onDeleteAnnotation: () => onDeleteAnnotation,
		onSendAnnotations: () => onSendAnnotations,
		t: () => t,
		gate: () => gate,
		contentSha: () => loader.contentSha,
		kind: () => kind,
		reducedFrom: () => loader.reducedFrom,
		loadOriginal: () => loader.loadOriginal()
	});
	let saving = $state(false);
	let saveError = $state(false);
	let saveConflict = $state(false);
	let pdfViewer = $state<{ openFind: () => void; closeFind: () => boolean } | null>(null);
	let pendingNav = $state<
		| null
		| { kind: 'close'; afterClose?: () => void }
		| { kind: 'node'; node: ArtifactTreeNode }
		| { kind: 'leave'; after: () => void }
	>(null);
	let treePreferred = $state(loadArtifactTreeWidth());
	let treeDragging = $state(false);
	/** Phone only: the list drops down over the top of the preview, which stays put. */
	let treeOpen = $state(false);
	/**
	 * As narrow as the pane stacks (680px, where the list button shows), the list opens as a sheet
	 * from the bottom (`BottomSheet`) rather than dropping over the file. The sheet goes when a
	 * file is picked, so the folders opened in it are kept here; a new listing starts them over,
	 * as the `{#key}` around the tree does.
	 */
	const stacked = new MediaQuery('(max-width: 680px)');
	let treeCollapsed = $state(new Set<string>());
	let treeExpanded = $state(new Set<string>());
	$effect(() => {
		void treeSrc.treeGeneration;
		untrack(() => {
			treeCollapsed = new Set();
			treeExpanded = new Set();
		});
	});
	// A project's file opens with the folders down to it open; after the reset above, which a new listing also runs.
	$effect(() => {
		void treeSrc.treeGeneration;
		const dirs = treeSrc.revealDirs;
		untrack(() => {
			if (dirs.some((dir) => !treeExpanded.has(dir))) treeExpanded = new Set([...treeExpanded, ...dirs]);
		});
	});
	let paneEl = $state<HTMLElement | null>(null);
	let paneWidth = $state(Number.POSITIVE_INFINITY);
	const treeWidth = $derived(clampArtifactTreeWidth(treePreferred, paneWidth));

	$effect(() => {
		const el = paneEl;
		if (!el) return;
		const apply = () => {
			paneWidth = el.clientWidth || Number.POSITIVE_INFINITY;
		};
		apply();
		return onPaneResize(el, apply);
	});
	let resolvedTheme = $state(themeManager.resolved);
	const treeSrc: ArtifactTreeSource = new ArtifactTreeSource({
		api: () => api,
		mode: () => mode,
		taskId: () => taskId,
		siblings: () => siblings,
		workspacePath: () => workspacePath,
		relpath: () => relpath,
		dirty: () => dirty,
		t: () => t,
		onOpenTerminal: () => onOpenTerminal,
		showGone: () => loader.showGone(),
		projectDir: () => projectDir
	});
	const treeLabel = $derived(
		mode === 'workspace'
			? t.stream.workspaceExplorer
			: treeSrc.projectRoot !== null
				? baseName(treeSrc.projectRoot) || treeSrc.projectRoot
				: t.stream.artifactTree
	);
	// A cited path the Mac listed is a folder too: a link can name one (`voice_samples/ja/`).
	let kind: ArtifactKind = $derived(
		artifactKind(attachment?.original_filename ?? relpath, {
			isDir: attachment?.is_dir === true || (mode !== 'workspace' && treeSrc.isDir(relpath))
		})
	);

	let showTree = $derived(
		!noTree &&
			(treeSrc.lazy ||
				forceTree || Boolean(taskId) ||
				treeSrc.tree.length > 1 ||
				treeSrc.tree.some((node) => node.kind === 'dir'))
	);
	let titleName = $derived(
		attachment?.original_filename ??
			(relpath ? (relpath.split('/').pop() ?? relpath) : t.stream.workspaceExplorer)
	);
	let canShowSource = $derived(kind === 'text' || kind === 'markdown' || kind === 'html');
	let sourceMode = $derived(kind === 'text' || (canShowSource && showSource));
	let byteSource = $derived(artifactByteSource({ mode, relpath, attachment }));
	let remoteClient = $derived(api?.kind === 'remote');
	/** A file shown only by name: the desktop window opens it with the system, anywhere else it downloads. */
	let opensOnDisk = $derived(!remoteClient && isTauri());
	/**
	 * Remotely every file shown can be downloaded, from the phone's bar and from the wide layout's.
	 * A file shown only by name has its own button in the middle instead.
	 */
	let canDownload = $derived(
		remoteClient && Boolean(relpath) && kind !== 'directory' && isInAppPreviewKind(kind) && attachment?.exists !== false && !loader.missing,
	);
	let downloadKey = $derived(`${byteSource}:${attachment?.id ?? ''}:${relpath}`);
	// The rendered view can hold an unsaved buffer carried over from the source view; the dirty
	// prompt's Save must be able to write it.
	/** A file opened from elsewhere on the Mac reads like any other, but saving and notes stay in the workspace. */
	const inWorkspace = $derived(citedInWorkspace(workspacePath, relpath, treeSrc.home));
	let canSave = $derived(Boolean(api && relpath && inWorkspace && canShowSource && loader.text !== null && (sourceMode || loader.text !== loader.diskText)));
	/**
	 * Unsaved: what is on screen differs from what is on disk — the editor's buffer in the source
	 * view, the text the rendered view shows otherwise. Not the editor's flag alone: a new editor
	 * made from a buffer the rendered view carried over used to start out clean.
	 */
	const dirty = $derived(
		sourceMode && editor ? editorDirty : loader.text !== null && loader.diskText !== null && loader.text !== loader.diskText
	);
	const gate = $derived(annotateGate({ target: mode === 'workspace' ? null : target, kind, sourceMode, dirty, outside: !inWorkspace }));
	/** The adapter drawing this view's annotations, whether or not new ones can be made here. */
	const viewAdapter = $derived(adapterFor(kind, sourceMode));
	/** The rows drawn on the file: resolved ones stay off it unless asked back or being gone to. */
	const drawnRows = $derived(drawnAnnotations(annot.fileAnnotations, { showResolved: annot.annotShowResolved, revealedId: annot.annotRevealedResolved }));
	/** Whether the bar offers the resolved ones back: only when this file has any. */
	const hasResolved = $derived(annot.fileAnnotations.some((row) => row.status === 'resolved'));
	/** This view's rows of the kind its adapter draws; the list still shows every kind and every status. */
	const viewAnnotations = $derived(
		viewAdapter ? drawnRows.filter((row) => row.anchor_kind === ADAPTER_ANCHOR_KIND[viewAdapter]) : []
	);
	/** Box and element kinds draw in a mode; text is selected, media has its own buttons. */
	const needsMode = $derived(viewAdapter === 'image' || viewAdapter === 'pdf' || viewAdapter === 'html');
	/** Markdown and single-file HTML can be read rendered or as source. */
	let canToggleSource = $derived(kind === 'markdown' || kind === 'html');
	/** The switch sits in the annotation row, beside the annotate buttons, once the text has come. */
	const showSourceToggle = $derived(canToggleSource && loader.text !== null);
	/**
	 * The pane has no toolbar: annotating keeps one thin row of its own, and only on a file it
	 * applies to — its list (which says why nothing new can be added when that is so), annotate
	 * mode for the kinds drawn with the pointer, and in the source view the line on how to add one.
	 * The rendered/source switch shares the row.
	 */
	const showAnnotToggle = $derived(
		mode !== 'workspace' && (annot.fileAnnotations.length > 0 || gate.ok || (gate.reason !== 'kind' && gate.reason !== 'outside'))
	);
	const showAnnotMode = $derived(mode !== 'workspace' && needsMode && gate.ok);
	const annotHint = $derived<'' | 'dirty' | 'no-target' | 'streamed' | null>(
		mode !== 'workspace' && gate.ok && gate.adapter === 'media' && loader.streamed && !loader.loading && loader.contentSha === null
			? 'streamed'
			: mode === 'workspace' || !sourceMode || loader.text === null
				? null
				: gate.ok
					? ''
					: gate.reason === 'dirty' || gate.reason === 'no-target'
						? gate.reason
						: null
	);

	loader.watchLoad();

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

	treeSrc.watchWorkspace();

	onDestroy(() => {
		loader.destroy();
		treeSrc.destroy();
	});

	function enlarge(image: string, own: boolean, picture: Element | null | undefined): void {
		let origin: ImageOrigin | null = null;
		if (picture instanceof HTMLElement) {
			const box = picture.getBoundingClientRect();
			if (box.width >= 2 && box.height >= 2) {
				origin = { top: box.top, left: box.left, width: box.width, height: box.height };
			}
		}
		// A picture inside a note already shows its 256 px copy: the enlargement starts from it at the
		// picture's proportions and grows once. The note keeps owning that object URL.
		const standIn = !own && picture instanceof HTMLImageElement && picture.complete && picture.naturalWidth > 0 ? picture.src : null;
		enlarged = { from: relpath, relpath: image, own, origin, placeholder: standIn };
	}

	/**
	 * Open this tree row with the system, or reveal it in Finder. A failure stays a quiet hint on
	 * the preview: the browser build has no system opener, and downloading the file from here was
	 * the old toolbar's job.
	 */
	async function openOnDisk(path: string, reveal: boolean): Promise<void> {
		const abs = absWorkspacePath(workspacePath, path, treeSrc.home);
		if (!abs || remoteClient) {
			loader.openHint = true;
			return;
		}
		const ok = await openWorkspacePath(abs, reveal);
		if (!ok) loader.openHint = true;
	}

	function selectNode(node: ArtifactTreeNode): void {
		if (mode === 'workspace' && node.kind === 'dir') return;
		// Picking a file is a request to look at it, so the list gets out of the way.
		if (node.kind !== 'dir') treeOpen = false;
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

	function requestClose(afterClose?: () => void): void {
		if (saving) return;
		if (dirty) {
			// The file is not closing yet. `afterClose` runs only if this close goes through.
			pendingNav = { kind: 'close', afterClose };
			return;
		}
		onClose();
		afterClose?.();
	}

	async function save(): Promise<boolean> {
		// Never while another file is loading or failed to: the buffer on screen is the last file's.
		if (!api || !relpath || !canSave || loader.loading || loader.missing) return false;
		saving = true;
		saveError = false;
		saveConflict = false;
		try {
			const value = editor?.getValue() ?? loader.text ?? '';
			loader.loadedEtag = await api.putWorkspaceFile(relpath, value, loader.loadedEtag);
			loader.hashFresh = true;
			loader.text = value;
			loader.diskText = value;
			editor?.markSaved(value);
			editorDirty = false;
			return true;
		} catch (error) {
			saveConflict = error instanceof ApiError && error.status === 409;
			saveError = true;
			if (error instanceof ApiError && error.code === 'file_limit') loader.missing = true;
			return false;
		} finally {
			saving = false;
		}
	}

	async function confirmSave(): Promise<void> {
		if (saving) return;
		const nav = pendingNav;
		const ok = await save();
		if (!ok) return;
		pendingNav = null;
		if (nav?.kind === 'close') {
			onClose();
			nav.afterClose?.();
		}
		else if (nav?.kind === 'node') commitSelect(nav.node);
		else if (nav?.kind === 'leave') nav.after();
	}

	function confirmDiscard(): void {
		const nav = pendingNav;
		pendingNav = null;
		// Back to the disk, not to `text`: that is the unsaved buffer when it came through the rendered view.
		const disk = loader.diskText ?? loader.text ?? '';
		loader.text = disk;
		editor?.revert(disk);
		editorDirty = false;
		if (nav?.kind === 'close') {
			onClose();
			nav.afterClose?.();
		}
		else if (nav?.kind === 'node') commitSelect(nav.node);
		else if (nav?.kind === 'leave') nav.after();
	}

	export function closeFind(): boolean {
		return (editor?.closeFind() ?? false) || (pdfViewer?.closeFind() ?? false);
	}

	export function requestCloseFromParent(afterClose?: () => void): void {
		requestClose(afterClose);
	}

	/**
	 * Another file is about to take this pane — the conversation's preview is one pane, so opening
	 * a different file turns it rather than opening beside it. An unsaved edit is asked about the
	 * way leaving it from the tree is; `after` runs once it is saved or let go, never on cancel.
	 */
	export function requestLeaveFromParent(after: () => void): void {
		if (saving) return;
		if (dirty) {
			pendingNav = { kind: 'leave', after };
			return;
		}
		after();
	}

	/** True when closing would have to ask — an unsaved edit, or a save in flight. */
	export function blocksClose(): boolean {
		return saving || dirty;
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
		};
		trackPointerDrag(window, { move: onMove, end: onUp, cancel: false });
	}

	function onPaneKey(ev: KeyboardEvent): void {
		// An open list is the innermost thing Escape can close.
		if (ev.key === 'Escape' && treeOpen) {
			treeOpen = false;
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
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
		if (!ev.shiftKey && key === 'f' && kind === 'pdf' && pdfViewer) {
			ev.preventDefault();
			ev.stopPropagation();
			pdfViewer.openFind();
			return;
		}
		if (!sourceMode || !editor) return;
		if (!ev.shiftKey && key === 'f') {
			ev.preventDefault();
			ev.stopPropagation();
			editor.openFind();
		}
	}

	function toggleSource(): void {
		// Leaving the source view carries an edit over to the rendered one — only an edit: the
		// model's own line-ending folding is not one, and a buffer brought back to the disk by hand
		// is the disk again, not the old carried edit.
		if (editor) loader.text = editor.isDirty() ? editor.getValue() : (loader.diskText ?? loader.text);
		// Picking elements belongs to the rendered page; the source is annotated by selecting lines.
		// A spot already picked keeps its composer, as a markdown selection does.
		if (!showSource) annot.annotMode = false;
		showSource = !showSource;
	}
</script>

{#snippet treeView()}
	{#key treeSrc.treeGeneration}
	<ArtifactTree
		nodes={treeSrc.tree}
		selected={relpath}
		label={treeLabel}
		onSelect={selectNode}
		onContextMenu={treeSrc.openTreeMenu}
		onTrash={treeSrc.canTrash ? treeSrc.askTrash : undefined}
		dragLabel={t.stream.dragItems}
		lazyDirs={treeSrc.lazy}
		loadedDirs={treeSrc.loadedDirs}
		onExpandDir={(path) => void treeSrc.loadWorkspaceDir(path)}
		truncatedLabel={t.stream.workspaceTruncated}
		loadingDirs={treeSrc.loadingDirs}
		failedDirs={treeSrc.failedDirs}
		loading={treeSrc.lazy ? treeSrc.loadingDirs.has('.') : treeSrc.taskTreeLoading}
		failed={treeSrc.lazy ? treeSrc.failedDirs.has('.') : treeSrc.taskTreeFailed}
		loadingLabel={t.stream.artifactTreeLoading}
		failedLabel={t.stream.artifactTreeFailed}
		emptyLabel={treeSrc.lazy ? t.stream.workspaceEmpty : t.stream.artifactTreeEmpty}
		retryLabel={t.disconnected.retry}
		onRetry={() => { if (treeSrc.lazy) void treeSrc.loadWorkspaceDir('.'); else treeSrc.taskTreeRetry += 1; }}
		bind:collapsed={treeCollapsed}
		bind:expandedLazy={treeExpanded}
	/>
	{/key}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
	class="artifact-pane"
	class:is-sheet={sheet}
	class:is-tree-dragging={treeDragging}
	aria-label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactPreview}
	bind:this={paneEl}
	style:--artifact-tree-width="{treeWidth}px"
	onkeydown={onPaneKey}
>
	<!--
		A phone — or a sheet over the whole app, which is what the phone flow opens on a hosted
		tablet — has no workbench tab to name or close this pane, so it keeps one thin bar: back,
		and the file's name. The desktop names the file on its tab and closes it there.
	-->
	<header class="artifact-pane-head" class:has-download={canDownload}>
		<button type="button" class="artifact-back" aria-label={t.common.back} title={t.common.back} onclick={() => requestClose()}>
			<Icon name="chevron-left" size={20} />
		</button>
		<h2 class:is-dirty={dirty} title={titleName}>{titleName}</h2>
		{#if canDownload}
			{#key downloadKey}
				<FileDownload
					{api}
					path={relpath}
					attachmentId={byteSource === 'attachment' ? (attachment?.id ?? null) : null}
					name={titleName}
					{t}
					ready={loader.readyOriginal}
					variant="icon"
					bind:note={loader.downloadNote}
					--file-download-size="48px"
					--file-download-radius="0"
				/>
			{/key}
		{/if}
	</header>
	{#if saveError}
		<p class="muted artifact-save-error pt-0 px-8 pb-3">{saveConflict ? t.stream.artifactSaveConflict : t.stream.artifactSaveFailed}</p>
	{/if}
	{#if loader.downloadNote}
		<p class="muted artifact-download-note" role="status">
			{loader.downloadNote === 'tap' ? t.stream.imageSaveTapAgain : t.stream.artifactDownloadFailed}
		</p>
	{/if}
	<ArtifactAnnotBar {t} {api} {mode} {relpath} {attachment} {byteSource} {titleName} {downloadKey} {canDownload} {showAnnotToggle} {showAnnotMode} {annotHint} {showSourceToggle} {hasResolved} {showSource} {toggleSource} {annot} {loader} />
	{#if showTree}
		<div class="artifact-picker">
			<button
				type="button"
				class="artifact-picker-btn"
				aria-expanded={treeOpen}
				onclick={() => (treeOpen = !treeOpen)}
			>
				<span class="truncate">{treeLabel}</span>
				<Icon name="chevron-down" class={['artifact-picker-chevron', { 'is-open': treeOpen }]} />
			</button>
		</div>
		{#if treeOpen && stacked.current}
			<BottomSheet title={treeLabel} closeLabel={t.common.close} onClose={() => (treeOpen = false)} class="artifact-tree-sheet-panel">
				{@render treeView()}
			</BottomSheet>
		{/if}
	{/if}
	<div
		class="artifact-pane-main flex-1 min-h-0 min-w-0 flex"
		class:has-tree={showTree && !stacked.current}
	>
		{#if showTree && !stacked.current}
			{@render treeView()}
			<button
				type="button"
				class="split-handle artifact-tree-split"
				class:is-active={treeDragging}
				aria-label={t.stream.artifactTreeResize}
				onpointerdown={startTreeResize}
			></button>
		{/if}
		<ArtifactBody {t} {locale} {bots} {api} {relpath} {attachment} {mode} {kind} {sourceMode} {gate} {wrap} {resolvedTheme} {loadMonaco} {byteSource} {titleName} {opensOnDisk} {drawnRows} {viewAnnotations} {annot} {loader} {treeSrc} dirEntries={kind === 'directory' && mode !== 'workspace' ? treeSrc.listingOf(relpath) : null} onOpenEntry={selectNode} bind:editor bind:pdfViewer onEditorDirty={(next) => (editorDirty = next)} {enlarge} {openMarkdownPath} {openOnDisk} {inWorkspace} />
	</div>
	{#if mode !== 'workspace'}
		{#each annot.annotDrafts as group (group.sessionId)}
			<AnnotationSendBar
				count={group.drafts.length}
				destination={destinationLabel(t, group.sessionId, viewedSessionId, bots, group.botIds, sessions)}
				sending={annot.sendBusy}
				error={annot.sendError}
				{t}
				onSend={(summary) => annot.sendDrafts(group.sessionId, summary, group.drafts.slice(0, ANNOTATION_BATCH_MAX).map((row) => row.id))}
				onClear={() => void annot.clearDrafts(group.drafts.map((row) => row.id))}
			/>
		{/each}
	{/if}
</aside>
{#if treeSrc.treeMenu}
	<ArtifactTreeMenu
		x={treeSrc.treeMenu.x}
		y={treeSrc.treeMenu.y}
		{t}
		onOpen={() => void openOnDisk(treeSrc.treeMenu?.node.path ?? '', false)}
		onReveal={() => void openOnDisk(treeSrc.treeMenu?.node.path ?? '', true)}
		onOpenTerminal={treeSrc.treeMenuTerminalDir && onOpenTerminal ? () => onOpenTerminal(treeSrc.treeMenuTerminalDir!) : undefined}
		onCopyPath={treeSrc.treeMenuInWorkspace ? () => copyText(treeSrc.treeMenu?.targets.map((node) => node.path).join('\n') ?? '') : undefined}
		onCopyAbsPath={treeSrc.treeMenuAbsPaths ? () => copyText(treeSrc.treeMenuAbsPaths!) : undefined}
		count={treeSrc.treeMenu.targets.length}
		title={treeSrc.treeMenu.targets.length > 1 ? null : treeSrc.treeMenu.node.name}
		onTrash={treeSrc.treeMenuCanTrash ? () => treeSrc.askTrash(treeSrc.treeMenu?.targets ?? []) : undefined}
		onClose={() => (treeSrc.treeMenu = null)}
	/>
{/if}
{#if treeSrc.trashAsk && treeSrc.trashCopy}
	<DangerDialog
		copy={treeSrc.trashCopy}
		{t}
		busy={treeSrc.trashAsk.busy}
		onDismiss={() => (treeSrc.trashAsk = null)}
		onConfirm={() => void treeSrc.confirmTrash()}
	/>
{/if}
{#if shownEnlarged}
	<MessageImageLightbox
		attachment={shownEnlarged.own ? attachment : null}
		relpath={shownEnlarged.relpath}
		src={shownEnlarged.own ? loader.shownBlob : null}
		srcOriginalSize={shownEnlarged.own ? loader.reducedFrom : null}
		placeholder={shownEnlarged.placeholder}
		origin={shownEnlarged.origin}
		{api}
		{t}
		onClose={() => (enlarged = null)}
	/>
{/if}
{#if pendingNav}
	<ArtifactDirtyDialog {t} {saving} onCancel={() => (pendingNav = null)} onDiscard={confirmDiscard} onSave={() => void confirmSave()} />
{/if}

<style>
	.artifact-pane {
		height: 100%;
		background: var(--pane);
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-left: 0;
	}

	/* Desktop shows the tree beside the file, so it needs no picker above it. */
	.artifact-picker {
		display: none;
	}

	/*
	 * The desktop names and closes this pane on the workbench tab, so the bar is a phone thing.
	 * Keeping it in the document (rather than not rendering it) means a test can still read it.
	 */
	.artifact-pane-head {
		display: none;
	}

	/*
	 * The sheet: the phone flow on a window wider than a phone — a hosted tablet, where the pane
	 * covers everything and there is still no workbench tab to close it. The bar it gets is the
	 * phone's, so each declaration here repeats the phone block at the bottom word for word: at
	 * phone width both apply, and this one is the more specific.
	 */
	.artifact-pane.is-sheet .artifact-pane-head {
		display: flex;
		align-items: stretch;
		gap: 0;
		min-height: 64px;
		padding: 0 16px 0 0;
		padding-top: env(safe-area-inset-top);
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		flex-shrink: 0;
	}

	/* Download mirrors back: the same square, at the other end. */
	.artifact-pane.is-sheet .artifact-pane-head.has-download {
		padding-right: 0;
	}

	.artifact-pane.is-sheet .artifact-pane-head :global(.file-download-icon) {
		align-self: center;
	}

	/* The phone downloads from its own bar; a bar that would hold only that stays away. */
	.artifact-pane.is-sheet :global(.artifact-bar-download), .artifact-pane.is-sheet :global(.artifact-annot-bar.is-download-only) {
		display: none;
	}

	.artifact-pane-head h2 {
		margin: 0;
		min-width: 0;
		flex: 1;
		align-self: center;
		font-size: 16px;
		font-weight: 600;
		line-height: 21px;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artifact-pane-head h2.is-dirty::after {
		content: "•";
		margin-left: 6px;
		color: var(--accent);
	}

	.artifact-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 48px;
		width: 48px;
		align-self: stretch;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.artifact-back:hover,
	.artifact-back:active {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.artifact-back:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -3px;
	}

	/* The list goes beside the file only when the pane itself is wide enough: beside the chat on a
	 * desktop window the pane is often narrower than a phone. */
	.artifact-pane-main {
		container: artifact-main / inline-size;
	}

	.artifact-download-note {
		margin: 0;
		padding: 6px 16px;
		font-size: 12px;
		border-bottom: 1px solid var(--line);
	}

	.artifact-pane-main.has-tree {
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		grid-template-columns: var(--artifact-tree-width, 168px) 0 minmax(0, 1fr);
	}

	/* The grip (`.split-handle`) takes no track: it lies over the tree's own right border. */
	.artifact-tree-split {
		width: 1px;
		margin-left: -1px;
		background: transparent;
	}

	.artifact-pane.is-tree-dragging {
		cursor: col-resize;
		user-select: none;
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
			display: flex;
			align-items: stretch;
			gap: 0;
			min-height: 64px;
			padding: 0 16px 0 0;
			padding-top: env(safe-area-inset-top);
			border-bottom: 1px solid var(--line);
			background: var(--pane);
			flex-shrink: 0;
		}

		/* Download mirrors back: the same square, at the other end. */
		.artifact-pane-head.has-download {
			padding-right: 0;
		}

		.artifact-pane-head :global(.file-download-icon) {
			align-self: center;
		}

		/* The list drops over the top of the file instead of replacing the screen it is on. */
		.artifact-picker {
			display: block;
			padding: 8px 12px;
			border-bottom: 1px solid var(--line);
		}

		.artifact-picker-btn {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			width: 100%;
			min-height: 40px;
			padding: 0 12px;
			border: 1px solid var(--line);
			border-radius: var(--radius-md);
			background: var(--btn-secondary-bg);
			color: var(--ink);
			font-size: 13px;
			font-weight: 600;
		}

		.artifact-picker-btn[aria-expanded='true'] {
			border-color: var(--line-hover);
			background: var(--chip);
		}

		.artifact-picker-btn :global(.artifact-picker-chevron) {
			flex-shrink: 0;
			color: var(--ink-secondary);
			transition: transform 0.15s ease;
		}

		.artifact-picker-btn :global(.artifact-picker-chevron.is-open) {
			transform: rotate(180deg);
		}

		/* Dragging a divider is a mouse idea. */
		.artifact-tree-split {
			display: none;
		}
	}

	/* On a phone the list is a sheet from the bottom (`BottomSheet`); the sheet is its box. */
	:global(.artifact-tree-sheet-panel) :global(.artifact-tree) {
		width: auto;
		max-width: none;
		overflow: visible;
		padding: 0;
		border: 0;
		background: transparent;
	}

	/* Rows a thumb can hit; three classes, so it outweighs the tree's own row size. */
	:global(.artifact-tree-sheet-panel .artifact-tree .artifact-tree-row) {
		min-height: 44px;
		font-size: 14px;
	}
</style>
