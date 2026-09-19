<script lang="ts">
	import type { FileIcon } from './file-icon.ts';

	interface Props {
		icon: FileIcon;
		size?: number;
	}

	let { icon, size = 14 }: Props = $props();
</script>

<span class="file-glyph" style:color={icon.tint} aria-hidden="true">
	{#if icon.letter}
		<span class="file-glyph-letter" style:font-size="{Math.max(8, size - 4)}px">{icon.letter}</span>
	{:else if icon.shape === 'folder'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
	{:else if icon.shape === 'image'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg>
	{:else if icon.shape === 'audio'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
	{:else if icon.shape === 'video'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="14" height="12" rx="2"></rect><path d="m16 10 6-3v10l-6-3z"></path></svg>
	{:else if icon.shape === 'pdf'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M8 13h8M8 17h5"></path></svg>
	{:else if icon.shape === 'html'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 6 2 12 8 18"></polyline><polyline points="16 6 22 12 16 18"></polyline></svg>
	{:else if icon.shape === 'markdown'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18v14H3z"></path><path d="m7 15 3-6 3 6M14 9v6"></path></svg>
	{:else if icon.shape === 'code'}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 6 2 12 8 18"></polyline><polyline points="16 6 22 12 16 18"></polyline></svg>
	{:else}
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
	{/if}
</span>

<style>
	.file-glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		line-height: 1;
	}

	.file-glyph-letter {
		font-family: var(--mono);
		font-weight: 700;
		letter-spacing: -0.04em;
		line-height: 1;
	}
</style>
