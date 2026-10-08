<script module lang="ts">
	export type ArtifactEditorHandle = {
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
	};
	export type ArtifactPdfHandle = { openFind: () => void; closeFind: () => boolean };
</script>

<script lang="ts">
	import type { Annotation, Attachment } from '@real-bot/protocol';
	import { describeAnchor } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import AnnotationList from '../annotations/AnnotationList.svelte';
	import AnnotationComposer from '../annotations/AnnotationComposer.svelte';
	import ImageAnnotator from '../annotations/ImageAnnotator.svelte';
	import MarkdownAnnotator from '../annotations/MarkdownAnnotator.svelte';
	import HtmlAnnotator from '../annotations/HtmlAnnotator.svelte';
	import MediaAnnotator from '../annotations/MediaAnnotator.svelte';
	import type { annotateGate } from '../annotations/model.ts';
	import PdfViewer from './PdfViewer.svelte';
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';
	import FileDownload from './FileDownload.svelte';
	import { formatFileSize } from '../chat/attachments.ts';
	import { artifactByteSource, isInAppPreviewKind, isOfficeKind, type ArtifactKind } from './artifacts.ts';
	import type { ArtifactAnnotations } from './artifact-annotations.svelte.ts';
	import type { ArtifactLoader } from './artifact-loader.svelte.ts';
	import type { ArtifactTreeSource } from './artifact-tree-source.svelte.ts';
	import type { ComponentProps } from 'svelte';

	interface Props {
		t: Copy;
		locale: 'zh' | 'en';
		bots: ReadonlyMap<string, { name: string }>;
		api: MessengerApi | null;
		relpath: string;
		attachment: Attachment | null;
		mode: 'cited' | 'workspace';
		kind: ArtifactKind;
		sourceMode: boolean;
		gate: ReturnType<typeof annotateGate>;
		wrap: boolean;
		resolvedTheme: ComponentProps<typeof HtmlAnnotator>['scheme'];
		loadMonaco?: ComponentProps<typeof ArtifactCodeEditor>['loadMonaco'];
		byteSource: ReturnType<typeof artifactByteSource>;
		titleName: string;
		opensOnDisk: boolean;
		drawnRows: Annotation[];
		viewAnnotations: Annotation[];
		annot: ArtifactAnnotations;
		loader: ArtifactLoader;
		treeSrc: ArtifactTreeSource;
		editor?: ArtifactEditorHandle | null;
		pdfViewer?: ArtifactPdfHandle | null;
		onEditorDirty: (next: boolean) => void;
		enlarge: (image: string, own: boolean, picture: Element | null | undefined) => void;
		openMarkdownPath: (path: string) => void;
		openOnDisk: (path: string, reveal: boolean) => Promise<void>;
	}

	let {
		t,
		locale,
		bots,
		api,
		relpath,
		attachment,
		mode,
		kind,
		sourceMode,
		gate,
		wrap,
		resolvedTheme,
		loadMonaco,
		byteSource,
		titleName,
		opensOnDisk,
		drawnRows,
		viewAnnotations,
		annot,
		loader,
		treeSrc,
		editor = $bindable(null),
		pdfViewer = $bindable(null),
		onEditorDirty,
		enlarge,
		openMarkdownPath,
		openOnDisk
	}: Props = $props();
</script>

