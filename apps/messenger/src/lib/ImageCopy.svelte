<script lang="ts">
	/**
	 * One listener for every picture the app rendered. Mounted once on the shell, so a preview,
	 * a lightbox and a chat thumbnail all get the same menu without each surface owning a copy.
	 */
	import type { Copy } from './copy.ts';
	import { copyableImageAt } from './image-context.ts';
	import ImageContextMenu from './ImageContextMenu.svelte';

	let { t }: { t: Copy } = $props();

	let open = $state<{ src: string; x: number; y: number } | null>(null);

	function onContextMenu(event: MouseEvent): void {
		if (event.defaultPrevented || event.altKey) return;
		const image = copyableImageAt(event.target);
		if (!image) return;
		// preventDefault is enough for the pane menu. The event still bubbles so a message menu
		// that was already open can close itself.
		event.preventDefault();
		open = { src: image.currentSrc, x: event.clientX, y: event.clientY };
	}
</script>

<!-- Capture: this runs before a message or a pane claims the right-click on the way down. -->
<svelte:document oncontextmenucapture={onContextMenu} />

{#if open}
	<ImageContextMenu src={open.src} x={open.x} y={open.y} {t} onClose={() => (open = null)} />
{/if}
