<script lang="ts">
	import type { Attachment } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { artifactKind, handedOverPaths, isInlineImageName, svgDisplayBlob } from '../overlays/artifacts.ts';
	import { buildCitedPathTree, citedBundleRoot, countCitedFiles } from '../overlays/artifact-tree.ts';
	import { onDestroy } from 'svelte';
	import { whenVisible } from '../when-visible.ts';

	interface Props {
		attachments: Attachment[];
		/** Message body, so a bare `附件：<path>` line still becomes a chip on messages stored earlier. */
		body?: string | null;
		api: MessengerApi | null;
		t: Copy;
		onPreview: (att: Attachment) => void;
		/** A picture stays in the app. `from` is the control the picture grows out of. */
		onOpenImage?: (att: Attachment, from?: HTMLElement) => void;
	}

	let { attachments, body = null, api, t, onPreview, onOpenImage }: Props = $props();

	let thumbs = $state<Record<string, string>>({});
	let missing = $state<Record<string, true>>({});
	/** Picture chips whose bytes are still on the way. A file icon is not a picture loading. */
	let pendingThumbs = $state<Record<string, true>>({});
	const rows = $derived(withHandoffRows(attachments, body));
	const tree = $derived(buildCitedPathTree(rows.map((row) => row.workspace_relpath)));
	const fileCount = $derived(countCitedFiles(tree));
	const bundle = $derived(citedBundleRoot(tree));
	const collapse = $derived(rows.length > 1);
	const previewTarget = $derived(rows.length > 0 ? firstPreviewable(rows) : null);

	function withHandoffRows(stored: Attachment[], source: string | null): Attachment[] {
		const paths = handedOverPaths(source ?? "", stored.map((row) => row.workspace_relpath));
		return paths.map((path) => {
			const existing = stored.find((row) => row.workspace_relpath === path);
			if (existing) return existing;
			const owner = stored[0];
			return {
				id: `handoff:${path}`,
				message_id: owner?.message_id ?? "",
				workspace_relpath: path,
				original_filename: path.split("/").pop() || path,
				created_at: owner?.created_at ?? "",
				exists: missing[path] ? false : undefined,
			};
		});
	}

	/** Ids already requested. Clearing the spinner writes state, and that must not fetch again. */
	let started = new Set<string>();
	/**
	 * A chip is 36 px, so it asks for the Mac's 256 px copy rather than the original. Remotely the
	 * pictures share one link with everything else: they wait behind anything opened on purpose,
	 * and a chat left behind stops asking for them.
	 */
	const thumbLoads = new AbortController();

	async function loadThumb(att: Attachment): Promise<void> {
		if (!api || started.has(att.id)) return;
		const kind = artifactKind(att.original_filename, { isDir: att.is_dir });
		if ((kind !== "image" && kind !== "svg") || att.exists === false || att.is_dir) return;
		started.add(att.id);
		pendingThumbs = { ...pendingThumbs, [att.id]: true };
		const options = { background: true, signal: thumbLoads.signal, size: 'thumb' as const };
		try {
			const blob = att.id.startsWith("handoff:")
				? await api.getWorkspaceFileBlob(att.workspace_relpath, undefined, options)
				: await api.getAttachmentBlob(att.id, undefined, options);
			const thumb = kind === "svg" ? await svgDisplayBlob(blob) : blob;
			if (thumbLoads.signal.aborted) return;
			thumbs = { ...thumbs, [att.id]: URL.createObjectURL(thumb) };
		} catch {
			if (thumbLoads.signal.aborted) return;
			if (att.id.startsWith("handoff:")) missing = { ...missing, [att.workspace_relpath]: true };
		} finally {
			if (pendingThumbs[att.id]) {
				const next = { ...pendingThumbs };
				delete next[att.id];
				pendingThumbs = next;
			}
		}
	}


	onDestroy(() => {
		thumbLoads.abort();
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
	});

	function firstPreviewable(rows: Attachment[]): Attachment {
		return (
			rows.find((row) => row.exists !== false && !row.is_dir) ??
			rows.find((row) => row.exists !== false) ??
			rows[0]!
		);
	}

	/** A bundle is several files, so it opens the preview with its tree even when all are pictures. */
	function openBundle(): void {
		if (previewTarget) onPreview(previewTarget);
	}

	function openRow(att: Attachment, ev: MouseEvent): void {
		if (onOpenImage && isInlineImageName(att.original_filename, { isDir: att.is_dir })) {
			onOpenImage(att, ev.currentTarget instanceof HTMLElement ? ev.currentTarget : undefined);
			return;
		}
		onPreview(att);
	}
