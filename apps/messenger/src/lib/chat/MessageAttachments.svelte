<script lang="ts">
	import type { Attachment } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../remote/api.ts';
	import { artifactKind } from '../overlays/artifacts.ts';
	import { buildCitedPathTree, citedBundleRoot, countCitedFiles } from '../overlays/artifact-tree.ts';
	import { onDestroy, onMount } from 'svelte';

	interface Props {
		attachments: Attachment[];
		api: MessengerApi | null;
		t: Copy;
		onPreview: (att: Attachment) => void;
	}

	let { attachments, api, t, onPreview }: Props = $props();

	let thumbs = $state<Record<string, string>>({});
	const tree = $derived(buildCitedPathTree(attachments.map((row) => row.workspace_relpath)));
	const fileCount = $derived(countCitedFiles(tree));
	const bundle = $derived(citedBundleRoot(tree));
	const collapse = $derived(attachments.length > 1);
	const previewTarget = $derived(attachments.length > 0 ? firstPreviewable(attachments) : null);

	onMount(async () => {
		if (!api) return;
		for (const att of attachments) {
			const kind = artifactKind(att.original_filename, { isDir: att.is_dir });
			if ((kind === "image" || kind === "svg") && att.exists !== false && !att.is_dir) {
				try {
					const blob = await api.getAttachmentBlob(att.id);
					thumbs = { ...thumbs, [att.id]: URL.createObjectURL(blob) };
				} catch {
					// file card without thumb
				}
			}
		}
	});

	onDestroy(() => {
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
	});

	function firstPreviewable(rows: Attachment[]): Attachment {
		return (
			rows.find((row) => row.exists !== false && !row.is_dir) ??
			rows.find((row) => row.exists !== false) ??
			rows[0]!
		);
	}

	function openBundle(): void {
		if (previewTarget) onPreview(previewTarget);
	}
</script>

{#if attachments && attachments.length > 0}
	{#if collapse}
		<button
			type="button"
			class="attachment-bundle-btn mt-4 max-w-[280px]"
			onclick={openBundle}
			title={attachments.map((row) => row.workspace_relpath).join("\n")}
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
			{#each attachments as att (att.id)}
				{@const thumb = thumbs[att.id]}
				<button
					type="button"
					class="attachment-file-btn"
					onclick={() => onPreview(att)}
					title={att.workspace_relpath}
				>
					{#if thumb}
						<img src={thumb} alt="" class="attachment-chip-thumb" />
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

	.attachment-file-btn:hover,
	.attachment-bundle-btn:hover {
		border-color: var(--accent);
		box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
	}

	.attachment-chip-thumb {
		width: 36px;
		height: 36px;
		object-fit: cover;
		border-radius: 6px;
		flex-shrink: 0;
		background: #00000008;
	}
</style>
