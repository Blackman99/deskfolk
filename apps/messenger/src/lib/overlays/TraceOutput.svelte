<script lang="ts">
	/**
	 * One file, shown as the next station of the flow. It reads the file and shows it; it is not
	 * the artifact editor beside the chat, so there is no tree, no source toggle and no saving.
	 */
	import { onDestroy } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MediaSourceHandle } from '../remote/media-source.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import {
		artifactKind,
		htmlPreviewBlob,
		HTML_PREVIEW_SANDBOX,
		svgDisplayBlob
	} from './artifacts.ts';
	import { openWorkspacePath } from './open-workspace.ts';
	import { traceFileName } from './task-trace.ts';

	interface Props {
		path: string;
		handedBy: string;
		api: MessengerApi | null;
		workspacePath: string | null;
		t: Copy;
		onOpenPath: (path: string) => void;
		onClose: () => void;
		/**
		 * Full screen, for a file that does not fit under a card. The flag and the layer live in
		 * the board, because `position: fixed` inside a transformed ancestor is fixed to that
		 * ancestor — a preview that promised the screen would have got the canvas.
		 */
		full?: boolean;
		onToggleFull?: () => void;
	}

	let {
		path,
		handedBy,
		api,
		workspacePath,
		t,
		onOpenPath,
		onClose,
		full = false,
		onToggleFull
	}: Props = $props();

	const kind = $derived(artifactKind(path));
	const name = $derived(traceFileName(path));

	let phase = $state<'loading' | 'ready' | 'missing' | 'plain'>('loading');
	let text = $state<string | null>(null);
	let url = $state<string | null>(null);
	let generation = 0;
	let liveUrl: string | null = null;
	let mediaSource: MediaSourceHandle | null = null;
	let loadAbort: AbortController | null = null;

	function dropUrl(): void {
		mediaSource?.dispose();
		mediaSource = null;
		if (liveUrl) URL.revokeObjectURL(liveUrl);
		liveUrl = null;
		url = null;
	}

	function keep(next: string): void {
		dropUrl();
		liveUrl = next;
		url = next;
	}

	async function load(target: string): Promise<void> {
		const mine = ++generation;
		loadAbort?.abort();
		const abort = new AbortController();
		loadAbort = abort;
		phase = 'loading';
		text = null;
		dropUrl();
		const shown = artifactKind(target);
		if (shown === 'directory' || shown === 'file') {
			phase = 'plain';
			return;
		}
		if (!api) {
			phase = 'missing';
			return;
		}
		try {
			if ((shown === 'audio' || shown === 'video') && api.kind === 'remote' && api.openMediaSource) {
				const stream = await api.openMediaSource({ path: target }, abort.signal, () => {
					if (mine !== generation) return;
					phase = 'missing';
					abort.abort();
				});
				if (mine !== generation || abort.signal.aborted) { stream?.dispose(); return; }
				if (stream) {
					mediaSource = stream;
					url = stream.url;
					phase = 'ready';
					return;
				}
			}
			const blob = await api.getWorkspaceFileBlob(target, undefined, { signal: abort.signal });
			if (mine !== generation) return;
			if (shown === 'markdown' || shown === 'text') {
				text = await blob.text();
			} else if (shown === 'html') {
				keep(URL.createObjectURL(htmlPreviewBlob(await blob.text())));
			} else if (shown === 'svg') {
				keep(URL.createObjectURL(await svgDisplayBlob(await blob.text())));
			} else {
				keep(URL.createObjectURL(blob));
			}
			if (mine !== generation) return;
			phase = 'ready';
		} catch {
			if (mine !== generation) return;
			phase = 'missing';
		}
	}

	$effect(() => {
		void load(path);
	});

	onDestroy(() => { generation += 1; loadAbort?.abort(); dropUrl(); });

	function onOpenArtifact(next: string): void {
		onOpenPath(next);
	}

	function openWithSystem(): void {
		if (!workspacePath) return;
		const root = workspacePath.endsWith('/') ? workspacePath.slice(0, -1) : workspacePath;
		void openWorkspacePath(`${root}/${path}`);
	}
</script>

