<script lang="ts">
	import type { Attachment } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { ArtifactAnnotations } from './artifact-annotations.svelte.ts';
	import type { ArtifactLoader } from './artifact-loader.svelte.ts';
	import FileDownload from './FileDownload.svelte';
	import { artifactByteSource } from './artifacts.ts';

	interface Props {
		t: Copy;
		api: MessengerApi | null;
		mode: 'cited' | 'workspace';
		relpath: string;
		attachment: Attachment | null;
		byteSource: ReturnType<typeof artifactByteSource>;
		titleName: string;
		downloadKey: string;
		canDownload: boolean;
		showAnnotToggle: boolean;
		showAnnotMode: boolean;
		annotHint: '' | 'dirty' | 'no-target' | 'streamed' | null;
		showSourceToggle: boolean;
		hasResolved: boolean;
		showSource: boolean;
		toggleSource: () => void;
		annot: ArtifactAnnotations;
		loader: ArtifactLoader;
	}

	let {
		t,
		api,
		mode,
		relpath,
		attachment,
		byteSource,
		titleName,
		downloadKey,
		canDownload,
		showAnnotToggle,
		showAnnotMode,
		annotHint,
		showSourceToggle,
		hasResolved,
		showSource,
		toggleSource,
		annot,
		loader
	}: Props = $props();
</script>

{#if showAnnotToggle || showAnnotMode || annotHint !== null || showSourceToggle || canDownload}
	<div class="artifact-annot-bar" class:is-download-only={!(showAnnotToggle || showAnnotMode || annotHint !== null || showSourceToggle)} data-annotation-bar>
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
		{#if hasResolved && mode !== 'workspace'}
			<label class="artifact-annot-check" title={t.stream.annotationShowResolvedHint}>
				<input type="checkbox" bind:checked={annot.annotShowResolved} data-annotation-show-resolved />
				<span>{t.stream.annotationShowResolved}</span>
			</label>
		{/if}
		{#if showSourceToggle}
			<button
				type="button"
				class="artifact-annot-btn artifact-source-toggle"
				aria-pressed={showSource}
				onclick={toggleSource}
			>
				{#if showSource}
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
						<circle cx="12" cy="12" r="3"></circle>
					</svg>
					{t.stream.artifactRendered}
				{:else}
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<polyline points="16 18 22 12 16 6"></polyline>
						<polyline points="8 6 2 12 8 18"></polyline>
					</svg>
					{t.stream.artifactSource}
				{/if}
			</button>
		{/if}
		{#if showAnnotMode}
			<button
				type="button"
				class="artifact-annot-btn"
				class:is-on={annot.annotMode}
				aria-pressed={annot.annotMode}
				disabled={loader.originalProgress !== null || loader.loading}
				onclick={() => void annot.toggleAnnotMode()}
				data-annotation-mode
			>{annot.annotMode ? t.stream.annotationModeExit : t.stream.annotationMode}</button>
		{/if}
		{#if showAnnotToggle}
			<button
				type="button"
				class="artifact-annot-btn artifact-annot-toggle"
				class:is-on={annot.annotOpen}
				aria-pressed={annot.annotOpen}
				onclick={() => (annot.annotOpen = !annot.annotOpen)}
				data-annotation-toggle
			>{t.stream.annotationsTitle}{annot.fileAnnotations.length > 0 ? ` (${annot.fileAnnotations.length})` : ''}</button>
		{/if}
		{#if canDownload}
			<span class="artifact-bar-download">
				{#key downloadKey}
					<FileDownload
						{api}
						path={relpath}
						attachmentId={byteSource === 'attachment' ? (attachment?.id ?? null) : null}
						name={titleName}
						{t}
						ready={loader.readyOriginal}
						variant="compact"
						quiet
						bind:note={loader.downloadNote}
					/>
				{/key}
			</span>
		{/if}
	</div>
{/if}

<style>
	/* Annotating's own row, where the toolbar used to be: the how-to line, annotate mode, the list. */
	.artifact-annot-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		padding: 4px 12px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		flex-shrink: 0;
	}

	.artifact-annot-hint {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 12px;
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
		gap: 5px;
		height: 26px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.artifact-annot-btn[data-annotation-mode]::before {
		content: "";
		display: inline-block;
		width: 12px;
		height: 12px;
		background-color: currentColor;
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cline x1='22' y1='12' x2='18' y2='12'/%3E%3Cline x1='6' y1='12' x2='2' y2='12'/%3E%3Cline x1='12' y1='6' x2='12' y2='2'/%3E%3Cline x1='12' y1='22' x2='12' y2='18'/%3E%3C/svg%3E") no-repeat center / contain;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cline x1='22' y1='12' x2='18' y2='12'/%3E%3Cline x1='6' y1='12' x2='2' y2='12'/%3E%3Cline x1='12' y1='6' x2='12' y2='2'/%3E%3Cline x1='12' y1='22' x2='12' y2='18'/%3E%3C/svg%3E") no-repeat center / contain;
	}

	.artifact-annot-btn[data-annotation-toggle]::before {
		content: "";
		display: inline-block;
		width: 12px;
		height: 12px;
		background-color: currentColor;
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/%3E%3C/svg%3E") no-repeat center / contain;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/%3E%3C/svg%3E") no-repeat center / contain;
	}

	.artifact-annot-btn:hover:not(:disabled) {
		color: var(--ink);
		border-color: var(--line-hover);
		background: var(--btn-secondary-hover);
	}

	.artifact-annot-btn.is-on {
		color: var(--on-accent);
		border-color: var(--accent);
		background: var(--accent);
	}

	.artifact-annot-btn.is-on:hover:not(:disabled) {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
		color: var(--on-accent);
	}

	.artifact-annot-btn.artifact-annot-toggle.is-on {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.artifact-annot-btn.artifact-annot-toggle.is-on:hover:not(:disabled) {
		background: var(--accent-tint);
		border-color: var(--accent);
		color: var(--accent);
	}

	.artifact-annot-btn:disabled {
		cursor: progress;
		opacity: 0.6;
	}

	.artifact-annot-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Resolved rows back on the file: a polished capsule toggle setting. */
	.artifact-annot-check {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 8px;
		border-radius: var(--radius-full);
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.artifact-annot-check:hover {
		background: var(--btn-secondary-hover);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.artifact-annot-check:has(input:checked) {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.artifact-annot-check input {
		margin: 0;
		width: 13px;
		height: 13px;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.artifact-bar-download {
		display: contents;
	}

	@media (max-width: 680px) {
		/* The phone downloads from its own bar; a bar that would hold only that stays away. */
		.artifact-bar-download,
		.artifact-annot-bar.is-download-only {
			display: none;
		}

		.artifact-annot-btn {
			height: 32px;
			padding: 0 12px;
		}

		.artifact-annot-check {
			height: 32px;
		}
	}
</style>
