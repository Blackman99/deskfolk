<script lang="ts">
	import { usageLeft, usageLevel } from './usage.ts';

	/** A small ring as full as what is left of a window, in its level's colour. */
	interface Props {
		/** How much of the window is used, 0–100. */
		percent: number;
		size?: number;
	}

	let { percent, size = 14 }: Props = $props();
</script>

<svg class="usage-ring is-{usageLevel(percent)}" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
	<circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--line)" stroke-width="1.75" />
	<circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - usageLeft(percent)} transform="rotate(-90 6 6)" />
</svg>

<style>
	.usage-ring {
		flex: none;
		color: var(--muted);
	}

	.usage-ring.is-warn {
		color: var(--warn);
	}

	.usage-ring.is-danger {
		color: var(--danger);
	}
</style>