</script>

{#if rows.length > 0}
	{#if collapse}
		<button
			type="button"
			class="attachment-bundle-btn mt-4"
			onclick={openBundle}
			title={rows.map((row) => row.workspace_relpath).join("\n")}
		>
			<div class="file-icon-box text-accent flex items-center" aria-hidden="true">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
			</div>
			<div class="file-meta-col flex flex-col min-w-0 max-w-[170px]">
				<span class="file-title text-12 font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{bundle ?? t.stream.artifactBundle}</span>
				<span class="file-sub text-10 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{t.stream.artifactBundleCount(fileCount)}</span>
			</div>
		</button>
	{:else}
		<div class="msg-attachments-grid flex flex-wrap gap-4 mt-4">
			{#each rows as att (att.id)}
				{@const thumb = thumbs[att.id]}
				{@const thumbPending = !thumb && pendingThumbs[att.id] === true}
				<!-- A picture is fetched once its chip is scrolled near, not when the transcript loads. A
				     bundle has no chips, so a folder of pictures fetches nothing until it is opened. -->
				<button
					type="button"
					class="attachment-file-btn"
					class:is-thumb-pending={thumbPending}
					use:whenVisible={() => void loadThumb(att)}
					onclick={(ev) => openRow(att, ev)}
					title={att.workspace_relpath}
					aria-busy={thumbPending ? 'true' : undefined}
				>
					{#if thumb}
						<img src={thumb} alt="" class="attachment-chip-thumb" data-copy-image />
					{:else if thumbPending}
						<span class="attachment-chip-pending" role="status">
							<span class="attachment-chip-ring" aria-hidden="true"></span>
							<span class="sr-only">{t.stream.artifactLoading}</span>
						</span>
					{:else}
						<div class="file-icon-box text-accent flex items-center">
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
						</div>
					{/if}
					<div class="file-meta-col flex flex-col min-w-0 max-w-[170px]">
						<span class="file-title text-12 font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{att.original_filename}</span>
						<span class="file-sub mono text-10 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{att.workspace_relpath}</span>
					</div>
				</button>
			{/each}
		</div>
	{/if}
{/if}

<style>

	.attachment-file-btn,
	.attachment-bundle-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
		transition: all 0.15s ease;
		color: var(--ink);
	}

	/* A bubble narrowed by the window holds its chip: the name and path give way, not the bubble edge. */
	.attachment-file-btn {
		max-width: 100%;
	}

	.attachment-bundle-btn {
		max-width: min(100%, 280px);
	}

	.attachment-file-btn:hover,
	.attachment-bundle-btn:hover {
		border-color: var(--accent);
		box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
	}

	.attachment-chip-thumb,
	.attachment-chip-pending {
		width: 36px;
		height: 36px;
		border-radius: 6px;
		flex-shrink: 0;
		background: var(--line-subtle);
	}

	.attachment-chip-thumb {
		object-fit: cover;
	}

	.attachment-chip-pending {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.attachment-chip-ring {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		animation: attachment-chip-spin 0.9s linear infinite;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@keyframes attachment-chip-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.attachment-chip-ring {
			animation: none;
			border-top-color: var(--accent);
		}
	}
</style>
