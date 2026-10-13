<script lang="ts">
	/** One of the app's stroke icons (`icons.ts`), decorative unless given a label. */
	import { iconShapes, type IconName } from './icons.ts';

	type Props = {
		name: IconName;
		/** Edge length in px. */
		size?: number;
		/** Read out when the icon carries meaning on its own; without it the icon is hidden from readers. */
		label?: string;
		class?: string;
	};

	let { name, size = 16, label, class: className = '' }: Props = $props();

	const icon = $derived(iconShapes(name));
</script>

<svg
	class="icon {className}"
	class:is-filled={icon.fill}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	data-icon={name}
>
	{#each icon.shapes as shape, i (i)}
		{#if 'p' in shape}
			<path d={shape.p} />
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
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.icon.is-filled {
		fill: currentColor;
		stroke: none;
	}
</style>
