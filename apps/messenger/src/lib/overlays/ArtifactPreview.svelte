<script lang="ts">
	import type { Attachment, TaskArtifacts } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { onPaneResize } from '../workbench/pane-resize.svelte.ts';
	import { ApiError, etagForBlob, originalSizeForBlob } from '../api.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MediaSourceHandle } from '../remote/media-source.ts';
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
	/**
	 * Which file `blobUrl` holds. Picking another file changes `kind` at once while its bytes are
	 * still on the way, so a `<video>` was handed the picture before it, failed to play it, and
	 * left the video reading "file is gone".
	 */
	let blobPath = $state<string | null>(null);
	const shownBlob = $derived(blobPath === relpath ? blobUrl : null);
	/**
	 * A picture enlarged over the whole app, the way one in a message is: this file when it is an
	 * image (`own`, shown from the bytes already here), or an image in this Markdown. Only while
	 * the preview still shows the file it was opened from, so it never outlives what it borrows.
	 */
	let enlarged = $state<{ from: string; relpath: string; own: boolean; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
	const shownEnlarged = $derived(enlarged?.from === relpath ? enlarged : null);
	let text = $state<string | null>(null);
	let htmlSrc = $state<string | null>(null);
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
	let liveHtml: string | null = null;
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
	} | null>(null);
	let dirty = $state(false);
	let saving = $state(false);
	let saveError = $state(false);
	let saveConflict = $state(false);
	let loadedEtag = $state<string | null>(null);
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

	/** What this entry handed over, less what the Mac already knows is deleted: the tree is for opening files. */
	let ownPaths = $derived(
		siblings.filter((row) => row.exists !== false).map((row) => row.workspace_relpath)
	);
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
	let canSave = $derived(Boolean(api && relpath && canShowSource && sourceMode && text !== null));
	/** Markdown and single-file HTML can be read rendered or as source. */
	let canToggleSource = $derived(kind === 'markdown' || kind === 'html');

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
		mediaSource?.dispose();
		mediaSource = null;
		if (liveBlob) URL.revokeObjectURL(liveBlob);
		if (liveHtml) URL.revokeObjectURL(liveHtml);
		liveBlob = null;
		liveHtml = null;
		blobUrl = null;
		blobPath = null;
		htmlSrc = null;
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
		reducedFrom = null;
		originalProgress = null;
		if (!source || !api || previewKind === 'directory' || !isInAppPreviewKind(previewKind)) {
			if (gen !== loadGen) return;
			loading = false;
			revoke();
			text = null;
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
					blobUrl = stream.url;
					blobPath = path;
					text = null;
					return;
				}
			}
			const blob =
				source === 'attachment' && att
					? await api.getAttachmentBlob(att.id, onProgress, { signal: abort.signal, size })
					: await api.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal, size });
			if (gen !== loadGen) return;
			loadedEtag = etagForBlob(blob);
			reducedFrom = size ? originalSizeForBlob(blob) : null;
			if (previewKind === 'text' || previewKind === 'markdown' || previewKind === 'svg') {
				const raw = await blob.text();
				if (gen !== loadGen) return;
				if (previewKind === 'svg') {
					const next = URL.createObjectURL(await svgDisplayBlob(raw));
					if (gen !== loadGen) return;
					if (liveBlob) URL.revokeObjectURL(liveBlob);
					liveBlob = next;
					blobUrl = next;
					blobPath = path;
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
			blobPath = path;
			text = null;
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
			blobPath = path;
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
		editor?.revert(text ?? '');
		dirty = false;
		if (nav?.kind === 'close') {
			onClose();
			nav.afterClose?.();
		}
		else if (nav?.kind === 'node') commitSelect(nav.node);
		else if (nav?.kind === 'leave') nav.after();
	}

	export function closeFind(): boolean {
		return editor?.closeFind() ?? false;
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
		if (!sourceMode || !editor) return;
		if (!ev.shiftKey && key === 'f') {
			ev.preventDefault();
			ev.stopPropagation();
			editor.openFind();
		}
	}

	function toggleSource(): void {
		if (editor) text = editor.getValue();
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
		<div
			class="artifact-pane-body flex-1 min-h-0 min-w-0"
			class:is-editor={sourceMode && text !== null}
		>
			{#if canToggleSource && (sourceMode ? text !== null : kind === 'markdown' ? text !== null : htmlSrc !== null)}
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
			{#if kind === 'image' && shownBlob && !loading && reducedFrom !== null}
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
						path={relpath}
						{wrap}
						onDirty={(next) => (dirty = next)}
					/>
				{/if}
			{:else if kind === "image" || kind === "svg"}
				{#if shownBlob}
					<button
						type="button"
						class="artifact-img-open"
						aria-label={`${t.stream.artifactEnlarge} ${relpath.split('/').pop() ?? relpath}`}
						onclick={(ev) => enlarge(relpath, true, ev.currentTarget.querySelector('img'))}
					>
						<img src={shownBlob} alt={relpath} class="artifact-img max-w-full max-h-full block my-0 mx-auto" data-copy-image />
					</button>
				{/if}
			{:else if kind === "audio" && shownBlob}
				<audio controls preload="metadata" src={shownBlob} onerror={() => { missing = true; loadAbort?.abort(); }}></audio>
			{:else if kind === "video" && shownBlob}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video controls playsinline preload="metadata" src={shownBlob} onerror={() => { missing = true; loadAbort?.abort(); }}></video>
			{:else if kind === "pdf" && shownBlob}
				<iframe title={relpath} class="artifact-frame" src={shownBlob}></iframe>
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
		</div>
	</div>
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
		src={shownEnlarged.own ? shownBlob : null}
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

	.artifact-frame {
		width: 100%;
		height: 100%;
		min-height: 280px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	/*
	 * The button fills the body so the picture keeps fitting exactly as it did, and it lets the
	 * pointer through: only the picture is a target, not the empty space around a small one.
	 */
	.artifact-img-open {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: none;
		pointer-events: none;
	}

	.artifact-img-open .artifact-img {
		pointer-events: auto;
		cursor: zoom-in;
	}

	.artifact-img-open:focus-visible {
		outline: none;
	}

	.artifact-img-open:focus-visible .artifact-img {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
	}
</style>
