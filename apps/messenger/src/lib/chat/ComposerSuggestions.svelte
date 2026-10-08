<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { SessionView } from '../session-view.svelte.ts';

	type Props = {
		/** The conversation's drafted next lines; empty while it says there is nothing to suggest. */
		suggestions: SessionView['composerSuggestions'];
		t: Copy;
		onPickPrompt: (prompt: string) => void;
	};

	let { suggestions, t, onPickPrompt }: Props = $props();

	let suggestScrollEl = $state<HTMLDivElement | null>(null);
	let suggestMoreStart = $state(false);
	let suggestMoreEnd = $state(false);

	/**
	 * The chips stay one row and scroll sideways. A mouse wheel only scrolls down, which in a
	 * narrow pane left the chips past the edge out of reach, so it is turned sideways here; the
	 * edges fade while there is more that way, rather than a chip ending in a hard cut.
	 */
	$effect(() => {
		const row = suggestScrollEl;
		void suggestions;
		if (!row) return;
		const edges = () => {
			const max = row.scrollWidth - row.clientWidth;
			suggestMoreStart = row.scrollLeft > 1;
			suggestMoreEnd = row.scrollLeft < max - 1;
		};
		const onWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
			e.preventDefault();
			row.scrollLeft += e.deltaY;
		};
		edges();
		row.addEventListener('scroll', edges, { passive: true });
		row.addEventListener('wheel', onWheel, { passive: false });
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(edges);
		observer?.observe(row);
		return () => {
			row.removeEventListener('scroll', edges);
			row.removeEventListener('wheel', onWheel);
			observer?.disconnect();
		};
	});
</script>

<div
	bind:this={suggestScrollEl}
	class="suggest-scroll"
	class:has-more-start={suggestMoreStart}
	class:has-more-end={suggestMoreEnd}
>
	{#each suggestions as suggestion (suggestion.id)}
		<button
			type="button"
			class="suggest-chip"
			title={suggestion.prompt}
			onclick={() => onPickPrompt(suggestion.prompt)}
		>
			{suggestion.label}
		</button>
	{:else}
		<span class="suggest-note" role="status">{t.composer.suggestNone}</span>
	{/each}
</div>

<style>
	/* The scroller is inside the frost, so fading its edges does not cut the frost's halo off. */
	.suggest-scroll {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: nowrap;
		min-width: 0;
		padding: 4px 8px 10px 4px;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}

	.suggest-scroll::-webkit-scrollbar {
		display: none;
	}

	.suggest-scroll.has-more-end {
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
	}

	.suggest-scroll.has-more-start {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 28px);
		mask-image: linear-gradient(to right, transparent, #000 28px);
	}

	.suggest-scroll.has-more-start.has-more-end {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent);
	}

	.suggest-note {
		padding: 4px 6px;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
		white-space: nowrap;
	}

	.suggest-chip {
		position: relative;
		z-index: 1;
		pointer-events: auto;
		flex: 0 0 auto;
		max-width: none;
		padding: 4px 10px;
		border-radius: var(--radius-full);
		font-size: 12px;
		font-weight: 500;
		line-height: 1.3;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--ink);
		cursor: pointer;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.suggest-chip:hover {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	@container conversation (max-width: 680px) {
		.suggest-scroll {
			flex: 1;
			padding: 8px 10px 2px;
		}

		.suggest-chip {
			min-height: 30px;
			max-width: 85%;
			padding: 4px 10px;
			font-size: 12px;
		}

		@media (pointer: coarse) {
			.suggest-scroll {
				padding-left: max(16px, env(safe-area-inset-left, 0px));
				padding-right: max(16px, env(safe-area-inset-right, 0px));
			}
		}
	}
</style>
