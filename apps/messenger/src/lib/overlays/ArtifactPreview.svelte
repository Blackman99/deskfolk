<script lang="ts">
	import type { AnchorOf, Annotation, AnnotationAnchor, AnnotationAnchorKind, Attachment, CreateAnnotationRequest, PatchAnnotationRequest, SessionSummary, TaskArtifacts } from '@real-bot/protocol';
	import type { EncodedCrop } from '../annotations/region-box.ts';
	import { ANNOTATION_BATCH_MAX, describeAnchor } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';
	import { ApiError, etagForBlob, originalSizeForBlob } from '../api.ts';
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
	import type { MediaSourceHandle } from '../remote/media-source.ts';
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
	import ArtifactTreeMenu from './ArtifactTreeMenu.svelte';
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';
	import { formatFileSize } from '../chat/attachments.ts';
	import {
		fileProgressPercent,
		formatFileProgress,
		type FileProgress,
	} from '../file-progress.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import MessageImageLightbox, { type ImageOrigin } from '../chat/MessageImageLightbox.svelte';
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
	/**
	 * A picture enlarged over the whole app, the way one in a message is: this file when it is an
	 * image (`own`, shown from the bytes already here), or an image in this Markdown. Only while
	 * the preview still shows the file it was opened from, so it never outlives what it borrows.
	 */
	let enlarged = $state<{ from: string; relpath: string; own: boolean; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
	const shownEnlarged = $derived(enlarged?.from === relpath ? enlarged : null);
	let text = $state<string | null>(null);
	let missing = $state(false);
	let loading = $state(false);
	let progress = $state<FileProgress | null>(null);
	let loadPercent = $derived(progress ? fileProgressPercent(progress) : null);
	let loadBytes = $derived(progress ? formatFileProgress(progress, formatFileSize) : null);
	/**
	 * Remotely a picture opens as the Mac's 1600 px copy; this is the original's length while that
	 * copy is on screen, and the pane offers the original.
	 */
	let reducedFrom = $state<number | null>(null);
	let originalProgress = $state<FileProgress | null>(null);
	let originalBytes = $derived(originalProgress ? formatFileProgress(originalProgress, formatFileSize) : null);
	let openHint = $state(false);
	let wrap = $state(true);
	let showSource = $state(false);
	/** The file-tree row that was right-clicked, and where its menu hangs. */
	let treeMenu = $state<{ node: ArtifactTreeNode; x: number; y: number } | null>(null);
	let liveBlob: string | null = null;
	let mediaSource: MediaSourceHandle | null = null;
	/** The clip on screen plays from pieces fetched as it goes (remote), so no whole-file hash exists. */
	let streamed = $state(false);
	let loadGen = 0;
	/** The read behind the file on screen. Another file, or closing, stops it rather than letting it finish ahead of the next. */
	let loadAbort: AbortController | null = null;
	/** The key of the bytes on screen; a repeat of it must not swap the object URL. */
	let loadedKey: string | null = null;
	let loadedClient: MessengerApi | null = null;
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
	/** The file's frame (it holds the scroller), and how far down the composer sits so it clears the view's own toolbar. */
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
			// The composer is pinned to the frame, over the scroller, so a bar is measured from the
			// frame's top as it is on screen.
			const top = body.getBoundingClientRect().top;
			let bottom = 0;
			for (const bar of body.querySelectorAll<HTMLElement>('[data-annotator-bar]')) {
				bottom = Math.max(bottom, bar.getBoundingClientRect().bottom - top);
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

	/**
	 * Annotate mode on or off. Remotely a picture opens as the Mac's smaller copy, whose size and
	 * hash are not the file's: a box is drawn on the original, so that is fetched first.
	 */
	async function toggleAnnotMode(): Promise<void> {
		if (annotMode) {
			annotMode = false;
			cancelDraft();
			return;
		}
		if (kind === 'image' && reducedFrom !== null) {
			const path = relpath;
			await loadOriginal();
			// Still the copy (the original did not come), or another file by now: stay out of the mode.
			if (reducedFrom !== null || relpath !== path) return;
		}
		annotMode = true;
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
	/**
	 * Whether `loadedEtag` is this file's: an annotation is stored against the file's hash, and the
	 * one before it belongs to the file shown before. Save keeps using `loadedEtag` either way, so a
	 * stale buffer meets the daemon's 409 rather than landing on another file.
	 */
	let hashFresh = $state(false);
	/** The PDF's bytes, for the pdf.js viewer. */
	let pdfBlob = $state<Blob | null>(null);
	let pdfViewer = $state<{ openFind: () => void; closeFind: () => boolean } | null>(null);
	/** An SVG's source, kept so an image annotation can size a drawing that declares no size. */
	let svgRaw = $state<string | null>(null);
	const contentSha = $derived(hashFresh ? contentShaFromEtag(loadedEtag) : null);
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
	const treeLabel = $derived(mode === 'workspace' ? t.stream.workspaceExplorer : t.stream.artifactTree);
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
	let titleName = $derived(
		attachment?.original_filename ??
			(relpath ? (relpath.split('/').pop() ?? relpath) : t.stream.workspaceExplorer)
	);
	let canShowSource = $derived(kind === 'text' || kind === 'markdown' || kind === 'html');
	let sourceMode = $derived(kind === 'text' || (canShowSource && showSource));
	let byteSource = $derived(artifactByteSource({ mode, relpath, attachment }));
	let remoteClient = $derived(api?.kind === 'remote');
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
	/** Markdown and single-file HTML can be read rendered or as source. */
	let canToggleSource = $derived(kind === 'markdown' || kind === 'html');
	/**
	 * The pane has no toolbar: annotating keeps one thin row of its own, and only on a file it
	 * applies to — its list (which says why nothing new can be added when that is so), annotate
	 * mode for the kinds drawn with the pointer, and in the source view the line on how to add one.
	 */
	const showAnnotToggle = $derived(
		mode !== 'workspace' && (fileAnnotations.length > 0 || gate.ok || gate.reason !== 'kind')
	);
	const showAnnotMode = $derived(mode !== 'workspace' && needsMode && gate.ok);
	const annotHint = $derived<'' | 'dirty' | 'no-target' | 'streamed' | null>(
		mode !== 'workspace' && gate.ok && gate.adapter === 'media' && streamed && !loading && contentSha === null
			? 'streamed'
			: mode === 'workspace' || !sourceMode || text === null
				? null
				: gate.ok
					? ''
					: gate.reason === 'dirty' || gate.reason === 'no-target'
						? gate.reason
						: null
	);

	$effect(() => {
		const path = relpath;
		const previewKind = kind;
		const source = byteSource;
		const key = previewLoadKey({ path, kind: previewKind, source, attachmentId: attachment?.id });
		// Losing the citing message flips the source, not the file: reloading here would restart a
		// playing video every time you switch sessions or continue an interrupted turn.
		const client = api;
		if (key !== null && key === loadedKey && client === loadedClient) return;
		loadedKey = key;
		loadedClient = client;
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
		loadGen += 1;
		revoke();
		loadAbort?.abort();
		taskTreeAbort?.abort();
		// Anything still in flight for this pane belongs to a listing that is gone.
		treeGeneration += 1;
	});

	function revoke(): void {
		mediaSource?.dispose();
		mediaSource = null;
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

	async function loadPreview(
		path: string,
		previewKind: ArtifactKind,
		source: ReturnType<typeof artifactByteSource>,
		att: Attachment | null,
	): Promise<void> {
		const gen = ++loadGen;
		if (mediaSource) revoke();
		loadAbort?.abort();
		loadAbort = null;
		missing = false;
		openHint = false;
		progress = null;
		// The last file's hash is not this one's. A clip streamed in pieces never gets one, and a
		// spot picked on it must not be saved against the file shown before it.
		hashFresh = false;
		streamed = false;
		reducedFrom = null;
		originalProgress = null;
		if (!source || !api || previewKind === 'directory' || !isInAppPreviewKind(previewKind)) {
			if (gen !== loadGen) return;
			loading = false;
			revoke();
			text = null;
			diskText = null;
			return;
		}
		loading = true;
		const abort = new AbortController();
		loadAbort = abort;
		const size = previewKind === 'image' && api.kind === 'remote' ? ('preview' as const) : undefined;
		progress = {
			loaded: 0,
			// The attachment's size is the original's, which is not what a copy will weigh.
			total: !size && typeof att?.size === "number" && att.size > 0 ? att.size : null,
		};
		try {
			const onProgress = (next: FileProgress) => {
				if (gen !== loadGen) return;
				progress = {
					loaded: next.loaded,
					total: next.total ?? progress?.total ?? null,
				};
			};
			if ((previewKind === 'audio' || previewKind === 'video') && api.kind === 'remote' && api.openMediaSource) {
				const stream = await api.openMediaSource({ path, ...(source === 'attachment' && att ? { attachmentId: att.id } : {}) }, abort.signal, () => {
					if (gen !== loadGen) return;
					missing = true;
					abort.abort();
				});
				if (gen !== loadGen || abort.signal.aborted) { stream?.dispose(); return; }
				if (stream) {
					revoke();
					mediaSource = stream;
					streamed = true;
					blobUrl = stream.url;
					text = null;
					diskText = null;
					return;
				}
			}
			const blob =
				source === 'attachment' && att
					? await api.getAttachmentBlob(att.id, onProgress, { signal: abort.signal, size })
					: await api.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal, size });
			if (gen !== loadGen) return;
			loadedEtag = etagForBlob(blob);
			hashFresh = true;
			reducedFrom = size ? originalSizeForBlob(blob) : null;
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

	/** The picture itself, in place of the copy on screen. The copy stays up while it arrives. */
	async function loadOriginal(): Promise<void> {
		const client = api;
		const total = reducedFrom;
		const att = attachment;
		const path = relpath;
		const source = byteSource;
		if (!client || total === null || originalProgress) return;
		const gen = loadGen;
		loadAbort?.abort();
		const abort = new AbortController();
		loadAbort = abort;
		originalProgress = { loaded: 0, total };
		try {
			const onProgress = (next: FileProgress) => {
				if (gen !== loadGen) return;
				originalProgress = { loaded: next.loaded, total: next.total ?? total };
			};
			const blob =
				source === 'attachment' && att
					? await client.getAttachmentBlob(att.id, onProgress, { signal: abort.signal })
					: await client.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal });
			if (gen !== loadGen) return;
			const next = URL.createObjectURL(blob);
			if (liveBlob) URL.revokeObjectURL(liveBlob);
			liveBlob = next;
			blobUrl = next;
			// The copy's hash was the copy's; an annotation names the file's.
			loadedEtag = etagForBlob(blob);
			hashFresh = true;
			reducedFrom = null;
		} catch {
			// The copy stays on screen, and so does the offer.
		} finally {
			if (gen === loadGen) originalProgress = null;
		}
	}

	/**
	 * Open this tree row with the system, or reveal it in Finder. A failure stays a quiet hint on
	 * the preview: the browser build has no system opener, and downloading the file from here was
	 * the old toolbar's job.
	 */
	async function openOnDisk(path: string, reveal: boolean): Promise<void> {
		const abs = workspacePath ? absWorkspacePath(workspacePath, path) : null;
		if (!abs || remoteClient) {
			openHint = true;
			return;
		}
		const ok = await openWorkspacePath(abs, reveal);
		if (!ok) openHint = true;
	}

	function openTreeMenu(node: ArtifactTreeNode, event: MouseEvent): void {
		treeMenu = { node, x: event.clientX, y: event.clientY };
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
		if (!api || !relpath || !canSave || loading || missing) return false;
		saving = true;
		saveError = false;
		saveConflict = false;
		try {
			const value = editor?.getValue() ?? text ?? '';
			loadedEtag = await api.putWorkspaceFile(relpath, value, loadedEtag);
			hashFresh = true;
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
		else if (nav?.kind === 'leave') nav.after();
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

	function toggleSource(): void {
		// Leaving the source view carries an edit over to the rendered one — only an edit: the
		// model's own line-ending folding is not one, and a buffer brought back to the disk by hand
		// is the disk again, not the old carried edit.
		if (editor) text = editor.isDirty() ? editor.getValue() : (diskText ?? text);
		showSource = !showSource;
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
	<!--
		A phone has no workbench tab to name or close this pane, so it keeps one thin bar: back,
		and the file's name. The desktop names the file on its tab and closes it there.
	-->
	<header class="artifact-pane-head">
		<button type="button" class="artifact-back" aria-label={t.common.back} onclick={() => requestClose()}>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
				<polyline points="15 18 9 12 15 6"></polyline>
			</svg>
		</button>
		<h2 class:is-dirty={dirty} title={titleName}>{titleName}</h2>
	</header>
	{#if saveError}
		<p class="muted artifact-save-error pt-0 px-8 pb-3">{saveConflict ? t.stream.artifactSaveConflict : t.stream.artifactSaveFailed}</p>
	{/if}
	{#if showAnnotToggle || showAnnotMode || annotHint !== null}
		<div class="artifact-annot-bar" data-annotation-bar>
			{#if annotHint !== null}
				<p class="artifact-annot-hint" data-annotation-hint={annotHint}>
					{annotHint === 'dirty'
						? t.stream.annotationDirtyHint
						: annotHint === 'no-target'
							? t.stream.annotationNoTarget
							: annotHint === 'streamed'
								? t.stream.annotationStreamedHint
								: t.stream.annotationAddHint}
				</p>
			{:else}
				<span class="artifact-annot-spacer"></span>
			{/if}
			{#if showAnnotMode}
				<button
					type="button"
					class="artifact-annot-btn"
					class:is-on={annotMode}
					aria-pressed={annotMode}
					disabled={originalProgress !== null || loading}
					onclick={() => void toggleAnnotMode()}
					data-annotation-mode
				>{annotMode ? t.stream.annotationModeExit : t.stream.annotationMode}</button>
			{/if}
			{#if showAnnotToggle}
				<button
					type="button"
					class="artifact-annot-btn artifact-annot-toggle"
					class:is-on={annotOpen}
					aria-pressed={annotOpen}
					onclick={() => (annotOpen = !annotOpen)}
					data-annotation-toggle
				>{t.stream.annotationsTitle}{fileAnnotations.length > 0 ? ` (${fileAnnotations.length})` : ''}</button>
			{/if}
		</div>
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
				onContextMenu={openTreeMenu}
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
				class="artifact-pane-body flex-1 min-h-0 min-w-0"
				class:is-editor={sourceMode && text !== null}
			>
				<!-- Not while elements are being picked: the pill would sit on the picker's own bar. -->
				{#if canToggleSource && text !== null && !(annotMode && viewAdapter === 'html')}
					<button
						type="button"
						class="artifact-source-toggle"
						aria-pressed={showSource}
						onclick={toggleSource}
					>
						{#if showSource}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
								<circle cx="12" cy="12" r="3"></circle>
							</svg>
							{t.stream.artifactRendered}
						{:else}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="16 18 22 12 16 6"></polyline>
								<polyline points="8 6 2 12 8 18"></polyline>
							</svg>
							{t.stream.artifactSource}
						{/if}
					</button>
				{/if}
				{#if kind === 'image' && blobUrl && !loading && reducedFrom !== null}
					<button
						type="button"
						class="artifact-source-toggle artifact-original-toggle"
						aria-busy={originalProgress ? 'true' : undefined}
						disabled={originalProgress !== null}
						onclick={loadOriginal}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="3" y="3" width="18" height="18" rx="2"></rect>
							<circle cx="9" cy="9" r="2"></circle>
							<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>
						</svg>
						{originalProgress ? t.stream.imageOriginalLoading(originalBytes) : t.stream.imageOriginal(formatFileSize(reducedFrom))}
					</button>
				{/if}
				<div class="artifact-pane-scroll">
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
							<!--
								A box is drawn on the picture itself: a remote copy has neither the original's size nor
								its hash, so it takes no new box (annotate mode fetches the original first).
							-->
							<ImageAnnotator
								src={blobUrl}
								alt={relpath}
								isSvg={kind === 'svg'}
								svgText={svgRaw}
								annotations={viewAnnotations}
								focusId={annotFocus}
								focusSeq={annotFocusSeq}
								active={annotMode}
								enabled={gate.ok && gate.adapter === 'image' && !pendingDraft && reducedFrom === null}
								labels={t.stream.annotImage}
								onDraft={(draft) => offerDraft('image_region', draft.anchor, draft.crop)}
								onPick={pickAnnotation}
								pending={pendingOf('image_region')}
								onPendingChange={movePending}
								onCancel={escapeAnnotation}
								openLabel={`${t.stream.artifactEnlarge} ${relpath.split('/').pop() ?? relpath}`}
								onOpen={(img) => enlarge(relpath, true, img)}
							/>
						{/if}
					{:else if (kind === "audio" || kind === "video") && blobUrl}
						<!-- Streamed remotely the clip has no whole-file hash to hang a new point on. -->
						<MediaAnnotator
							src={blobUrl}
							kind={kind}
							annotations={viewAnnotations}
							focusId={annotFocus}
							focusSeq={annotFocusSeq}
							enabled={gate.ok && gate.adapter === 'media' && !pendingDraft && contentSha !== null}
							labels={t.stream.annotMedia}
							onDraft={(draft) => offerDraft('media_time', draft.anchor, draft.crop)}
							onPick={pickAnnotation}
							pending={pendingOf('media_time')}
							onPendingChange={movePending}
							onCancel={escapeAnnotation}
							onError={() => {
								missing = true;
								loadAbort?.abort();
							}}
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
							onOpenImage={(path, from) => enlarge(path, false, from?.querySelector('img, .md-artifact-pending') ?? from)}
							loadArtifactImage={(path) => {
								if (!api) return Promise.reject(new Error('API unavailable'));
								// A picture inside a note is a 72 px chip: the 256 px copy is plenty, and tapping it
								// enlarges to the 1600 px copy with the original on offer.
								return api.getWorkspaceFileBlob(path, undefined, { size: 'thumb' });
							}}
						/>
					{:else}
						<p class="muted">{attachment?.original_filename ?? relpath}</p>
					{/if}
					{#if openHint}
						<p class="muted">{t.stream.artifactOpenUnavailable}</p>
					{/if}
				</div>
				<!-- Pinned to the frame, over the file: it stays in view while the file scrolls under it. -->
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
{#if treeMenu}
	<ArtifactTreeMenu
		x={treeMenu.x}
		y={treeMenu.y}
		{t}
		onOpen={() => void openOnDisk(treeMenu?.node.path ?? '', false)}
		onReveal={() => void openOnDisk(treeMenu?.node.path ?? '', true)}
		onClose={() => (treeMenu = null)}
	/>
{/if}
{#if shownEnlarged}
	<MessageImageLightbox
		attachment={shownEnlarged.own ? attachment : null}
		relpath={shownEnlarged.relpath}
		src={shownEnlarged.own ? blobUrl : null}
		srcOriginalSize={shownEnlarged.own ? reducedFrom : null}
		placeholder={shownEnlarged.placeholder}
		origin={shownEnlarged.origin}
		{api}
		{t}
		onClose={() => (enlarged = null)}
	/>
{/if}
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
		height: 100%;
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

	/*
	 * The desktop names and closes this pane on the workbench tab, so the bar is a phone thing.
	 * Keeping it in the document (rather than not rendering it) means a test can still read it.
	 */
	.artifact-pane-head {
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

	.artifact-pane-body {
		position: relative;
		overflow: hidden;
	}

	/*
	 * The file scrolls. The source toggle does not: it stays pinned to this pane's top-right,
	 * over whatever has scrolled past.
	 */
	.artifact-pane-scroll {
		height: 100%;
		min-height: 0;
		overflow: auto;
		padding: 16px;
	}

	.artifact-source-toggle {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 4;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 28px;
		padding: 0 10px 0 8px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: color-mix(in srgb, var(--pane) 88%, transparent);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: var(--shadow-xs);
	}

	.artifact-source-toggle svg {
		flex-shrink: 0;
	}

	.artifact-source-toggle:hover {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.artifact-source-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.artifact-original-toggle {
		max-width: calc(100% - 32px);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.artifact-original-toggle:disabled {
		cursor: progress;
	}

	.artifact-pane-body.is-editor .artifact-source-toggle {
		top: 8px;
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
	/* Annotating's own row, where the toolbar used to be: the how-to line, annotate mode, the list. */
	.artifact-annot-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 4px 12px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		flex-shrink: 0;
	}
	.artifact-annot-hint {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--muted);
	}
	.artifact-annot-spacer {
		flex: 1;
	}
	.artifact-annot-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		height: 26px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
	}
	.artifact-annot-btn:hover,
	.artifact-annot-btn.is-on {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}
	.artifact-annot-btn:disabled {
		cursor: progress;
		opacity: 0.6;
	}
	.artifact-annot-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.artifact-pane-body.is-editor {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.artifact-pane-body.is-editor .artifact-pane-scroll {
		flex: 1;
		min-height: 0;
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
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

	.artifact-pane-main.has-tree {
		display: grid;
		grid-template-rows: minmax(0, 1fr);
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

		.artifact-source-toggle {
			top: 10px;
			height: 36px;
			padding: 0 14px 0 12px;
		}

		.artifact-source-toggle svg {
			width: 16px;
			height: 16px;
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
			/* The list is worth more than the sliver of file behind it: it runs as far as the
			   bottom of the sheet, and only stops early when it has nothing more to show. */
			max-height: 100%;
			overscroll-behavior: contain;
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

		.artifact-pane-scroll {
			padding: 12px;
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

		.artifact-annot-btn {
			height: 32px;
			padding: 0 12px;
		}
	}
</style>
