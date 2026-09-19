<script lang="ts">
	import type { Snippet } from 'svelte';
	import { markdownCode } from './chat/code-blocks.ts';
	import { parseMentionHref } from './chat/mention-chips.ts';
	import { renderMarkdown, type RenderMarkdownOptions } from './markdown.ts';
	import { parseArtifactHref } from './overlays/artifacts.ts';

	interface Props {
		source: string;
		options?: RenderMarkdownOptions;
		copyLabel: string;
		copiedLabel: string;
		/** User-bubble chrome: light text on the accent fill. */
		inverted?: boolean;
		class?: string;
		onOpenArtifact?: (relpath: string) => void;
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
		const href = a.href;
		if (href.startsWith('https:') || href.startsWith('http:') || href.startsWith('mailto:')) {
			window.open(href, '_blank', 'noopener,noreferrer');
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

	function enhance(node: HTMLElement, labels: { copy: string; copied: string }) {
		const code = markdownCode(node, labels);
		wrapTables(node);
		const tables = new MutationObserver(() => wrapTables(node));
		tables.observe(node, { childList: true, subtree: true });
		node.addEventListener('click', onClick);
		return {
			update(next: { copy: string; copied: string }) {
				code.update(next);
			},
			destroy() {
				tables.disconnect();
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
	 * block` on <table> is what collapsed columns in the preview. Wide tables
	 * scroll inside `.md-table-wrap` instead.
	 */
	.md-body :global(.md-table-wrap) {
		overflow-x: auto;
		max-width: 100%;
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
		padding: 4px 8px;
		vertical-align: top;
	}

	.md-body :global(th) {
		font-weight: 650;
		background: var(--line-subtle);
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

	.md-body.is-inverted :global(a) {
		color: #ffffff;
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
</style>
