<script lang="ts" module>
	/** How a card stands out on the map: as it does on the board, lit, dimmed or asked for. */
	export type MinimapTone = 'lit' | 'blamed' | 'dim' | 'focus' | null;
</script>

<script lang="ts">
	import type { TaskTraceNode } from '@real-bot/protocol';
	import type { TraceFlow, TraceView } from './task-trace.ts';
	import {
		fromMinimap,
		minimapFrame,
		minimapSize,
		onMinimap,
		visibleRect,
		type MinimapFrame,
		type TraceRect
	} from './trace-minimap.ts';

	/**
	 * The whole board drawn small, with the part in view framed. Where it sits is the host's business;
	 * it sizes itself from the board's shape and the viewport it is drawn over.
	 */
	interface Props {
		flow: TraceFlow;
		view: TraceView;
		viewport: { width: number; height: number };
		toneOf: (node: TaskTraceNode) => MinimapTone;
		hint: string;
		/** Put the view's middle on this board point; a press slides there, a drag follows the pointer. */
		onCentre: (point: { x: number; y: number }, glide: boolean) => void;
		/** The wheel over the map is the board's, so the corner is not a dead spot for scrolling. */
		onWheel: (event: WheelEvent) => void;
	}

	let { flow, view, viewport, toneOf, hint, onCentre, onWheel }: Props = $props();

	let el = $state<HTMLElement>();
	/**
	 * The map as it was when pressed. It draws the view's frame along with the board, so a drag that
	 * takes the frame off the board would rescale the map under the pointer; it holds still until
	 * the press is let go.
	 */
	let held = $state<MinimapFrame | null>(null);
	let press: { pointer: number; x: number; y: number; grab: { x: number; y: number }; moved: boolean } | null = null;

	const size = $derived(minimapSize(flow, viewport, view.scale));
	const visible = $derived<TraceRect | null>(
		viewport.width && viewport.height ? visibleRect(view, viewport) : null
	);
	const frame = $derived(held ?? (size ? minimapFrame(flow, visible, size) : null));

	/** A card a few pixels across still reads as one, and a folded round's line as a line. */
	function drawn(at: MinimapFrame, rect: TraceRect, least = 1.5): TraceRect {
		const box = onMinimap(at, rect);
		return { ...box, width: Math.max(least, box.width), height: Math.max(least, box.height) };
	}

	function local(event: { clientX: number; clientY: number }): { x: number; y: number } {
		const box = el?.getBoundingClientRect();
		return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
	}

	function onPointerDown(event: PointerEvent): void {
		if (!frame || (event.pointerType === 'mouse' && event.button !== 0)) return;
		event.preventDefault();
		held = frame;
		try {
			el?.setPointerCapture(event.pointerId);
		} catch {
			// A pointer that has already gone is not worth failing the press over.
		}
		const at = fromMinimap(frame, local(event));
		const inFrame =
			visible !== null &&
			at.x >= visible.x &&
			at.x <= visible.x + visible.width &&
			at.y >= visible.y &&
			at.y <= visible.y + visible.height;
		// Pressed inside the frame, the frame is picked up where it was pressed; anywhere else the view
		// slides there, and a drag from then on carries it.
		const grab = inFrame && visible
			? { x: at.x - (visible.x + visible.width / 2), y: at.y - (visible.y + visible.height / 2) }
			: { x: 0, y: 0 };
		press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, grab, moved: false };
		if (!inFrame) onCentre(at, true);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!press || event.pointerId !== press.pointer || !held) return;
		event.preventDefault();
		// A hand that shakes on a press is not a drag: it would cut the slide short.
		if (!press.moved && Math.abs(event.clientX - press.x) <= 2 && Math.abs(event.clientY - press.y) <= 2) return;
		press.moved = true;
		const at = fromMinimap(held, local(event));
		onCentre({ x: at.x - press.grab.x, y: at.y - press.grab.y }, false);
	}

	function onPointerUp(event: PointerEvent): void {
		if (!press || event.pointerId !== press.pointer) return;
		press = null;
		held = null;
		if (el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
	}

	/** Bound by hand: Svelte's wheel listener is passive, where `preventDefault` is ignored. */
	function wheel(node: HTMLElement) {
		const forward = (event: WheelEvent) => onWheel(event);
		node.addEventListener('wheel', forward, { passive: false });
		return { destroy: () => node.removeEventListener('wheel', forward) };
	}
</script>

{#if frame}
	<!--
		The cards themselves are what a screen reader reads; the map only repeats where they are, for
		the eye and the pointer.
	-->
	<div
		class="trace-minimap"
		class:is-held={held !== null}
		style="width: {frame.width}px; height: {frame.height}px;"
		title={hint}
		aria-hidden="true"
		bind:this={el}
		use:wheel
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
	>
		<svg width={frame.width} height={frame.height}>
			{#each flow.rounds as round (round.root)}
				{#if round.header}
					{@const box = drawn(frame, round.header)}
					<rect
						class="minimap-round"
						class:is-folded={round.folded}
						x={box.x}
						y={box.y}
						width={box.width}
						height={box.height}
						rx={Math.min(box.height / 2, 3)}
					/>
				{/if}
			{/each}
			{#each flow.placements as placement (placement.node.turn_id)}
				{@const box = drawn(frame, placement)}
				{@const tone = toneOf(placement.node)}
				<rect
					class="minimap-card is-{placement.node.status}"
					class:is-lit={tone === 'lit'}
					class:is-blamed={tone === 'blamed'}
					class:is-dim={tone === 'dim'}
					class:is-focus={tone === 'focus'}
					data-turn={placement.node.turn_id}
					x={box.x}
					y={box.y}
					width={box.width}
					height={box.height}
					rx="1"
				/>
			{/each}
			{#if visible}
				{@const box = onMinimap(frame, visible)}
				<rect class="minimap-view" x={box.x} y={box.y} width={box.width} height={box.height} rx="2" />
			{/if}
		</svg>
	</div>
{/if}

<style>
	.trace-minimap {
		position: relative;
		overflow: hidden;
		border-radius: var(--radius-md);
		/* The edge is a shadow, not a border, so the drawing's pixels and the pointer's line up. */
		box-shadow: inset 0 0 0 1px var(--line), var(--shadow-xs);
		background: color-mix(in srgb, var(--pane) 92%, transparent);
		backdrop-filter: blur(6px);
		/* Every gesture on it is the map's: no page scroll, no browser pinch. */
		touch-action: none;
		user-select: none;
		cursor: pointer;
	}

	.trace-minimap.is-held {
		cursor: grabbing;
	}

	.trace-minimap svg {
		display: block;
		overflow: hidden;
	}

	.minimap-round {
		fill: var(--line);
	}

	.minimap-round.is-folded {
		fill: var(--line-hover);
	}

	/* Each card in the colour of its status, as the stripe down its left edge is on the board. */
	.minimap-card {
		fill: var(--muted-light);
		fill-opacity: 0.7;
		stroke: none;
	}

	.minimap-card.is-running { fill: var(--accent); }
	.minimap-card.is-waiting_approval { fill: var(--warn); }
	.minimap-card.is-waiting_ask { fill: var(--purple); }
	.minimap-card.is-completed { fill: var(--ok); }
	.minimap-card.is-redirected { fill: var(--muted); }
	.minimap-card.is-interrupted,
	.minimap-card.is-stopped { fill: var(--danger); }

	.minimap-card.is-dim {
		fill-opacity: 0.2;
	}

	.minimap-card.is-lit,
	.minimap-card.is-blamed,
	.minimap-card.is-focus {
		fill-opacity: 1;
		stroke-width: 1.5px;
	}

	.minimap-card.is-lit,
	.minimap-card.is-focus {
		stroke: var(--accent);
	}

	.minimap-card.is-blamed {
		stroke: var(--warn);
	}

	.minimap-view {
		fill: color-mix(in srgb, var(--accent) 10%, transparent);
		stroke: var(--accent);
		stroke-width: 1.25px;
	}
</style>
