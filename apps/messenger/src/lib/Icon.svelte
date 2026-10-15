<script lang="ts">
	/**
	 * One of the app's icons (`icons.ts`), decorative unless given a label. The stroke is a fixed
	 * 1.6 screen pixels at every size, so icons of different sizes on one screen still match.
	 */
	import type { ClassValue } from 'svelte/elements';
	import { iconShapes, type IconName, type IconSize } from './icons.ts';

	type Props = {
		name: IconName;
		/** Edge length in px, one of `ICON_SIZES` by role. */
		size?: IconSize;
		/** Draw the solid twin, for the selected item of a set; icons without one stay outlined. */
		filled?: boolean;
		/** Read out when the icon carries meaning on its own; without it the icon is hidden from readers. */
		label?: string;
		/** A tooltip, for an icon that stands alone in a row of text. */
		title?: string;
		class?: ClassValue;
		style?: string;
	};

	let { name, size = 16, filled = false, label, title, class: className, style }: Props = $props();

	const icon = $derived(iconShapes(name, filled));
</script>

<svg
	class={['icon', className, { 'is-filled': icon.fill, 'is-solid': icon.solid }]}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	data-icon={name}
	{style}
>
	{#if title}<title>{title}</title>{/if}
	{#each icon.shapes as shape, i (i)}
		{#if 'p' in shape}
			<path d={shape.p} fill-rule={shape.evenodd ? 'evenodd' : undefined} />
		{:else if 'c' in shape}
			<circle cx={shape.c[0]} cy={shape.c[1]} r={shape.c[2]} />
		{:else}
			<rect x={shape.r[0]} y={shape.r[1]} width={shape.r[2]} height={shape.r[3]} rx={shape.r[4]} />
		{/if}
	{/each}
</svg>

<style>
	.icon {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.icon > :global(*) {
		vector-effect: non-scaling-stroke;
	}

	.icon.is-solid {
		fill: currentColor;
	}

	.icon.is-filled {
		fill: currentColor;
		stroke: none;
	}
</style>
