<script lang="ts" module>
	/** How a download ended when it did not end in the file: the share sheet wants a fresh tap, or it failed. */
	export type FileDownloadNote = 'tap' | 'failed' | null;
</script>

<script lang="ts">
	/**
	 * Download for a file seen remotely. Its bytes cross only when asked for, unless the whole file
	 * is already here, and leaving the file cancels them, as it cancels a preview's read. On a phone
	 * the file goes to the share sheet when it takes that type, and otherwise to the browser's
	 * downloads (see `saveFile`).
	 */
	import { onDestroy } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { saveFile } from '../save-file.ts';
	import { formatFileSize } from '../chat/attachments.ts';
	import { fileProgressPercent, formatFileProgress, type FileProgress } from '../file-progress.ts';

	interface Props {
		api: MessengerApi | null;
		path: string;
		/** Read from the attachment rather than the workspace path, as the preview does. */
		attachmentId?: string | null;
		name: string;
		t: Copy;
		/**
		 * The whole file, when it is already here: saved in the same tap, so the share sheet opens
		 * on the first one. Never a scaled copy or a piece of a stream.
		 */
		ready?: Blob | null;
		/** `pill` in the middle of a pane, `compact` in a bar, `icon` in a header. */
		variant?: 'pill' | 'compact' | 'icon';
		/** Set for the caller to show; the pill and compact buttons also show it themselves unless `quiet`. */
		note?: FileDownloadNote;
		quiet?: boolean;
	}

	let {
		api,
		path,
		attachmentId = null,
		name,
		t,
		ready = null,
		variant = 'pill',
		note = $bindable(null),
		quiet = false,
	}: Props = $props();

	let busy = $state(false);
	let progress = $state<FileProgress | null>(null);
	/** Bytes the share sheet turned away because the tap was spent: the next tap hands them over. */
	let held: Blob | null = null;
	const abort = new AbortController();
	onDestroy(() => abort.abort());

	const label = $derived(
		busy ? t.stream.artifactDownloading(progress ? formatFileProgress(progress, formatFileSize) : null) : t.stream.artifactDownload,
	);
	const percent = $derived(progress ? fileProgressPercent(progress) : null);

	async function download(): Promise<void> {
		const client = api;
		if (!client || busy) return;
		note = null;
		try {
			// No await when the bytes are here: the share sheet has to open inside the tap.
			let blob = held ?? ready;
			if (!blob) {
				busy = true;
				progress = null;
				const onProgress = (next: FileProgress) => { progress = next; };
				blob = attachmentId
					? await client.getAttachmentBlob(attachmentId, onProgress, { signal: abort.signal })
					: await client.getWorkspaceFileBlob(path, onProgress, { signal: abort.signal });
				held = blob;
			}
			if (abort.signal.aborted) return;
			const outcome = await saveFile(blob, name);
			if (outcome === 'needs-tap') note = 'tap';
			else held = null;
		} catch {
			if (!abort.signal.aborted) note = 'failed';
		} finally {
			busy = false;
		}
	}
</script>

{#if variant === 'icon'}
	<button
		type="button"
		class="file-download-icon"
		class:is-ready={note === 'tap'}
		aria-label={t.stream.artifactDownload}
		title={label}
		aria-busy={busy ? 'true' : undefined}
		disabled={busy}
		onclick={() => void download()}
	>
		{#if busy && percent !== null}
			<span class="file-download-percent">{percent}%</span>
		{:else if busy}
			<span class="file-download-ring" aria-hidden="true"></span>
		{:else}
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>
		{/if}
	</button>
{:else}
	<button
		type="button"
		class="file-download"
		class:is-compact={variant === 'compact'}
		class:is-ready={note === 'tap'}
		aria-busy={busy ? 'true' : undefined}
		disabled={busy}
		onclick={() => void download()}
	>
		{label}
	</button>
	{#if note && !quiet}
		<p class="file-download-note" class:is-compact={variant === 'compact'} role="status">
			{note === 'tap' ? t.stream.artifactDownloadTapAgain : t.stream.artifactDownloadFailed}
		</p>
	{/if}
{/if}

<style>
	.file-download {
		margin-top: 6px;
		height: 32px;
		padding: 0 16px;
		border: 1px solid var(--accent-border);
		border-radius: 999px;
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: pointer;
	}

	.file-download:hover:not(:disabled) {
		border-color: var(--accent);
	}

	/* One of a bar's buttons, dressed like the others: an accent there reads as switched on. */
	.file-download.is-compact {
		flex-shrink: 0;
		margin-top: 0;
		height: 26px;
		padding: 0 10px;
		border-color: var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 500;
	}

	.file-download.is-compact:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.file-download:disabled,
	.file-download-icon:disabled {
		cursor: progress;
	}

	.file-download:disabled {
		opacity: 0.8;
	}

	.file-download.is-ready,
	.file-download-icon.is-ready {
		background: var(--accent);
		border-color: var(--accent);
		color: #ffffff;
	}

	.file-download:focus-visible,
	.file-download-icon:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Square, as tall as the bar it sits in: the phone's back button has the same shape. */
	.file-download-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: var(--file-download-size, 32px);
		height: var(--file-download-size, 32px);
		padding: 0;
		border: 0;
		border-radius: var(--file-download-radius, 8px);
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.file-download-icon svg {
		width: var(--file-download-glyph, 20px);
		height: var(--file-download-glyph, 20px);
	}

	.file-download-icon:hover:not(:disabled),
	.file-download-icon:active:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.file-download-percent {
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--accent);
	}

	.file-download-ring {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		animation: file-download-spin 0.9s linear infinite;
	}

	@keyframes file-download-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.file-download-ring {
			animation: none;
		}
	}

	.file-download-note {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
	}

	.file-download-note.is-compact {
		font-size: 11px;
	}
</style>
