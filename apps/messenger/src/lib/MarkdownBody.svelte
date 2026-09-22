<script lang="ts">
	import type { Snippet } from 'svelte';
	import { markdownCode } from './chat/code-blocks.ts';
	import { parseMentionHref } from './chat/mention-chips.ts';
	import { renderMarkdown, type RenderMarkdownOptions } from './markdown.ts';
	import { openExternalLink } from './open-link.ts';
	import { artifactKind, parseArtifactHref, svgDisplayBlob } from './overlays/artifacts.ts';

	interface Props {
		source: string;
		options?: RenderMarkdownOptions;
		copyLabel: string;
		copiedLabel: string;
		/** User-bubble chrome: light text on the accent fill. */
		inverted?: boolean;
		class?: string;
		onOpenArtifact?: (relpath: string) => void;
		loadArtifactImage?: (relpath: string) => Promise<Blob>;
		hideStandaloneArtifactLinks?: string[];
		onOpenProfile?: (botId: string) => void;
		children?: Snippet;
	}

	let {
		source,
		options = {},
		copyLabel,
		copiedLabel,
		inverted = false,
		class: className = '',
		onOpenArtifact,
		loadArtifactImage,
		hideStandaloneArtifactLinks = [],
		onOpenProfile,
		children
	}: Props = $props();

	const html = $derived(renderMarkdown(source, options));
	const codeLabels = $derived({ copy: copyLabel, copied: copiedLabel });

	function onClick(ev: MouseEvent): void {
		const target = ev.target;
		if (!(target instanceof Element)) return;
		const a = target.closest('a');
		if (!(a instanceof HTMLAnchorElement)) return;
		ev.preventDefault();
		const raw = a.getAttribute('href') ?? a.href;
		const botId = parseMentionHref(raw);
		if (botId && botId !== 'everyone') {
			onOpenProfile?.(botId);
			return;
		}
		const artifact = parseArtifactHref(raw);
		if (artifact) {
			onOpenArtifact?.(artifact);
			return;
		}
		const href = a.getAttribute('href') || a.href;
		if (href.startsWith('https:') || href.startsWith('http:') || href.startsWith('mailto:')) {
			void openExternalLink(href);
		}
	}

	function wrapTables(node: HTMLElement): void {
		for (const table of node.querySelectorAll('table')) {
			if (!(table instanceof HTMLTableElement)) continue;
			if (table.parentElement?.classList.contains('md-table-wrap')) continue;
			const wrap = document.createElement('div');
			wrap.className = 'md-table-wrap';
			table.replaceWith(wrap);
			wrap.appendChild(table);
		}
	}

	function hideDuplicateArtifactLinks(node: HTMLElement): void {
		if (hideStandaloneArtifactLinks.length === 0) return;
		const hidden = new Set(hideStandaloneArtifactLinks);
		for (const anchor of node.querySelectorAll('a')) {
			if (!(anchor instanceof HTMLAnchorElement)) continue;
			const path = parseArtifactHref(anchor.getAttribute('href') ?? '');
			if (!path || !hidden.has(path) || anchor.textContent?.trim() !== path) continue;
			const parent = anchor.parentElement;
			const adjacentBreak =
				anchor.nextSibling instanceof HTMLBRElement
					? anchor.nextSibling
					: anchor.previousSibling instanceof HTMLBRElement
						? anchor.previousSibling
						: null;
			adjacentBreak?.remove();
			anchor.remove();
			if (parent instanceof HTMLParagraphElement && !parent.textContent?.trim()) parent.remove();
		}
	}

	function enhanceArtifactImages(node: HTMLElement, urls: Map<HTMLAnchorElement, string>): void {
		for (const [anchor, url] of urls) {
			if (anchor.isConnected && node.contains(anchor)) continue;
			URL.revokeObjectURL(url);
			urls.delete(anchor);
		}
		if (!loadArtifactImage) return;
		for (const anchor of node.querySelectorAll('a')) {
			if (!(anchor instanceof HTMLAnchorElement) || anchor.dataset.artifactImage) continue;
			const path = parseArtifactHref(anchor.getAttribute('href') ?? '');
			if (!path || !['image', 'svg'].includes(artifactKind(path))) continue;
			anchor.dataset.artifactImage = 'loading';
			anchor.classList.add('md-artifact-image');
			void loadArtifactImage(path)
				.then(async (blob) => {
					if (!anchor.isConnected || !node.contains(anchor)) return;
					const display = artifactKind(path) === 'svg' ? await svgDisplayBlob(blob) : blob;
					if (!anchor.isConnected || !node.contains(anchor)) return;
					const url = URL.createObjectURL(display);
					urls.set(anchor, url);
					const image = document.createElement('img');
					image.src = url;
					image.alt = anchor.textContent?.trim() || path.split('/').pop() || path;
					image.className = 'md-artifact-thumb';
					anchor.prepend(image);
					anchor.dataset.artifactImage = 'ready';
				})
				.catch(() => {
					anchor.dataset.artifactImage = 'failed';
					anchor.classList.remove('md-artifact-image');
				});
		}
	}

	function enhance(node: HTMLElement, labels: { copy: string; copied: string }) {
		const code = markdownCode(node, labels);
		const imageUrls = new Map<HTMLAnchorElement, string>();
		const enhanceContent = () => {
			hideDuplicateArtifactLinks(node);
			wrapTables(node);
			enhanceArtifactImages(node, imageUrls);
		};
		enhanceContent();
		const content = new MutationObserver(enhanceContent);
		content.observe(node, { childList: true, subtree: true });
		node.addEventListener('click', onClick);
		return {
			update(next: { copy: string; copied: string }) {
				code.update(next);
			},
			destroy() {
				content.disconnect();
				for (const url of imageUrls.values()) URL.revokeObjectURL(url);
				node.removeEventListener('click', onClick);
				code.destroy();
			}
		};
	}
