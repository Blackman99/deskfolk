<script lang="ts">
	import type { ArtifactTreeNode } from './artifact-tree.ts';
	import FileIcon from './FileIcon.svelte';
	import { fileIconFor } from './file-icon.ts';

	interface Props {
		nodes: ArtifactTreeNode[];
		selected: string;
		label: string;
		onSelect: (node: ArtifactTreeNode) => void;
		lazyDirs?: boolean;
		loadedDirs?: ReadonlySet<string>;
		onExpandDir?: (path: string) => void;
		truncatedLabel?: string;
	}

	let { nodes, selected, label, onSelect, lazyDirs = false, loadedDirs, onExpandDir, truncatedLabel }: Props = $props();
	let collapsed = $state(new Set<string>());
	let expandedLazy = $state(new Set<string>());

	function isOpen(path: string): boolean {
		if (lazyDirs) return expandedLazy.has(path);
		return !collapsed.has(path);
	}

	function onNode(node: ArtifactTreeNode): void {
		if (node.kind === 'file') {
			onSelect(node);
			return;
		}
		if (lazyDirs) {
			const next = new Set(expandedLazy);
			if (next.has(node.path)) {
				next.delete(node.path);
				expandedLazy = next;
				return;
			}
			next.add(node.path);
			expandedLazy = next;
			if (!loadedDirs?.has(node.path)) onExpandDir?.(node.path);
			return;
		}
		if (!node.children?.length) {
			onSelect(node);
			return;
		}
		const next = new Set(collapsed);
		if (next.has(node.path)) next.delete(node.path);
		else next.add(node.path);
		collapsed = next;
	}
</script>

<nav class="artifact-tree" aria-label={label}>
	<ul class="artifact-tree-list list-none m-0 p-0">
		{#each nodes as node (node.path)}
			{@render row(node, 0)}
		{/each}
	</ul>
</nav>

{#snippet row(node: ArtifactTreeNode, depth: number)}
	<li>
		<button
			type="button"
			class="artifact-tree-row"
			class:is-selected={node.path === selected}
			class:is-dir={node.kind === 'dir'}
			style:padding-left="{8 + depth * 12}px"
			title={node.path}
			onclick={() => onNode(node)}
		>
			{#if node.kind === 'dir'}
				<span class="artifact-tree-chevron" class:is-open={isOpen(node.path)} aria-hidden="true">▸</span>
			{/if}
			<span class="artifact-tree-file">
				<FileIcon icon={fileIconFor(node.path, { isDir: node.kind === 'dir' })} size={12} />
			</span>
			<span class="artifact-tree-name overflow-hidden text-ellipsis whitespace-nowrap">{node.name}</span>
		</button>
		{#if node.kind === 'dir' && isOpen(node.path)}
			<ul class="artifact-tree-list list-none m-0 p-0">
				{#if node.truncated && truncatedLabel}
					<li class="artifact-tree-note pt-2 pr-5 pb-2 pl-12 text-11 text-muted">{truncatedLabel}</li>
				{/if}
				{#each node.children ?? [] as child (child.path)}
					{@render row(child, depth + 1)}
				{/each}
			</ul>
		{/if}
	</li>
{/snippet}

<style>
	.artifact-tree {
		min-width: 0;
		overflow: auto;
		border-right: 1px solid var(--line);
		background: var(--sidebar-bg);
		padding: 8px 0;
	}

	.artifact-tree-row {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		line-height: 1.3;
		padding: 4px 10px 4px 8px;
		cursor: pointer;
		text-align: left;
		border-radius: 0;
	}

	.artifact-tree-row:hover {
		background: var(--row-hover);
	}

	.artifact-tree-row.is-selected {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.artifact-tree-chevron,
	.artifact-tree-file {
		width: 12px;
		flex-shrink: 0;
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.artifact-tree-chevron {
		font-size: 10px;
		transform: rotate(0deg);
		transition: transform 0.12s ease;
	}

	.artifact-tree-chevron.is-open {
		transform: rotate(90deg);
	}
</style>
