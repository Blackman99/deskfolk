<script lang="ts">
	import type { AnchorOf, Annotation, AnnotationAnchor, AnnotationAnchorKind, Attachment, CreateAnnotationRequest, PatchAnnotationRequest, SessionSummary, TaskArtifacts } from '@real-bot/protocol';
	import type { EncodedCrop } from '../annotations/region-box.ts';
	import { ANNOTATION_BATCH_MAX, describeAnchor } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { ApiError, etagForBlob } from '../api.ts';
	import AnnotationList from '../annotations/AnnotationList.svelte';
	import AnnotationSendBar from '../annotations/AnnotationSendBar.svelte';
	import AnnotationComposer from '../annotations/AnnotationComposer.svelte';
	import ImageAnnotator from '../annotations/ImageAnnotator.svelte';
	import MarkdownAnnotator from '../annotations/MarkdownAnnotator.svelte';
	import HtmlAnnotator from '../annotations/HtmlAnnotator.svelte';
	import PdfViewer from './PdfViewer.svelte';
	import MediaAnnotator from '../annotations/MediaAnnotator.svelte';
	import {
		ADAPTER_ANCHOR_KIND,
		adapterFor,
		annotateGate,
		annotationsForFile,
		contentShaFromEtag,
		destinationLabel,
		draftsForView,
		groupByDestination,
		type AnnotationTarget,
	} from '../annotations/model.ts';
	import { anchorFromSelection, type EditorRange } from '../annotations/text-range.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import {
		absWorkspacePath,
		artifactByteSource,
		artifactKind,
		isInAppPreviewKind,
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
	import { formatFileSize } from '../chat/attachments.ts';
	import { copyText } from '../clipboard.ts';
	import {
		fileProgressPercent,
		formatFileProgress,
		type FileProgress,
	} from '../file-progress.ts';
	import { highlightLangFromPath, highlightLangLabel } from '../highlight-lang.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { openWorkspacePath } from './open-workspace.ts';
	import {
		clampArtifactTreeWidth,
		loadArtifactTreeWidth,
		saveArtifactTreeWidth,
	} from './artifact-tree-width.ts';
	import { themeManager } from '../theme.ts';
	import { onDestroy, untrack, type ComponentProps } from 'svelte';

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
	}: Props = $props();

	let blobUrl = $state<string | null>(null);
	let text = $state<string | null>(null);
	let missing = $state(false);
	let loading = $state(false);
	let progress = $state<FileProgress | null>(null);
	let loadPercent = $derived(progress ? fileProgressPercent(progress) : null);
	let loadBytes = $derived(progress ? formatFileProgress(progress, formatFileSize) : null);
	let openHint = $state(false);
	let wrap = $state(true);
	let showSource = $state(false);
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let liveBlob: string | null = null;
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
		revealAnnotation: (id: string) => void;
	} | null>(null);
	/** What is on disk for a text-backed file, as loaded or last saved; null for any other kind. */
	let diskText = $state<string | null>(null);
	/** The source editor's word on its buffer, which it compares with `diskText`. */
	let editorDirty = $state(false);
	// Annotations: this file's rows, the list column, the composer for a new one, the send bar.
	let annotOpen = $state(false);
	let annotFocus = $state<string | null>(null);
	/**
	 * Bumped on every request to go to `annotFocus` — a list row, a mark, a card — so asking for the
	 * one that already has focus shows it again. Every adapter reveals when this changes.
	 */
	let annotFocusSeq = $state(0);
	/**
	 * The spot chosen and waiting for its remark: which kind, the anchor, and — for a region or a
	 * frame — how to cut the crop when the draft is saved. The file's path and hash and the message
	 * it hangs on are taken when the spot is picked: the anchor was read off that file.
	 */
	let pendingDraft = $state<{
		kind: AnnotationAnchorKind;
		anchor: AnnotationAnchor;
		crop?: () => Promise<EncodedCrop | null>;
		relpath: string;
		sha: string | null;
		target: AnnotationTarget;
	} | null>(null);
	/** Box and element kinds need a mode: the pointer draws instead of scrolling or clicking through. */
	let annotMode = $state(false);
	/** The file's scroller, and how far down the composer sits so it clears the view's own toolbar. */
	let bodyEl = $state<HTMLElement | null>(null);
	let composerTop = $state<number | null>(null);
	let annotBusy = $state(false);
	let annotError = $state<string | null>(null);
	let sendBusy = $state(false);
	let sendError = $state<string | null>(null);
	const fileAnnotations = $derived(annotationsForFile(annotations, relpath, workspacePath, annotationFileKey));
	const annotDrafts = $derived(groupByDestination(draftsForView(annotations, viewedSessionId)));
	// The HTML picker's bar and the PDF toolbar hold controls the pending spot needs (外层 / 内层,
	// pages, zoom): the composer goes under them instead of over them.
	$effect(() => {
		const body = bodyEl;
		if (!pendingDraft || !body) {
			composerTop = null;
			return;
		}
		const measure = () => {
			const top = body.getBoundingClientRect().top;
			let bottom = 0;
			for (const bar of body.querySelectorAll<HTMLElement>('[data-annotator-bar]')) {
				bottom = Math.max(bottom, bar.getBoundingClientRect().bottom - top + body.scrollTop);
			}
			composerTop = bottom > 0 ? Math.round(bottom + 8) : null;
		};
		measure();
		if (typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver(measure);
		for (const bar of body.querySelectorAll('[data-annotator-bar]')) observer.observe(bar);
		return () => observer.disconnect();
	});
	let annotLoadedPath: string | null = null;
	$effect(() => {
		const path = relpath;
		const load = onLoadAnnotations;
		if (!path || !load || mode === 'workspace' && !path) return;
		if (path === annotLoadedPath) return;
		annotLoadedPath = path;
		load(path);
	});
	$effect(() => {
		const id = annotationFocusId;
		if (!id) return;
		untrack(() => {
			focusAnnotation(id);
			annotOpen = true;
		});
	});
	/** The file the composer and annotate mode belong to. */
	let draftPath: string | null = null;
	$effect(() => {
		// A new file: the composer for the old one has nothing to hang on. The shell hands the path
		// over off an object it rebuilds on every snapshot, so the same path again is no new file —
		// letting go there threw away a remark half typed whenever any event came in.
		const path = relpath;
		if (path === draftPath) return;
		draftPath = path;
		untrack(() => {
			pendingDraft = null;
			annotMode = false;
			annotError = null;
		});
	});

	/** Go to an annotation: a request, so the one already focused is revealed and flashed again. */
	function focusAnnotation(id: string): void {
		annotFocus = id;
		annotFocusSeq += 1;
	}

	function offerAnnotation(range: EditorRange, value: string): void {
		if (!gate.ok) return;
		offerDraft('text_range', anchorFromSelection(value, range));
	}

	/** Any adapter's chosen spot: the composer opens for it. */
	function offerDraft(kind: AnnotationAnchorKind, anchor: AnnotationAnchor, crop?: () => Promise<EncodedCrop | null>): void {
		if (!gate.ok || !target) return;
		pendingDraft = { kind, anchor, crop, relpath, sha: contentSha, target };
		annotError = null;
	}

	function cancelDraft(): void {
		pendingDraft = null;
		annotError = null;
	}

	/** Escape from an adapter: the spot waiting for its remark first, then annotate mode; then the pane's. */
	function escapeAnnotation(): void {
		if (pendingDraft) cancelDraft();
		else annotMode = false;
	}

	async function saveDraft(body: string): Promise<void> {
		const pending = pendingDraft;
		if (!pending || !onCreateAnnotation) return;
		const sha = pending.sha;
		if (!sha) {
			annotError = t.stream.annotationSaveFailed;
			return;
		}
		// Saved, or edited and not saved, since the spot was picked: the anchor describes text that is
		// no longer what is on disk, and the daemon would take it as fresh against the new hash.
		if (sha !== contentSha || (!gate.ok && gate.reason === 'dirty')) {
			annotError = t.stream.annotationFileChanged;
			return;
		}
		annotBusy = true;
		annotError = null;
		// The crop is cut once, from what is on screen, when the draft is kept.
		let crop: EncodedCrop | null = null;
		try {
			crop = (await pending.crop?.()) ?? null;
		} catch {
			crop = null;
		}
		const failed = await onCreateAnnotation({
			target_message_id: pending.target.messageId,
			relpath: pending.relpath,
			anchor_kind: pending.kind,
			anchor: pending.anchor,
			content_sha256: sha,
			body,
			...(crop ? { crop } : {}),
		});
		annotBusy = false;
		if (failed) {
			annotError = t.stream.annotationSaveFailed;
			return;
		}
		pendingDraft = null;
		annotOpen = true;
	}

	async function editDraft(row: Annotation, body: string): Promise<void> {
		if (!onPatchAnnotation) return;
		annotBusy = true;
		const failed = await onPatchAnnotation(row.id, { body });
		annotBusy = false;
		annotError = failed ? t.stream.annotationSaveFailed : null;
	}

	async function deleteDraft(row: Annotation): Promise<void> {
		if (!onDeleteAnnotation) return;
		annotBusy = true;
		const failed = await onDeleteAnnotation(row.id);
		annotBusy = false;
		annotError = failed ? t.stream.annotationSaveFailed : null;
	}

	async function toggleAnnotation(row: Annotation, status: 'open' | 'resolved'): Promise<void> {
		if (!onPatchAnnotation) return;
		annotBusy = true;
		const failed = await onPatchAnnotation(row.id, { status });
		annotBusy = false;
		annotError = failed ? t.stream.annotationSaveFailed : null;
	}

	function revealAnnotation(row: Annotation): void {
		focusAnnotation(row.id);
	}

	/**
	 * A click on a drawn mark: open the list on it. The mark is where the person is looking, so a
	 * second click on the same one is not a new request to go there.
	 */
	function pickAnnotation(id: string): void {
		if (annotFocus !== id) focusAnnotation(id);
		annotOpen = true;
	}

	/**
	 * A control that stands for an annotation away from its spot (the HTML bar's numbered chips):
	 * every click is a request to go there, the same one again included.
	 */
	function goToAnnotation(id: string): void {
		focusAnnotation(id);
		annotOpen = true;
	}

	/** True once the batch went out; the send bar keeps its summary until then. */
	async function sendDrafts(sessionId: string, summary: string, ids: string[]): Promise<boolean> {
		if (!onSendAnnotations) return false;
		sendBusy = true;
		sendError = null;
		const failed = await onSendAnnotations(sessionId, summary, ids);
		sendBusy = false;
		if (failed) sendError = t.stream.annotationSendFailed;
		return !failed;
	}

	async function clearDrafts(ids: string[]): Promise<void> {
		if (!onDeleteAnnotation) return;
		sendBusy = true;
		sendError = null;
		let failed = 0;
		for (const id of ids) if (await onDeleteAnnotation(id)) failed += 1;
		sendBusy = false;
		if (failed) sendError = t.stream.annotationClearFailed;
	}
	let saving = $state(false);
	let saveError = $state(false);
	let saveConflict = $state(false);
	let loadedEtag = $state<string | null>(null);
	/** The PDF's bytes, for the pdf.js viewer. */
	let pdfBlob = $state<Blob | null>(null);
	let pdfViewer = $state<{ openFind: () => void; closeFind: () => boolean } | null>(null);
	/** An SVG's source, kept so an image annotation can size a drawing that declares no size. */
	let svgRaw = $state<string | null>(null);
	const contentSha = $derived(contentShaFromEtag(loadedEtag));
	let pendingNav = $state<null | { kind: 'close'; afterClose?: () => void } | { kind: 'node'; node: ArtifactTreeNode }>(null);
	let treePreferred = $state(loadArtifactTreeWidth());
	let treeDragging = $state(false);
	/** Phone only: the list drops down over the top of the preview, which stays put. */
	let treeOpen = $state(false);
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
	let taskArtifacts = $state<TaskArtifacts | null>(null);
	let taskTreeLoading = $state(false);
	let taskTreeFailed = $state(false);
	let taskTreeRetry = $state(0);
	/** The job whose files are listed, so the same job is never pulled twice. */
	let loadedTaskKey: string | null = null;
	let loadedTaskClient: MessengerApi | null = null;
	let taskTreeAbort: AbortController | null = null;
	/**
	 * The props of this pane come off one object the shell derives, so every snapshot re-runs this
	 * — and clearing the list to pull the same job again is the tree blinking. Only a different
	 * job, or the retry button, is a reason to let go of what is listed.
	 */
	$effect(() => {
		const id = taskId;
		const client = api;
		const retry = taskTreeRetry;
		const key = id && client && mode !== 'workspace' ? `${retry}:${id}` : null;
		// A reconnect hands over a new client, and what it listed belongs to the old one.
		if (key === loadedTaskKey && client === loadedTaskClient) return;
		loadedTaskKey = key;
		loadedTaskClient = client;
		taskTreeAbort?.abort();
		taskTreeAbort = null;
		taskArtifacts = null;
		taskTreeFailed = false;
		taskTreeLoading = false;
		if (!key || !id || !client) return;
		const controller = new AbortController();
		taskTreeAbort = controller;
		taskTreeLoading = true;
		client.taskArtifacts(id, controller.signal)
			.then((rows) => {
				if (!controller.signal.aborted) taskArtifacts = rows;
			})
			.catch(() => {
				if (!controller.signal.aborted) taskTreeFailed = true;
			})
			.finally(() => {
				if (!controller.signal.aborted) taskTreeLoading = false;
			});
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
	let loadingDirs = $state(new Set<string>());
	let failedDirs = $state(new Set<string>());
	let treeGeneration = $state(0);
	let truncatedHint = $state(false);
	let tree = $derived(mode === 'workspace' ? workspaceTree : citedTree);
	let showTree = $derived(
		mode === 'workspace' ||
			forceTree || Boolean(taskId) ||
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
	// The rendered view can hold an unsaved buffer carried over from the source view; the dirty
	// prompt's Save must be able to write it.
	let canSave = $derived(Boolean(api && relpath && canShowSource && text !== null && (sourceMode || text !== diskText)));
	/**
	 * Unsaved: what is on screen differs from what is on disk — the editor's buffer in the source
	 * view, the text the rendered view shows otherwise. Not the editor's flag alone: a new editor
	 * made from a buffer the rendered view carried over used to start out clean.
	 */
	const dirty = $derived(
		sourceMode && editor ? editorDirty : text !== null && diskText !== null && text !== diskText
	);
	const gate = $derived(annotateGate({ target: mode === 'workspace' ? null : target, kind, sourceMode, dirty }));
	/** The adapter drawing this view's annotations, whether or not new ones can be made here. */
	const viewAdapter = $derived(adapterFor(kind, sourceMode));
	/** This view's rows of the kind its adapter draws; the list still shows every kind. */
	const viewAnnotations = $derived(
		viewAdapter ? fileAnnotations.filter((row) => row.anchor_kind === ADAPTER_ANCHOR_KIND[viewAdapter]) : []
	);
	/** Box and element kinds draw in a mode; text is selected, media has its own buttons. */
	const needsMode = $derived(viewAdapter === 'image' || viewAdapter === 'pdf' || viewAdapter === 'html');
	/** The pending anchor, handed back to the adapter that made it so it can keep drawing it. */
	function pendingOf<K extends AnnotationAnchorKind>(k: K): AnchorOf<K> | null {
		return pendingDraft && pendingDraft.kind === k ? (pendingDraft.anchor as AnchorOf<K>) : null;
	}
	function movePending(anchor: AnnotationAnchor): void {
		if (pendingDraft) pendingDraft = { ...pendingDraft, anchor };
	}

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

	/** Which workspace root is listed; `null` when this pane is not the explorer. */
	let loadedWorkspaceKey: string | null | undefined = undefined;
	let loadedWorkspaceClient: MessengerApi | null = null;
	/**
	 * Same story as the job's files above: the explorer threw its listing away and re-read the
	 * root on every snapshot, which read as the tree blinking once a second.
	 */
	$effect(() => {
		const client = api;
		const workspaceMode = mode === 'workspace';
		const root = workspacePath;
		const key = workspaceMode && client ? (root ?? '') : null;
		if (key === loadedWorkspaceKey && client === loadedWorkspaceClient) return;
		loadedWorkspaceKey = key;
		loadedWorkspaceClient = client;
		untrack(() => {
			treeGeneration += 1;
			workspaceTree = [];
			loadedDirs = new Set();
			loadingDirs = new Set();
			failedDirs = new Set();
			truncatedHint = false;
			if (key !== null) void loadWorkspaceDir('.');
		});
	});

	onDestroy(() => {
		revoke();
		taskTreeAbort?.abort();
		// Anything still in flight for this pane belongs to a listing that is gone.
		treeGeneration += 1;
		if (copiedTimer) clearTimeout(copiedTimer);
	});

	function revoke(): void {
		if (liveBlob) URL.revokeObjectURL(liveBlob);
		liveBlob = null;
		blobUrl = null;
		pdfBlob = null;
	}

	async function loadWorkspaceDir(dirPath: string): Promise<void> {
		const client = api;
		const path = dirPath || '.';
		if (!client || loadingDirs.has(path) || loadedDirs.has(path)) return;
		const generation = treeGeneration;
		loadingDirs = new Set(loadingDirs).add(path);
		failedDirs = new Set([...failedDirs].filter((dir) => dir !== path));
		try {
			const page = await client.workspaceTree(path === '.' ? '' : path);
			if (generation !== treeGeneration) return;
			const children = workspaceEntriesToNodes(page.items);
			if (path === '.') workspaceTree = children;
			else workspaceTree = mergeWorkspaceChildren(workspaceTree, path, children, page.truncated);
			loadedDirs = new Set(loadedDirs).add(path);
			if (page.truncated) truncatedHint = true;
		} catch {
			if (generation === treeGeneration) failedDirs = new Set(failedDirs).add(path);
		} finally {
			if (generation === treeGeneration) {
				loadingDirs = new Set([...loadingDirs].filter((dir) => dir !== path));
			}
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
		progress = null;
		if (!source || !api || previewKind === 'directory' || !isInAppPreviewKind(previewKind)) {
			if (gen !== loadGen) return;
			loading = false;
			revoke();
			text = null;
			diskText = null;
			return;
		}
		loading = true;
		progress = {
			loaded: 0,
			total: typeof att?.size === "number" && att.size > 0 ? att.size : null,
		};
		try {
			const onProgress = (next: FileProgress) => {
				if (gen !== loadGen) return;
				progress = {
					loaded: next.loaded,
					total: next.total ?? progress?.total ?? null,
				};
			};
			const blob =
				source === 'attachment' && att
					? await api.getAttachmentBlob(att.id, onProgress)
					: await api.getWorkspaceFileBlob(path, onProgress);
			if (gen !== loadGen) return;
			loadedEtag = etagForBlob(blob);
			if (previewKind === 'text' || previewKind === 'markdown' || previewKind === 'svg') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				if (previewKind === 'svg') {
					svgRaw = raw;
					const next = URL.createObjectURL(await svgDisplayBlob(raw));
					if (gen !== loadGen) return;
					if (liveBlob) URL.revokeObjectURL(liveBlob);
					liveBlob = next;
					blobUrl = next;
					text = null;
					diskText = null;
				} else {
					text = raw;
					diskText = raw;
				}
				return;
			}
			if (previewKind === 'html') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				// The HTML view builds its own sandboxed blob from the text (and a picker, in annotate mode).
				text = raw;
				diskText = raw;
				return;
			}
			const next = URL.createObjectURL(blob);
			if (liveBlob) URL.revokeObjectURL(liveBlob);
			liveBlob = next;
			blobUrl = next;
			// pdf.js reads the bytes, not a URL.
			pdfBlob = previewKind === 'pdf' ? blob : null;
			text = null;
			diskText = null;
		} catch {
			if (gen !== loadGen) return;
			loadedKey = null;
			missing = true;
		} finally {
			if (gen === loadGen) loading = false;
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
		if (!api || !relpath || !canSave) return false;
		saving = true;
		saveError = false;
		saveConflict = false;
		try {
			const value = editor?.getValue() ?? text ?? '';
			loadedEtag = await api.putWorkspaceFile(relpath, value, loadedEtag);
			text = value;
			diskText = value;
			editor?.markSaved(value);
			editorDirty = false;
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
	}

	function confirmDiscard(): void {
		const nav = pendingNav;
		pendingNav = null;
		// Back to the disk, not to `text`: that is the unsaved buffer when it came through the rendered view.
		const disk = diskText ?? text ?? '';
		text = disk;
		editor?.revert(disk);
		editorDirty = false;
		if (nav?.kind === 'close') {
			onClose();
			nav.afterClose?.();
		}
		else if (nav?.kind === 'node') commitSelect(nav.node);
	}

	export function closeFind(): boolean {
		return (editor?.closeFind() ?? false) || (pdfViewer?.closeFind() ?? false);
	}

	export function requestCloseFromParent(afterClose?: () => void): void {
		requestClose(afterClose);
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
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
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
	class:is-tree-dragging={treeDragging}
	aria-label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactPreview}
	bind:this={paneEl}
	style:--artifact-tree-width="{treeWidth}px"
	onkeydown={onPaneKey}
>
	<header class="artifact-pane-head">
		<div class="artifact-pane-titles min-w-0">
			<div class="artifact-pane-title-row flex items-center gap-4 min-w-0">
				<FileIcon {icon} size={16} />
				<h2 class:is-dirty={dirty}>{titleName}</h2>
			</div>
			<p class="mono">{relpath || (workspacePath ?? '')}</p>
		</div>
		<button type="button" class="modal-close" title={t.common.close} onclick={() => requestClose()}>✕</button>
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
							// Only an edit is carried over: the model's own line-ending folding is not one. A
							// buffer brought back to the disk by hand is the disk again, not the old carried edit.
							if (editor) text = editor.isDirty() ? editor.getValue() : (diskText ?? text);
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
			{#if mode !== 'workspace' && (fileAnnotations.length > 0 || gate.ok || (!gate.ok && gate.reason !== 'kind'))}
				<button
					type="button"
					class="artifact-tool-btn artifact-annot-toggle"
					class:is-on={annotOpen}
					aria-pressed={annotOpen}
					onclick={() => (annotOpen = !annotOpen)}
					data-annotation-toggle
				>{t.stream.annotationsTitle}{fileAnnotations.length > 0 ? ` (${fileAnnotations.length})` : ''}</button>
			{/if}
			{#if mode !== 'workspace' && needsMode && gate.ok}
				<button
					type="button"
					class="artifact-tool-btn"
					class:is-on={annotMode}
					aria-pressed={annotMode}
					onclick={() => {
						annotMode = !annotMode;
						if (!annotMode) cancelDraft();
					}}
					data-annotation-mode
				>{annotMode ? t.stream.annotationModeExit : t.stream.annotationMode}</button>
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
	{#if mode !== 'workspace' && sourceMode && text !== null}
		{#if gate.ok}
			<p class="muted artifact-annot-hint pt-0 px-8 pb-3" data-annotation-hint>{t.stream.annotationAddHint}</p>
		{:else if gate.reason === 'dirty'}
			<p class="muted artifact-annot-hint pt-0 px-8 pb-3" data-annotation-hint="dirty">{t.stream.annotationDirtyHint}</p>
		{:else if gate.reason === 'no-target'}
			<p class="muted artifact-annot-hint pt-0 px-8 pb-3" data-annotation-hint="no-target">{t.stream.annotationNoTarget}</p>
		{/if}
	{/if}
	{#if showTree}
		<div class="artifact-picker">
			<button
				type="button"
				class="artifact-picker-btn"
				aria-expanded={treeOpen}
				onclick={() => (treeOpen = !treeOpen)}
			>
				<span class="truncate">{treeLabel}</span>
				<svg class="artifact-picker-chevron" class:is-open={treeOpen} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="6 9 12 15 18 9"></polyline>
				</svg>
			</button>
		</div>
	{/if}
	<div
		class="artifact-pane-main flex-1 min-h-0 min-w-0 flex"
		class:has-tree={showTree}
		data-tree-open={treeOpen}
	>
		{#if showTree}
			{#key treeGeneration}
			<ArtifactTree
				nodes={tree}
				selected={relpath}
				label={mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactTree}
				onSelect={selectNode}
				lazyDirs={mode === 'workspace'}
				{loadedDirs}
				onExpandDir={(path) => void loadWorkspaceDir(path)}
				truncatedLabel={t.stream.workspaceTruncated}
				{loadingDirs}
				{failedDirs}
				loading={mode === 'workspace' ? loadingDirs.has('.') : taskTreeLoading}
				failed={mode === 'workspace' ? failedDirs.has('.') : taskTreeFailed}
				loadingLabel={t.stream.artifactTreeLoading}
				failedLabel={t.stream.artifactTreeFailed}
				emptyLabel={mode === 'workspace' ? t.stream.workspaceEmpty : t.stream.artifactTreeEmpty}
				retryLabel={t.disconnected.retry}
				onRetry={() => { if (mode === 'workspace') void loadWorkspaceDir('.'); else taskTreeRetry += 1; }}
			/>
			{/key}
			<button
				type="button"
				class="artifact-tree-split"
				aria-label={t.stream.artifactTreeResize}
				onpointerdown={startTreeResize}
			></button>
		{/if}
		{#if treeOpen}
			<button
				type="button"
				class="artifact-picker-scrim"
				aria-label={t.common.close}
				onclick={() => (treeOpen = false)}
			></button>
		{/if}
		<div class="artifact-body-with-annots flex-1 min-h-0 min-w-0 flex" class:has-annots={annotOpen && mode !== 'workspace'}>
		<div
			bind:this={bodyEl}
			class="artifact-pane-body flex-1 min-h-0 min-w-0 overflow-auto p-8"
			class:is-editor={sourceMode && text !== null}
		>
			{#if loading}
				<div class="artifact-loading" role="status" aria-live="polite" aria-busy="true">
					<span class="artifact-loading-ring" aria-hidden="true"></span>
					<p class="artifact-loading-copy">{t.stream.artifactLoading}</p>
					{#if loadBytes}
						<p class="artifact-loading-bytes">{loadBytes}</p>
					{/if}
					<div
						class="artifact-loading-bar"
						role="progressbar"
						aria-label={t.stream.artifactLoading}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={loadPercent ?? undefined}
					>
						<div
							class="artifact-loading-fill"
							class:is-indeterminate={loadPercent === null}
							style={loadPercent === null ? undefined : `width: ${loadPercent}%`}
						></div>
					</div>
				</div>
			{/if}
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
						baseline={diskText}
						path={relpath}
						{wrap}
						onDirty={(next) => (editorDirty = next)}
						annotations={fileAnnotations}
						focusAnnotationId={annotFocus}
						focusAnnotationSeq={annotFocusSeq}
						annotateEnabled={gate.ok && gate.adapter === 'text' && !pendingDraft}
						annotateLabel={t.stream.annotationAdd}
						onAnnotate={offerAnnotation}
						onPickAnnotation={pickAnnotation}
						{loadMonaco}
					/>
				{/if}
			{:else if kind === "image" || kind === "svg"}
				{#if blobUrl}
					<ImageAnnotator
						src={blobUrl}
						alt={relpath}
						isSvg={kind === 'svg'}
						svgText={svgRaw}
						annotations={viewAnnotations}
						focusId={annotFocus}
						focusSeq={annotFocusSeq}
						active={annotMode}
						enabled={gate.ok && gate.adapter === 'image' && !pendingDraft}
						labels={t.stream.annotImage}
						onDraft={(draft) => offerDraft('image_region', draft.anchor, draft.crop)}
						onPick={pickAnnotation}
						pending={pendingOf('image_region')}
						onPendingChange={movePending}
						onCancel={escapeAnnotation}
					/>
				{/if}
			{:else if (kind === "audio" || kind === "video") && blobUrl}
				<MediaAnnotator
					src={blobUrl}
					kind={kind}
					annotations={viewAnnotations}
					focusId={annotFocus}
					focusSeq={annotFocusSeq}
					enabled={gate.ok && gate.adapter === 'media' && !pendingDraft}
					labels={t.stream.annotMedia}
					onDraft={(draft) => offerDraft('media_time', draft.anchor, draft.crop)}
					onPick={pickAnnotation}
					pending={pendingOf('media_time')}
					onPendingChange={movePending}
					onCancel={escapeAnnotation}
				/>
			{:else if kind === "pdf" && pdfBlob}
				<PdfViewer
					bind:this={pdfViewer}
					data={pdfBlob}
					theme={resolvedTheme}
					labels={t.stream.annotPdf}
					annotations={viewAnnotations}
					focusId={annotFocus}
					focusSeq={annotFocusSeq}
					active={annotMode}
					enabled={gate.ok && gate.adapter === 'pdf' && !pendingDraft}
					onDraft={(draft) => offerDraft('pdf_region', draft.anchor, draft.crop)}
					onPick={pickAnnotation}
					pending={pendingOf('pdf_region')}
					onPendingChange={movePending}
					onCancel={escapeAnnotation}
				/>
			{:else if kind === "html" && text !== null}
				<HtmlAnnotator
					html={text}
					scheme={resolvedTheme}
					title={relpath}
					annotations={viewAnnotations}
					focusId={annotFocus}
					focusSeq={annotFocusSeq}
					active={annotMode && gate.ok && gate.adapter === 'html'}
					enabled={gate.ok && gate.adapter === 'html' && (!pendingDraft || pendingDraft.kind === 'html_element')}
					labels={t.stream.annotHtml}
					onDraft={(draft) => offerDraft('html_element', draft.anchor)}
					onPick={goToAnnotation}
					pending={pendingOf('html_element')}
					onPendingChange={movePending}
					onCancel={escapeAnnotation}
				/>
			{:else if kind === "markdown" && text !== null}
				<MarkdownAnnotator
					source={text}
					annotations={viewAnnotations}
					focusId={annotFocus}
					focusSeq={annotFocusSeq}
					active={gate.ok && gate.adapter === 'markdown'}
					enabled={gate.ok && gate.adapter === 'markdown' && !pendingDraft}
					labels={t.stream.annotMarkdown}
					onDraft={(draft) => offerDraft('text_range', draft.anchor)}
					onPick={pickAnnotation}
					pending={pendingOf('text_range')}
					onCancel={escapeAnnotation}
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
			{#if pendingDraft}
				<div class="artifact-annot-composer" style:top={composerTop === null ? undefined : `${composerTop}px`}>
					<AnnotationComposer
						{t}
						position={describeAnchor(pendingDraft.kind, pendingDraft.anchor, locale)}
						busy={annotBusy}
						error={annotError}
						onSave={(body) => void saveDraft(body)}
						onCancel={cancelDraft}
					/>
				</div>
			{/if}
		</div>
		{#if annotOpen && mode !== 'workspace'}
			<div class="artifact-annot-col">
				<AnnotationList
					annotations={fileAnnotations}
					{t}
					{locale}
					{bots}
					focusId={annotFocus}
					busy={annotBusy}
					error={annotError}
					onReveal={revealAnnotation}
					onEdit={(row, body) => void editDraft(row, body)}
					onDelete={(row) => void deleteDraft(row)}
					onToggleStatus={(row, status) => void toggleAnnotation(row, status)}
					onClose={() => (annotOpen = false)}
				/>
			</div>
		{/if}
		</div>
	</div>
	{#if mode !== 'workspace'}
		{#each annotDrafts as group (group.sessionId)}
			<AnnotationSendBar
				count={group.drafts.length}
				destination={destinationLabel(t, group.sessionId, viewedSessionId, bots, group.botIds, sessions)}
				sending={sendBusy}
				error={sendError}
				{t}
				onSend={(summary) => sendDrafts(group.sessionId, summary, group.drafts.slice(0, ANNOTATION_BATCH_MAX).map((row) => row.id))}
				onClear={() => void clearDrafts(group.drafts.map((row) => row.id))}
			/>
		{/each}
	{/if}
</aside>
{#if pendingNav}
	<div class="modal-backdrop confirm-backdrop" role="presentation">
		<div class="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-dirty-title">
			<div class="modal-body">
				<h3 id="artifact-dirty-title">{t.stream.artifactDirtyTitle}</h3>
				<p class="confirm-copy">{t.stream.artifactDirtyBody}</p>
			</div>
			<div class="modal-foot artifact-dirty-foot">
				<button type="button" disabled={saving} onclick={() => (pendingNav = null)}>{t.sidebar.cancel}</button>
				<button type="button" disabled={saving} onclick={confirmDiscard}>{t.stream.artifactDiscard}</button>
				<button type="button" class="artifact-dirty-save" disabled={saving} onclick={() => void confirmSave()}>{t.stream.artifactSave}</button>
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

	/* Desktop shows the tree beside the file, so it needs no picker above it. */
	.artifact-picker,
	.artifact-picker-scrim {
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

	.artifact-pane-body {
		position: relative;
	}

	/* The list goes beside the file only when the pane itself is wide enough: beside the chat on a
	 * desktop window the pane is often narrower than a phone. */
	.artifact-pane-main {
		container: artifact-main / inline-size;
	}
	.artifact-body-with-annots {
		position: relative;
	}
	.artifact-annot-col {
		width: min(300px, 45%);
		flex-shrink: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	@container artifact-main (max-width: 720px) {
		.artifact-body-with-annots {
			flex-direction: column;
		}
		.artifact-body-with-annots.has-annots .artifact-pane-body {
			flex: 1 1 55%;
		}
		.artifact-annot-col {
			width: auto;
			flex: 0 0 45%;
			max-height: 45%;
			border-top: 1px solid var(--line);
		}
	}
	.artifact-annot-col :global(.annot-list) {
		flex: 1;
		min-height: 0;
	}
	.artifact-annot-composer {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 6;
	}
	.artifact-annot-hint {
		font-size: 11.5px;
	}

	.artifact-pane-body.is-editor {
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.artifact-loading {
		position: absolute;
		inset: 0;
		z-index: 3;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 24px;
		background: color-mix(in srgb, var(--pane) 88%, transparent);
	}

	.artifact-loading-ring {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 3px solid var(--line);
		border-top-color: var(--accent);
		animation: artifact-spin 0.9s linear infinite;
	}

	.artifact-loading-copy {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.artifact-loading-bytes {
		margin: 0;
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--muted);
	}

	.artifact-loading-bar {
		width: min(220px, 70%);
		height: 5px;
		border-radius: 999px;
		background: var(--line-subtle);
		overflow: hidden;
	}

	.artifact-loading-fill {
		height: 100%;
		width: 0;
		border-radius: 999px;
		background: var(--accent);
		transition: width 0.2s ease;
	}

	.artifact-loading-fill.is-indeterminate {
		width: 40%;
		animation: artifact-progress-sweep 1.2s ease-in-out infinite;
	}

	@keyframes artifact-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes artifact-progress-sweep {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(260%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.artifact-loading-ring {
			animation: none;
		}
		.artifact-loading-fill.is-indeterminate {
			width: 100%;
			animation: none;
		}
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
			font-size: 12.5px;
			font-weight: 600;
		}

		.artifact-picker-btn[aria-expanded='true'] {
			border-color: var(--line-hover);
			background: var(--chip);
		}

		.artifact-picker-chevron {
			flex-shrink: 0;
			color: var(--ink-secondary);
			transition: transform 0.15s ease;
		}

		.artifact-picker-chevron.is-open {
			transform: rotate(180deg);
		}

		.artifact-pane-main.has-tree {
			position: relative;
			display: block;
		}

		.artifact-pane-main :global(.artifact-tree) {
			position: absolute;
			inset-inline: 0;
			top: 0;
			z-index: 5;
			display: none;
			max-height: min(52%, 320px);
			width: auto;
			max-width: none;
			border-right: 0;
			border-bottom: 1px solid var(--line);
			background: var(--pane);
			box-shadow: 0 18px 28px -18px rgba(2, 6, 23, 0.65);
		}

		.artifact-pane-main[data-tree-open='true'] :global(.artifact-tree) {
			display: block;
		}

		/* The main area is a block here (the tree floats over it), so the file and its list take
		 * its height explicitly; left to their content they would run under the send bar. */
		.artifact-body-with-annots,
		.artifact-pane-body {
			height: 100%;
		}

		.artifact-picker-scrim {
			display: block;
			position: absolute;
			inset: 0;
			z-index: 4;
			background: transparent;
			border: 0;
		}

		/* Dragging a divider is a mouse idea. */
		.artifact-tree-split {
			display: none;
		}
		.artifact-annot-composer {
			top: 8px;
			right: 8px;
			left: 8px;
		}
	}
</style>