</script>

<div class="md-body {className}" class:is-inverted={inverted} use:enhance={codeLabels}>
	{@html html}
	{@render children?.()}
</div>

<style>
	.md-body {
		white-space: normal;
		line-height: 1.55;
		font-size: 13.5px;
		min-width: 0;
	}

	.md-body > :global(:first-child) {
		margin-top: 0;
	}

	.md-body > :global(:last-child) {
		margin-bottom: 0;
	}

	.md-body :global(p),
	.md-body :global(ul),
	.md-body :global(ol),
	.md-body :global(pre),
	.md-body :global(blockquote),
	.md-body :global(.md-table-wrap) {
		margin: 0.45em 0;
	}

	.md-body :global(h1),
	.md-body :global(h2),
	.md-body :global(h3),
	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) {
		margin: 0.65em 0 0.3em;
		font-weight: 700;
		line-height: 1.3;
		color: inherit;
	}

	.md-body :global(h1) {
		font-size: 1.2em;
	}

	.md-body :global(h2) {
		font-size: 1.1em;
	}

	.md-body :global(h3),
	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) {
		font-size: 1em;
	}

	.md-body :global(ul),
	.md-body :global(ol) {
		padding-left: 1.3em;
	}

	.md-body :global(li) + :global(li) {
		margin-top: 0.15em;
	}

	.md-body :global(blockquote) {
		margin-left: 0;
		padding-left: 0.8em;
		border-left: 3px solid var(--line);
		color: var(--muted);
	}

	.md-body :global(hr) {
		border: 0;
		border-top: 1px solid var(--line);
		margin: 0.65em 0;
	}

	.md-body :global(a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.md-body :global(a.md-external-link) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
		word-break: break-word;
	}

	.md-body :global(a.md-external-link:hover) {
		color: var(--accent-hover);
	}

	.md-body :global(.md-external-icon) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		vertical-align: -1px;
		margin-left: 2.5px;
		opacity: 0.75;
		user-select: none;
		flex-shrink: 0;
		transition: opacity 0.15s ease;
	}

	.md-body :global(a.md-external-link:hover .md-external-icon) {
		opacity: 1;
	}

	.md-body :global(a.md-artifact-link) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		word-break: break-word;
	}

	.md-body :global(a.md-artifact-link:hover) {
		color: var(--accent-hover);
	}

	.md-body :global(a.md-artifact-link:not(.md-artifact-image))::before {
		content: '';
		display: inline-block;
		width: 11px;
		height: 11px;
		margin-right: 3px;
		vertical-align: -1px;
		background-color: currentColor;
		-webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/%3E%3Cpolyline points='14 2 14 8 20 8'/%3E%3C/svg%3E");
		mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/%3E%3Cpolyline points='14 2 14 8 20 8'/%3E%3C/svg%3E");
		-webkit-mask-repeat: no-repeat;
		mask-repeat: no-repeat;
		-webkit-mask-size: contain;
		mask-size: contain;
		opacity: 0.75;
		transition: opacity 0.15s ease;
	}

	.md-body :global(a.md-artifact-link:not(.md-artifact-image):hover)::before {
		opacity: 1;
	}

	.md-body :global(a.md-artifact-image) {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: min(100%, 240px);
		padding: 5px;
		margin: 2px 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink-secondary);
		text-decoration: none;
		vertical-align: middle;
		cursor: zoom-in;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.md-body :global(a.md-artifact-image:hover),
	.md-body :global(a.md-artifact-image:focus-visible) {
		border-color: var(--accent);
		box-shadow: var(--shadow-xs);
		outline: none;
	}

	.md-body :global(.md-artifact-thumb) {
		display: block;
		width: 72px;
		height: 54px;
		object-fit: cover;
		border-radius: calc(var(--radius-md) - 3px);
		background: var(--line-subtle);
		flex: 0 0 auto;
	}

	.md-body :global(a.md-artifact-image[data-artifact-image='ready']) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.md-body :global(code) {
		font-family: var(--mono);
		font-size: 12px;
		background: var(--inline-code-bg);
		border: 1px solid var(--inline-code-border);
		padding: 0.1em 0.35em;
		border-radius: 4px;
	}

	.md-body :global(pre) {
		background: var(--chip);
		color: var(--ink);
		border: 1px solid var(--line);
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		overflow-x: auto;
		font-size: 12px;
		line-height: 1.45;
	}

	.md-body :global(pre) :global(code) {
		background: none;
		padding: 0;
		color: inherit;
		font-size: inherit;
		display: block;
		white-space: pre-wrap;
		border: 0;
	}

	/*
	 * Keep the table formatting context (`display: table`). Putting `display:
	 * block` on <table> is what collapsed columns in the preview.
	 *
	 * Do not force `width: 100%` with wrap-anywhere: a fit-content bubble then
	 * shrinks every column to one CJK character. Size to content, floor short
	 * columns, cap long cells, and scroll sideways in `.md-table-wrap`.
	 */
	.md-body :global(.md-table-wrap) {
		overflow-x: auto;
		max-width: 100%;
		width: 100%;
		min-width: 0;
	}

	.md-body :global(table) {
		border-collapse: collapse;
		font-size: 12.5px;
		width: max-content;
		min-width: 100%;
	}

	.md-body :global(th),
	.md-body :global(td) {
		border: 1px solid var(--line);
		padding: 6px 10px;
		vertical-align: top;
		line-height: 1.45;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.md-body :global(th) {
		font-weight: 650;
		background: var(--line-subtle);
		white-space: nowrap;
	}

	.md-body :global(td) {
		min-width: 5.5em;
		max-width: 22em;
	}

	.md-body :global(th[align='center']),
	.md-body :global(td[align='center']) {
		text-align: center;
	}

	.md-body :global(th[align='right']),
	.md-body :global(td[align='right']) {
		text-align: right;
	}

	.md-body :global(.md-mention-chip) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 7px 1px 3px;
		margin: 0 1px;
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		border-radius: 999px;
		font-size: 12.5px;
		color: var(--accent-hover);
		font-weight: 600;
		line-height: 1.2;
		vertical-align: middle;
		text-decoration: none;
		cursor: pointer;
		user-select: none;
	}

	.md-body :global(a.md-mention-chip) {
		color: var(--accent-hover);
		text-decoration: none;
	}

	.md-body :global(.md-mention-chip:hover) {
		background: var(--accent-border);
	}

	.md-body :global(.md-mention-chip.is-everyone) {
		cursor: default;
	}

	.md-body :global(.md-mention-chip) :global(.chip-avatar-img),
	.md-body :global(.md-mention-chip) :global(.chip-avatar-letter) {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		object-fit: cover;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 9.5px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.md-body :global(.md-mention-chip) :global(.chip-avatar-icon) {
		font-size: 12px;
		line-height: 1;
	}

	.md-body :global(.md-mention-chip) :global(.chip-name) {
		line-height: 1;
		white-space: nowrap;
	}

	.md-body :global(.md-mention-unresolved) {
		color: var(--muted);
		border-bottom: 1px dashed var(--muted);
		cursor: help;
	}

	.md-body :global(.code-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 0 6px;
		margin-bottom: 6px;
		border-bottom: 1px solid var(--line);
		font-size: 11px;
		color: var(--muted);
		user-select: none;
	}

	.md-body :global(.code-lang) {
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 10px;
	}

	.md-body :global(.code-copy-btn) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 11px;
		color: var(--muted);
		background: transparent;
		border: 1px solid transparent;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.md-body :global(.code-copy-btn:hover) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.md-body.is-inverted :global(a),
	.md-body.is-inverted :global(a.md-external-link),
	.md-body.is-inverted :global(a.md-artifact-link) {
		color: #ffffff;
	}

	.md-body.is-inverted :global(a.md-artifact-image) {
		background: rgba(255, 255, 255, 0.14);
		border-color: rgba(255, 255, 255, 0.3);
		color: #ffffff;
	}

	.md-body.is-inverted :global(a.md-artifact-image:hover),
	.md-body.is-inverted :global(a.md-artifact-image:focus-visible) {
		border-color: rgba(255, 255, 255, 0.7);
	}

	.md-body.is-inverted :global(.md-mention-chip),
	.md-body.is-inverted :global(a.md-mention-chip) {
		background: rgba(255, 255, 255, 0.18);
		border-color: rgba(255, 255, 255, 0.35);
		color: #ffffff;
	}

	.md-body.is-inverted :global(.md-mention-chip:hover) {
		background: rgba(255, 255, 255, 0.28);
	}

	.md-body.is-inverted :global(code) {
		background: rgba(255, 255, 255, 0.18);
	}

	.md-body.is-inverted :global(pre) {
		background: rgba(15, 23, 42, 0.28);
		border-color: rgba(255, 255, 255, 0.2);
		color: #ffffff;
	}

	.md-body.is-inverted :global(blockquote) {
		border-left-color: rgba(255, 255, 255, 0.45);
		color: rgba(255, 255, 255, 0.85);
	}

	.md-body.is-inverted :global(hr) {
		border-top-color: rgba(255, 255, 255, 0.35);
	}

	.md-body.is-inverted :global(th),
	.md-body.is-inverted :global(td) {
		border-color: rgba(255, 255, 255, 0.35);
	}

	.md-body.is-inverted :global(th) {
		background: rgba(255, 255, 255, 0.12);
	}

	@media (max-width: 680px) {
		/* Markers sit closer to the text, so a wrapped line does not read as a new bullet. */
		.md-body :global(ul),
		.md-body :global(ol) {
			padding-left: 1.05em;
		}

		/* A commit hash or a long path breaks where it must, rather than taking a line of its
		   own and leaving the line before it half empty. */
		.md-body :global(code),
		.md-body :global(a) {
			overflow-wrap: anywhere;
		}
	}
</style>
