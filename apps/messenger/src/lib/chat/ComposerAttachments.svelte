<script lang="ts">
	import { formatFileSize } from './attachments.ts';
	import type { Copy } from '../copy.ts';
	import type { StagedAttachment, StagedWorkspacePath } from '../session-view.svelte.ts';
	import FileIcon from '../overlays/FileIcon.svelte';
	import { fileIconFor } from '../overlays/file-icon.ts';

	type Props = {
		t: Copy;
		pendingAttachments: StagedAttachment[];
		pendingPaths: StagedWorkspacePath[];
		/** A send from this conversation is in flight: the chips stay as the sign of it and cannot be taken back. */
		sending: boolean | undefined;
		uploadedPercent: (file: File) => number | null;
		onRemoveAttachment: (id: string) => void;
		onRemovePath: (id: string) => void;
	};

	let { t, pendingAttachments, pendingPaths, sending, uploadedPercent, onRemoveAttachment, onRemovePath }: Props = $props();
</script>

<div class="composer-attachments-bar">
	{#each pendingAttachments as att (att.id)}
		{@const uploaded = uploadedPercent(att.file)}
		<div class="composer-attachment-item" class:is-img={att.isImage}>
			{#if att.isImage && att.previewUrl}
				<img src={att.previewUrl} alt={att.name} class="attachment-preview-img" data-copy-image />
			{:else}
				<div class="attachment-file-icon">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
				</div>
			{/if}
			<div class="attachment-meta flex flex-col min-w-0 flex-1">
				<span class="attachment-name text-12 font-medium text-ink overflow-hidden text-ellipsis whitespace-nowrap" title={att.name}>{att.name}</span>
				<span class="attachment-size mono text-10 text-muted">{formatFileSize(att.size)}{uploaded === null ? '' : ` · ${t.composer.uploaded(uploaded)}`}</span>
			</div>
			<button
				type="button"
				class="attachment-delete-btn"
				title={t.composer.removeAttachment}
				aria-label="Remove attachment {att.name}"
				disabled={sending}
				onclick={() => onRemoveAttachment(att.id)}
			>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
			</button>
		</div>
	{/each}
	{#each pendingPaths as ref (ref.id)}
		<div class="composer-attachment-item is-workspace-ref" class:is-img={Boolean(ref.previewUrl)} title="{ref.path} · {t.composer.workspaceRef}">
			{#if ref.previewUrl}
				<img src={ref.previewUrl} alt={ref.name} class="attachment-preview-img" />
			{:else}
				<div class="attachment-file-icon">
					<FileIcon icon={fileIconFor(ref.path, { isDir: ref.isDir })} size={16} />
				</div>
			{/if}
			<div class="attachment-meta flex flex-col min-w-0 flex-1">
				<span class="attachment-name text-12 font-medium text-ink overflow-hidden text-ellipsis whitespace-nowrap">{ref.name}</span>
				<span class="attachment-size mono text-10 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{ref.path}</span>
			</div>
			<button
				type="button"
				class="attachment-delete-btn"
				title={t.composer.removeAttachment}
				aria-label="{t.composer.removeAttachment} {ref.name}"
				disabled={sending}
				onclick={() => onRemovePath(ref.id)}
			>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
			</button>
		</div>
	{/each}
</div>

<style>
	/* Pending Attachments in Composer */
	.composer-attachments-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--line-subtle);
		margin-bottom: 4px;
	}

	.composer-attachment-item {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 4px 8px 4px 6px;
		max-width: 220px;
	}

	.composer-attachment-item.is-img {
		padding: 4px 8px 4px 4px;
	}

	.attachment-preview-img {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		object-fit: cover;
		border: 1px solid var(--line);
		flex-shrink: 0;
	}

	.attachment-file-icon {
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		background: var(--pane);
		border: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		flex-shrink: 0;
	}

	.attachment-delete-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: none;
		background: rgba(18, 28, 32, 0.08);
		color: var(--muted);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}

	.attachment-delete-btn:hover:not(:disabled) {
		background: var(--danger);
		color: #ffffff;
	}

	/* On its way to the Mac: the chip stays as the sign of it, and cannot be taken back. */
	.attachment-delete-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
