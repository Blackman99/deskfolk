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
	<ul class="artifact-tree-list">
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
			<span class="artifact-tree-name">{node.name}</span>
		</button>
		{#if node.kind === 'dir' && isOpen(node.path)}
			<ul class="artifact-tree-list">
				{#if node.truncated && truncatedLabel}
					<li class="artifact-tree-note">{truncatedLabel}</li>
				{/if}
				{#each node.children ?? [] as child (child.path)}
					{@render row(child, depth + 1)}
				{/each}
			</ul>
		{/if}
	</li>
{/snippet}
