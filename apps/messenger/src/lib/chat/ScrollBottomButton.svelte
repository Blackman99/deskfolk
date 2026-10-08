<script lang="ts">
	import type { Copy } from '../copy.ts';

	type Props = {
		/** The stage owns stick-to-bottom; this only draws the jump control on the card. */
		shown: boolean;
		t: Copy;
		onScrollToBottom?: () => void;
	};

	let { shown: showScrollBottom, t, onScrollToBottom }: Props = $props();
</script>

<div class="scroll-bottom-slot" class:is-shown={showScrollBottom} aria-hidden={showScrollBottom ? undefined : true}>
	<button
		type="button"
		class="scroll-bottom-btn"
		tabindex={showScrollBottom ? 0 : -1}
		title={t.chat.scrollToBottom}
		aria-label={t.chat.scrollToBottom}
		onclick={() => onScrollToBottom?.()}
	>
		<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
	</button>
</div>

<style>
	/* The jump control floats above the card's top-right and grows out of the card. */
	.scroll-bottom-slot {
		position: absolute;
		/* Above the card's frost, under the card, so the circle sinks behind the input. */
		z-index: 1;
		/* 32px circle, 12px of air, then 32px of travel behind the card. The slot's own clip stays inside the card. */
		top: -44px;
		right: 8px;
		width: 32px;
		height: 76px;
		overflow: hidden;
		pointer-events: none;
	}

	.scroll-bottom-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 50%;
		background: var(--input-bg);
		/* The slot is this box exactly. An outer shadow is clipped into a square halo. */
		box-shadow: none;
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		pointer-events: none;
		transform: translateY(76px);
		transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
	}

	.scroll-bottom-slot.is-shown {
		pointer-events: auto;
	}

	.scroll-bottom-slot.is-shown .scroll-bottom-btn {
		transform: translateY(0);
		pointer-events: auto;
	}

	.scroll-bottom-btn:hover {
		color: var(--accent);
		background: var(--line-subtle);
	}

	.scroll-bottom-btn:focus-visible {
		/* Same clip: an offset outline or outer glow is cut into a square. Draw the ring inside. */
		outline: none;
		border-color: transparent !important;
		box-shadow: inset 0 0 0 2px var(--accent);
	}

	@container conversation (max-width: 680px) {
		@media (pointer: coarse) {
			/* Centred over send, and off the curve with it. */
			.scroll-bottom-slot {
				right: max(20px, calc(env(safe-area-inset-right, 0px) + 4px));
			}
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.scroll-bottom-btn {
			transition: none;
		}
	}
</style>
