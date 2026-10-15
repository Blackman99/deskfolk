<script lang="ts">
	import type { FileIcon } from './file-icon.ts';
	import Icon from '../Icon.svelte';
	import type { IconName, IconSize } from '../icons.ts';

	interface Props {
		icon: FileIcon;
		size?: IconSize;
	}

	let { icon, size = 16 }: Props = $props();

	const GLYPHS: Record<string, IconName> = {
		folder: 'folder',
		image: 'image',
		audio: 'music',
		video: 'video',
		pdf: 'file-text',
		html: 'code',
		markdown: 'markdown',
		code: 'code'
	};
	const glyph = $derived<IconName>(GLYPHS[icon.shape] ?? 'file');
</script>

<span class="file-glyph" style:--glyph-tint={icon.tint} aria-hidden="true">
	{#if icon.letter}
		<span class="file-glyph-letter font-mono font-bold tracking-[-0.04em] leading-none" style:font-size="{Math.max(8, size - 4)}px">{icon.letter}</span>
	{:else}
		<Icon name={glyph} size={size} />
	{/if}
</span>

<style>
	.file-glyph {
		color: var(--glyph-tint);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		line-height: 1;
	}

	/* The tints are picked against a light pane; on a dark one the greys of Markdown and plain text
	 * all but vanish, so every tint is lifted toward the text colour there. */
	:global([data-theme='dark']) .file-glyph {
		color: color-mix(in srgb, var(--glyph-tint) 60%, var(--ink));
	}
</style>