<div class="artifact-body-with-annots flex-1 min-h-0 min-w-0 flex" class:has-annots={annot.annotOpen && mode !== 'workspace'}>
	<div
		bind:this={annot.bodyEl}
		class="artifact-pane-body flex-1 min-h-0 min-w-0"
		class:is-editor={sourceMode && loader.text !== null}
	>
		{#if kind === 'image' && loader.shownBlob && !loader.loading && loader.reducedFrom !== null}
			<button
				type="button"
				class="artifact-original-toggle"
				aria-busy={loader.originalProgress ? 'true' : undefined}
				disabled={loader.originalProgress !== null}
				onclick={() => loader.loadOriginal()}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="3" width="18" height="18" rx="2"></rect>
					<circle cx="9" cy="9" r="2"></circle>
					<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>
				</svg>
				{loader.originalProgress ? t.stream.imageOriginalLoading(loader.originalBytes) : t.stream.imageOriginal(formatFileSize(loader.reducedFrom))}
			</button>
		{/if}
		<div class="artifact-pane-scroll">
			{#if loader.loading}
				<div class="artifact-loading" role="status" aria-live="polite" aria-busy="true">
					<span class="artifact-loading-ring" aria-hidden="true"></span>
					<p class="artifact-loading-copy">{t.stream.artifactLoading}</p>
					{#if loader.loadBytes}
						<p class="artifact-loading-bytes">{loader.loadBytes}</p>
					{/if}
					<div
						class="artifact-loading-bar"
						role="progressbar"
						aria-label={t.stream.artifactLoading}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={loader.loadPercent ?? undefined}
					>
						<div
							class="artifact-loading-fill"
							class:is-indeterminate={loader.loadPercent === null}
							style={loader.loadPercent === null ? undefined : `width: ${loader.loadPercent}%`}
						></div>
					</div>
				</div>
			{/if}
			{#if treeSrc.truncatedHint && mode === 'workspace'}
				<p class="muted">{t.stream.workspaceTruncated}</p>
			{/if}
			{#if loader.missing}
				<p class="muted">{t.stream.artifactMissing}</p>
			{:else if mode === 'workspace' && !relpath}
				<p class="muted">{t.stream.workspacePickFile}</p>
			{:else if kind === "directory"}
				<p class="muted">{mode === 'workspace' ? t.stream.workspaceEmpty : t.stream.artifactDirectory}</p>
			{:else if sourceMode}
				{#if loader.text !== null}
					<ArtifactCodeEditor
						bind:this={editor}
						code={loader.text}
						baseline={loader.diskText}
						path={relpath}
						{wrap}
						onDirty={onEditorDirty}
						annotations={drawnRows}
						focusAnnotationId={annot.annotFocus}
						focusAnnotationSeq={annot.annotFocusSeq}
						annotateEnabled={gate.ok && gate.adapter === 'text' && !annot.pendingDraft}
						annotateLabel={t.stream.annotationAdd}
						onAnnotate={annot.offerAnnotation}
						onPickAnnotation={annot.pickAnnotation}
						{loadMonaco}
					/>
				{/if}
			{:else if kind === "image" || kind === "svg"}
				{#if loader.shownBlob}
					<!--
						A box is drawn on the picture itself: a remote copy has neither the original's size nor
						its hash, so it takes no new box (annotate mode fetches the original first).
					-->
					<ImageAnnotator
						src={loader.shownBlob}
						alt={relpath}
						isSvg={kind === 'svg'}
						svgText={loader.svgRaw}
						annotations={viewAnnotations}
						focusId={annot.annotFocus}
						focusSeq={annot.annotFocusSeq}
						active={annot.annotMode}
						enabled={gate.ok && gate.adapter === 'image' && !annot.pendingDraft && loader.reducedFrom === null}
						labels={t.stream.annotImage}
						onDraft={(draft) => annot.offerDraft('image_region', draft.anchor, draft.crop)}
						onPick={annot.pickAnnotation}
						pending={annot.pendingOf('image_region')}
						onPendingChange={annot.movePending}
						onCancel={annot.escapeAnnotation}
						openLabel={`${t.stream.artifactEnlarge} ${relpath.split('/').pop() ?? relpath}`}
						onOpen={(img) => enlarge(relpath, true, img)}
					/>
				{/if}
			{:else if (kind === "audio" || kind === "video") && loader.shownBlob}
				<!-- Streamed remotely the clip has no whole-file hash to hang a new point on. -->
				<MediaAnnotator
					src={loader.shownBlob}
					kind={kind}
					annotations={viewAnnotations}
					focusId={annot.annotFocus}
					focusSeq={annot.annotFocusSeq}
					enabled={gate.ok && gate.adapter === 'media' && !annot.pendingDraft && loader.contentSha !== null}
					labels={t.stream.annotMedia}
					onDraft={(draft) => annot.offerDraft('media_time', draft.anchor, draft.crop)}
					onPick={annot.pickAnnotation}
					pending={annot.pendingOf('media_time')}
					onPendingChange={annot.movePending}
					onCancel={annot.escapeAnnotation}
					onError={() => {
						loader.missing = true;
						loader.loadAbort?.abort();
					}}
				/>
			{:else if isOfficeKind(kind)}
				{#if loader.shownOffice && !loader.loading}
					{#await import('./OfficeViewer.svelte') then { default: OfficeViewer }}
						<OfficeViewer data={loader.shownOffice} {kind} title={relpath} labels={t.stream.office} />
					{/await}
				{/if}
			{:else if kind === "pdf" && loader.shownPdf}
				<PdfViewer
					bind:this={pdfViewer}
					data={loader.shownPdf}
					theme={resolvedTheme}
					labels={t.stream.annotPdf}
					annotations={viewAnnotations}
					focusId={annot.annotFocus}
					focusSeq={annot.annotFocusSeq}
					active={annot.annotMode}
					enabled={gate.ok && gate.adapter === 'pdf' && !annot.pendingDraft}
					onDraft={(draft) => annot.offerDraft('pdf_region', draft.anchor, draft.crop)}
					onPick={annot.pickAnnotation}
					pending={annot.pendingOf('pdf_region')}
					onPendingChange={annot.movePending}
					onCancel={annot.escapeAnnotation}
				/>
			{:else if kind === "html" && loader.text !== null}
				<HtmlAnnotator
					html={loader.text}
					scheme={resolvedTheme}
					title={relpath}
					annotations={viewAnnotations}
					focusId={annot.annotFocus}
					focusSeq={annot.annotFocusSeq}
					active={annot.annotMode && gate.ok && gate.adapter === 'html'}
					enabled={gate.ok && gate.adapter === 'html' && (!annot.pendingDraft || annot.pendingDraft.kind === 'html_element')}
					labels={t.stream.annotHtml}
					onDraft={(draft) => annot.offerDraft('html_element', draft.anchor)}
					onPick={annot.goToAnnotation}
					pending={annot.pendingOf('html_element')}
					onPendingChange={annot.movePending}
					onCancel={annot.escapeAnnotation}
				/>
			{:else if kind === "markdown" && loader.text !== null}
				<MarkdownAnnotator
					source={loader.text}
					annotations={viewAnnotations}
					focusId={annot.annotFocus}
					focusSeq={annot.annotFocusSeq}
					active={gate.ok && gate.adapter === 'markdown'}
					enabled={gate.ok && gate.adapter === 'markdown' && !annot.pendingDraft}
					labels={t.stream.annotMarkdown}
					onDraft={(draft) => annot.offerDraft('text_range', draft.anchor)}
					onPick={annot.pickAnnotation}
					pending={annot.pendingOf('text_range')}
					onCancel={annot.escapeAnnotation}
					copyLabel={t.chat.copyCode}
					copiedLabel={t.chat.copied}
					onOpenArtifact={openMarkdownPath}
					onOpenImage={(path, from) => enlarge(path, false, from?.querySelector('img, .md-artifact-pending') ?? from)}
					loadArtifactImage={(path, signal) => {
						if (!api) return Promise.reject(new Error('API unavailable'));
						// A picture inside a note is a 72 px chip: the 256 px copy is plenty, and tapping it
						// enlarges to the 1600 px copy with the original on offer.
						return api.getWorkspaceFileBlob(path, undefined, { size: 'thumb', signal });
					}}
				/>
			{:else if !isInAppPreviewKind(kind)}
				<div class="artifact-unsupported">
					<p class="artifact-unsupported-name">{titleName}</p>
					<p class="muted">{attachment?.exists === false ? t.stream.artifactMissing : t.stream.artifactUnsupported}</p>
					{#if attachment?.exists === false}
						<!-- Nothing to hand over. -->
					{:else if opensOnDisk}
						<button type="button" class="artifact-unsupported-open" onclick={() => void openOnDisk(relpath, false)}>
							{t.stream.artifactOpenSystem}
						</button>
					{:else}
						{#key `${byteSource}:${attachment?.id ?? ''}:${relpath}`}
							<FileDownload
								{api}
								path={relpath}
								attachmentId={byteSource === 'attachment' ? (attachment?.id ?? null) : null}
								name={titleName}
								{t}
							/>
						{/key}
					{/if}
				</div>
			{:else}
				<p class="muted">{attachment?.original_filename ?? relpath}</p>
			{/if}
			{#if loader.openHint}
				<p class="muted">{t.stream.artifactOpenUnavailable}</p>
			{/if}
		</div>
		<!-- Pinned to the frame, over the file: it stays in view while the file scrolls under it. -->
		{#if annot.pendingDraft}
			<div class="artifact-annot-composer" style:top={annot.composerTop === null ? undefined : `${annot.composerTop}px`}>
				<AnnotationComposer
					{t}
					position={describeAnchor(annot.pendingDraft.kind, annot.pendingDraft.anchor, locale)}
					busy={annot.annotBusy}
					error={annot.annotError}
					onSave={(body) => void annot.saveDraft(body)}
					onCancel={annot.cancelDraft}
				/>
			</div>
		{/if}
	</div>
	{#if annot.annotOpen && mode !== 'workspace'}
		<div class="artifact-annot-col">
			<AnnotationList
				annotations={annot.fileAnnotations}
				{t}
				{locale}
				{bots}
				focusId={annot.annotFocus}
				busy={annot.annotBusy}
				error={annot.annotError}
				onReveal={annot.revealAnnotation}
				onEdit={(row, body) => void annot.editDraft(row, body)}
				onDelete={(row) => void annot.deleteDraft(row)}
				onToggleStatus={(row, status) => void annot.toggleAnnotation(row, status)}
				onClose={() => (annot.annotOpen = false)}
				noTarget={!gate.ok && gate.reason === 'no-target'}
			/>
		</div>
	{/if}
</div>

<style>
	.artifact-pane-body {
		position: relative;
		overflow: hidden;
	}

	/*
	 * The file scrolls. The offer of the original picture does not: it stays pinned to this pane's
	 * top, over whatever has scrolled past.
	 */
	.artifact-pane-scroll {
		height: 100%;
		min-height: 0;
		overflow: auto;
		padding: 16px;
	}

	.artifact-original-toggle {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 4;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 28px;
		max-width: calc(100% - 32px);
		padding: 0 10px 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--pane) 88%, transparent);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: var(--shadow-xs);
	}

	.artifact-original-toggle svg {
		flex-shrink: 0;
	}

	.artifact-original-toggle:hover {
		color: var(--accent);
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.artifact-original-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.artifact-original-toggle:disabled {
		cursor: progress;
	}

	.artifact-body-with-annots {
		position: relative;
	}

	.artifact-annot-col {
		width: min(320px, 45%);
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

	.artifact-unsupported {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 48px 16px;
		text-align: center;
	}

	.artifact-unsupported p {
		margin: 0;
	}

	.artifact-unsupported-name {
		max-width: 100%;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.artifact-unsupported-open {
		margin-top: 6px;
		height: 32px;
		padding: 0 16px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.artifact-unsupported-open:hover {
		border-color: var(--accent);
	}

	.artifact-unsupported-open:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		font-size: 12px;
		color: var(--muted);
	}

	.artifact-loading-bar {
		width: min(220px, 70%);
		height: 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		overflow: hidden;
	}

	.artifact-loading-fill {
		height: 100%;
		width: 0;
		border-radius: var(--radius-full);
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

	@media (max-width: 680px) {
		.artifact-original-toggle {
			top: 10px;
			height: 36px;
			padding: 0 14px 0 12px;
		}

		.artifact-original-toggle svg {
			width: 16px;
			height: 16px;
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

		.artifact-annot-composer {
			top: 8px;
			right: 8px;
			left: 8px;
		}
	}
</style>
