<script lang="ts">
	/**
	 * The Deskfolk mark: a message bubble holding two stacked teammates, the mascots Mochi (white)
	 * and Pudding (mustard), Pudding ringed in the bubble's colour so it cuts into Mochi. Colours
	 * come from tokens.css, so the mark steps lighter in dark mode instead of being a fixed-hex
	 * copy per screen.
	 *
	 * `art` is the faded mark an empty state draws: a tint bubble, a ringed pane-coloured circle,
	 * and only the mustard teammate left solid.
	 */
	interface Props {
		size?: number;
		variant?: 'mark' | 'art';
	}

	let { size = 24, variant = 'mark' }: Props = $props();
</script>

<svg
	class="brand-mark"
	class:is-art={variant === 'art'}
	width={size}
	height={size}
	viewBox="0 0 64 64"
	aria-hidden="true"
	focusable="false"
>
	<path
		class="bubble"
		d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z"
	/>
	<circle class="front" cx="25" cy="29" r="10.5" />
	<circle class="mustard" cx="39.5" cy="29" r="10.5" />
</svg>

<style>
	.brand-mark {
		display: block;
		flex-shrink: 0;
	}

	.bubble {
		fill: var(--brand-bubble);
	}

	.front {
		fill: var(--brand-front);
	}

	.mustard {
		fill: var(--brand-mustard);
		stroke: var(--brand-bubble);
		stroke-width: 3;
	}

	.is-art .bubble {
		fill: var(--art-bubble);
	}

	.is-art .front {
		fill: var(--art-front);
		stroke: var(--art-ring);
		stroke-width: 1.5;
	}

	.is-art .mustard {
		stroke: var(--art-bubble);
	}
</style>