<article class="trace-output" class:is-full={full} aria-label={name}>
	<header class="trace-output-head">
		<div class="trace-output-titles">
			<span class="trace-output-kicker">{handedBy ? t.trace.outputOf(handedBy) : t.trace.output}</span>
			<strong class="trace-output-name" title={path}>{name}</strong>
		</div>
		<button
			type="button"
			class="trace-output-full"
			title={full ? t.trace.outputExitFull : t.trace.outputFull}
			aria-label={full ? t.trace.outputExitFull : t.trace.outputFull}
			aria-pressed={full}
			onclick={onToggleFull}
		>
			{#if full}
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"></path>
				</svg>
			{:else}
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"></path>
				</svg>
			{/if}
		</button>
		<button type="button" class="trace-output-close" title={t.trace.outputClose} onclick={onClose}>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
				<line x1="18" y1="6" x2="6" y2="18"></line>
				<line x1="6" y1="6" x2="18" y2="18"></line>
			</svg>
		</button>
	</header>
	<div class="trace-output-body">
		{#if phase === 'loading'}
			<p class="trace-output-note">{t.trace.loading}</p>
		{:else if phase === 'missing'}
			<p class="trace-output-note">{t.trace.outputMissing}</p>
		{:else if phase === 'plain'}
			<p class="trace-output-note">{t.trace.outputPlain}</p>
			{#if workspacePath}
				<button type="button" class="trace-output-open" onclick={openWithSystem}>{t.trace.outputOpen}</button>
			{/if}
		{:else if kind === 'markdown' && text !== null}
			<MarkdownBody
				source={text}
				copyLabel={t.chat.copyCode}
				copiedLabel={t.chat.copied}
				{onOpenArtifact}
			/>
		{:else if kind === 'text' && text !== null}
			<pre class="trace-output-text">{text}</pre>
		{:else if kind === 'image' || kind === 'svg'}
			<img src={url} alt={name} class="trace-output-image" data-copy-image />
		{:else if kind === 'audio'}
			<audio controls preload="metadata" src={url} onerror={() => { phase = 'missing'; loadAbort?.abort(); }}></audio>
		{:else if kind === 'video'}
			<video controls playsinline preload="metadata" src={url} onerror={() => { phase = 'missing'; loadAbort?.abort(); }}></video>
		{:else if kind === 'pdf' || kind === 'html'}
			<iframe title={name} class="trace-output-frame" src={url} sandbox={kind === 'html' ? HTML_PREVIEW_SANDBOX : undefined}></iframe>
		{/if}
	</div>
</article>

<style>
	.trace-output {
		flex: 0 0 auto;
		width: 100%;
		max-height: min(52vh, 480px);
		/* The zoom the board is drawn at must not shrink the file: it is read, not surveyed. */
		z-index: 3;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-md);
		background: var(--pane);
		overflow: hidden;
	}

	.trace-output-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 9px 10px 8px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.trace-output-titles {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.trace-output-kicker {
		font-size: 11px;
		color: var(--accent);
	}

	.trace-output-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * Out of the card, out of the board, out of the window: the same component, pinned to the
	 * screen. Fixed positioning takes it out of the board's transform, so it is never drawn at
	 * whatever the canvas happens to be zoomed to.
	 */
	.trace-output.is-full {
		width: 100%;
		height: 100%;
		max-height: none;
	}

	.trace-output-full {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.trace-output-full:hover,
	.trace-output-full[aria-pressed='true'] {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.trace-output-close {
		flex: none;
		width: 24px;
		height: 24px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.trace-output-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.trace-output-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 12px 14px 16px;
	}

	.trace-output-body :global(audio),
	.trace-output-body :global(video) {
		width: 100%;
		max-height: 100%;
	}

	.trace-output-note {
		margin: 8px 0;
		font-size: 12.5px;
		color: var(--muted);
	}

	.trace-output-open {
		height: 26px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.trace-output-text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink-secondary);
	}

	.trace-output-image {
		display: block;
		max-width: 100%;
		margin: 0 auto;
	}

	.trace-output-frame {
		width: 100%;
		height: 420px;
		border: 0;
		background: white;
	}

	@media (max-width: 680px) {
		/* A phone has no room to spare: the preview is already the screen, and full screen only
		   drops the gutter. The button stays, because it is also how you get back. */
		.trace-output.is-full {
			border-radius: 0;
		}

		.trace-output-full,
		.trace-output-close {
			width: 32px;
			height: 32px;
		}

		.trace-output {
			width: 100%;
			max-height: 52vh;
		}
	}
</style>
