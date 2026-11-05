<script lang="ts">
	import Icon from '../Icon.svelte';
	import { formatFileSize } from './attachments.ts';
	import type { Copy } from '../copy.ts';
	import type { StagedAttachment, StagedWorkspacePath } from '../session-view.svelte.ts';
	import FileIcon from '../overlays/FileIcon.svelte';
	import { fileIconFor } from '../overlays/file-icon.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import MessageImageLightbox, { type ImageOrigin } from './MessageImageLightbox.svelte';
	import { pictureOrigin, pictureStandIn } from './enlarged-images.ts';

	type Props = {
		t: Copy;
		/** A staged workspace picture enlarges from the Mac's bytes; a pasted one is already here. */
		api: MessengerApi | null;
		pendingAttachments: StagedAttachment[];
		pendingPaths: StagedWorkspacePath[];
		/** A send from this conversation is in flight: the chips stay as the sign of it and cannot be taken back. */
		sending: boolean | undefined;
		uploadedPercent: (file: File) => number | null;
		onRemoveAttachment: (id: string) => void;
		onRemovePath: (id: string) => void;
	};

	let { t, api, pendingAttachments, pendingPaths, sending, uploadedPercent, onRemoveAttachment, onRemovePath }: Props = $props();

	/**
	 * A staged picture enlarged over the whole app, the way one in a message is. Found by its row
	 * each time: a send or ✕ revokes the row's object URL, and the enlargement goes with the row
	 * instead of showing a picture that is no longer there.
	 */
	let enlarged = $state<{ id: string; origin: ImageOrigin | null; placeholder: string | null } | null>(null);
	const enlargedFile = $derived.by(() => {
		const id = enlarged?.id;
		return id ? (pendingAttachments.find((row) => row.id === id && row.previewUrl) ?? null) : null;
	});
	const enlargedPath = $derived.by(() => {
		const id = enlarged?.id;
		return id && !enlargedFile ? (pendingPaths.find((row) => row.id === id && row.previewUrl) ?? null) : null;
	});

	function enlarge(id: string, ev: MouseEvent): void {
		const from = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
		enlarged = { id, origin: pictureOrigin(from), placeholder: pictureStandIn(from) };
	}
</script>

<div class="composer-attachments-bar">
	{#each pendingAttachments as att (att.id)}
		{@const uploaded = uploadedPercent(att.file)}
		<div class="composer-attachment-item" class:is-img={att.isImage}>
			{#if att.isImage && att.previewUrl}
				<button
					type="button"
					class="attachment-preview-btn"
					title="{t.stream.artifactEnlarge} {att.name}"
					aria-label="{t.stream.artifactEnlarge} {att.name}"
					onclick={(ev) => enlarge(att.id, ev)}
				>
					<img src={att.previewUrl} alt={att.name} class="attachment-preview-img" data-copy-image />
				</button>
			{:else}
				<div class="attachment-file-icon">
					<Icon name="file" />
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
				aria-label="{t.composer.removeAttachment} {att.name}"
				disabled={sending}
				onclick={() => onRemoveAttachment(att.id)}
			>
				<Icon name="x" size={12} />
			</button>
		</div>
	{/each}
	{#each pendingPaths as ref (ref.id)}
		<div class="composer-attachment-item is-workspace-ref" class:is-img={Boolean(ref.previewUrl)} title="{ref.path} · {t.composer.workspaceRef}">
			{#if ref.previewUrl}
				<!-- Only a picture gets a preview (the Mac's 256 px copy); enlarged, the picture itself comes. -->
				<button
					type="button"
					class="attachment-preview-btn"
					title="{t.stream.artifactEnlarge} {ref.name}"
					aria-label="{t.stream.artifactEnlarge} {ref.name}"
					onclick={(ev) => enlarge(ref.id, ev)}
				>
					<img src={ref.previewUrl} alt={ref.name} class="attachment-preview-img" />
				</button>
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
				<Icon name="x" size={12} />
			</button>
		</div>
	{/each}
</div>

{#if enlargedFile || enlargedPath}
	<!-- Moves itself to <body>: the composer is a floating, click-through layer. -->
	<MessageImageLightbox
		src={enlargedFile?.previewUrl ?? null}
		label={enlargedFile?.name ?? null}
		relpath={enlargedPath?.path ?? null}
		placeholder={enlargedPath ? (enlarged?.placeholder ?? null) : null}
		origin={enlarged?.origin ?? null}
		{api}
		{t}
		onClose={() => (enlarged = null)}
	/>
{/if}

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

	/* The thumbnail opens the picture, as one in a message does. */
	.attachment-preview-btn {
		display: block;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		cursor: zoom-in;
	}

	.attachment-preview-btn .attachment-preview-img {
		display: block;
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
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: none;
		background: color-mix(in srgb, var(--ink) 8%, transparent);
		color: var(--muted);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.attachment-delete-btn:hover:not(:disabled) {
		background: var(--danger);
		color: var(--on-danger);
	}

	.attachment-delete-btn:active:not(:disabled) {
		transform: scale(0.9);
	}

	/* A file added to the message pops into the row rather than appearing all at once. */
	.composer-attachment-item {
		animation: attachment-in var(--dur-base) var(--ease-out);
	}

	@keyframes attachment-in {
		from {
			opacity: 0;
			transform: scale(0.94);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	/* On its way to the Mac: the chip stays as the sign of it, and cannot be taken back. */
	.attachment-delete-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
