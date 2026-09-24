<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A styled tip for one rail control. The rail clips (`overflow` / `contain`), so the tip is a
	 * manual popover in the top layer, placed to the right of its anchor. Hover waits; keyboard
	 * focus does not. The pointer can move into the tip. Escape dismisses it and stops there.
	 */
	type Props = {
		/** What the tip says. A string is one line; lines stack, the first as the title. */
		label: string | readonly string[];
		/** Accessible name of the control. Defaults to the tip's first line. */
		name?: string;
		/** Id of the tip, for the control's `aria-describedby` while it is showing. */
		describedBy: string;
		/** When false the control is `aria-disabled` and its click is swallowed. */
		enabled?: boolean;
		class?: string;
		onclick?: (e: MouseEvent) => void;
		oncontextmenu?: (e: MouseEvent) => void;
		onkeydown?: (e: KeyboardEvent) => void;
		children: Snippet;
		/** Extra attributes (`aria-current`, `data-session`, …) land on the button. */
		[key: string]: unknown;
	};

	let {
		label,
		name,
		describedBy,
		enabled = true,
		class: className = '',
		onclick,
		oncontextmenu,
		onkeydown,
		children,
		...rest
	}: Props = $props();

	/** Long enough that a pass across the rail does not light every tip; short enough to feel waiting. */
	const HOVER_DELAY_MS = 200;
	const MARGIN = 8;
	const GAP = 8;

	const lines = $derived(
		(Array.isArray(label) ? label : [label]).map((line) => line.trim()).filter((line) => line.length > 0)
	);
	const accessibleName = $derived(name ?? lines[0] ?? '');

	let buttonEl = $state<HTMLButtonElement | null>(null);
	let tipEl = $state<HTMLDivElement | null>(null);
	/**
	 * A popover inside the button is lifted into the top layer and then left behind when it hides.
	 * The tip is moved to the body, where hiding removes it with the component.
	 */
	function portalTo(node: HTMLElement): { destroy: () => void } {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	/** The button, for a menu that hangs off this control. */
	export function anchor(): HTMLButtonElement | null {
		return buttonEl;
	}
	let open = $state(false);
	/** Hover is pending the delay; focus and a move into the tip are not. */
	let hovering = $state(false);
	let focusing = $state(false);
	let overTip = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** The pointer that opened it, so a touch never leaves a tip stuck open. */
	let fromTouch = false;

	function clearTimer(): void {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	}

	function place(): void {
		if (!open || !buttonEl || !tipEl) return;
		const anchor = buttonEl.getBoundingClientRect();
		const tip = tipEl.getBoundingClientRect();
		const right = anchor.right + GAP;
		const left = right + tip.width <= window.innerWidth - MARGIN ? right : anchor.left - tip.width - GAP;
		const top = anchor.top + (anchor.height - tip.height) / 2;
		tipEl.style.left = `${Math.max(MARGIN, Math.min(left, window.innerWidth - tip.width - MARGIN))}px`;
		tipEl.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - tip.height - MARGIN))}px`;
	}

	function show(): void {
		clearTimer();
		open = true;
	}

	function hide(): void {
		clearTimer();
		hovering = false;
		focusing = false;
		overTip = false;
		open = false;
		fromTouch = false;
	}

	function onMouseEnter(): void {
		if (fromTouch) return;
		hovering = true;
		if (open || focusing) {
			show();
			return;
		}
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			if (hovering) open = true;
		}, HOVER_DELAY_MS);
	}

	function onMouseLeave(e: MouseEvent): void {
		if (fromTouch) return;
		hovering = false;
		clearTimer();
		// The tip is portaled, so the way onto it is a leave. That enter carries the same point.
		const ontoTip = tipEl && pointIn(tipEl, e.clientX, e.clientY);
		if (ontoTip) {
			overTip = true;
			return;
		}
		if (focusing || overTip) return;
		timer = setTimeout(() => { timer = null; if (!hovering && !overTip && !focusing) open = false; }, 140);
	}

	function onFocusIn(e: FocusEvent): void {
		// A click focuses too. Touch should act and not leave the tip behind. A child inside the
		// button focusing is still this control; anything else bubbling through is not.
		const target = e.target;
		if (!(target instanceof Node) || !buttonEl?.contains(target)) return;
		if (fromTouch) {
			fromTouch = false;
			return;
		}
		focusing = true;
		show();
	}

	function onFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget;
		if (next instanceof Node && (buttonEl?.contains(next) || tipEl?.contains(next))) return;
		focusing = false;
		if (!hovering && !overTip) open = false;
	}

	function onTipEnter(): void {
		if (fromTouch) return;
		overTip = true;
		clearTimer();
	}

	function onTipLeave(e: MouseEvent): void {
		if (fromTouch) return;
		overTip = false;
		clearTimer();
		if (buttonEl && pointIn(buttonEl, e.clientX, e.clientY)) {
			hovering = true;
			return;
		}
		if (!hovering && !focusing) open = false;
	}

	function pointIn(el: HTMLElement, x: number, y: number): boolean {
		const box = el.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0) return false;
		return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
	}

	function onClick(e: MouseEvent): void {
		fromTouch = false;
		hide();
		if (!enabled) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		onclick?.(e);
	}

	function onPointerDown(e: PointerEvent): void {
		fromTouch = e.pointerType === 'touch';
		if (fromTouch) {
			clearTimer();
			open = false;
		}
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			e.stopPropagation();
			// Dismissed, not a blur: keyboard focus stays, and the tip stays gone until the pointer
			// or focus comes back.
			focusing = false;
			hide();
			return;
		}
		onkeydown?.(e);
	}

	function onScroll(e: Event): void {
		if (!open) return;
		const target = e.target;
		if (target instanceof Node && tipEl?.contains(target)) return;
		hide();
	}

	$effect(() => {
		const el = tipEl;
		if (!open || !el) return;
		// The attribute is on the element. Showing it lifts it into the top layer; hiding on the way
		// out lets the node leave. A document without popovers keeps the fixed position.
		if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) {
			try {
				el.showPopover();
			} catch {
				// Already showing, or this document has no top layer.
			}
		}
		place();
		const observer = new ResizeObserver(place);
		observer.observe(el);
		if (buttonEl) observer.observe(buttonEl);
		return () => {
			observer.disconnect();
			if (typeof el.hidePopover === 'function') {
				try {
					el.hidePopover();
				} catch {
					// Unmounted with the rail.
				}
			}
		};
	});

	$effect(() => {
		return () => clearTimer();
	});

	// Capture: a scroll inside the rail does not bubble to the window, and neither does one on it.
	$effect(() => {
		if (!open) return;
		const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hide(); } };
		document.addEventListener('scroll', onScroll, true);
		window.addEventListener('keydown', escape, true);
		window.addEventListener('resize', hide);
		return () => { document.removeEventListener('scroll', onScroll, true); window.removeEventListener('keydown', escape, true); window.removeEventListener('resize', hide); };
	});

	// mouseenter does not bubble, so the listener has to be on the node itself.
	$effect(() => {
		const el = buttonEl;
		if (!el) return;
		el.addEventListener('mouseenter', onMouseEnter);
		el.addEventListener('mouseleave', onMouseLeave);
		return () => {
			el.removeEventListener('mouseenter', onMouseEnter);
			el.removeEventListener('mouseleave', onMouseLeave);
		};
	});

	$effect(() => {
		const el = tipEl;
		if (!el) return;
		el.addEventListener('mouseenter', onTipEnter);
		el.addEventListener('mouseleave', onTipLeave);
		return () => {
			el.removeEventListener('mouseenter', onTipEnter);
			el.removeEventListener('mouseleave', onTipLeave);
		};
	});
</script>



<button
	bind:this={buttonEl}
	type="button"
	class="rail-tip-anchor {className}"
	aria-label={accessibleName}
	aria-describedby={open && lines.length > 0 ? describedBy : undefined}
	aria-disabled={enabled ? undefined : 'true'}
	{...rest}
	onpointerdown={onPointerDown}
	onfocusin={onFocusIn}
	onfocusout={onFocusOut}
	onkeydown={onKeyDown}
	onclick={onClick}
	oncontextmenu={(event) => { hide(); oncontextmenu?.(event); }}
>
	{@render children()}
</button>

{#if open && lines.length > 0}
	<div use:portalTo class="rail-tooltip-portal" style="display: contents" data-rail-tip={describedBy}>
		<div
			bind:this={tipEl}
			id={describedBy}
			class="rail-tooltip"
			role="tooltip"
			popover="manual"
			style:left="{MARGIN}px"
			style:top="{MARGIN}px"
		>
			{#each lines as line, index (index)}
				<span class="rail-tooltip-line" class:is-meta={index > 0}>{line}</span>
			{/each}
		</div>
	</div>
{/if}

<style>
	.rail-tip-anchor {
		position: relative;
	}

	.rail-tip-anchor[aria-disabled='true'] {
		opacity: 0.35;
		cursor: default;
	}

	/*
	 * Fixed, and a manual popover when the document has one, so the rail's overflow cannot clip it.
	 * The UA popover is `inset: 0` and transparent until shown; both fight the placement below.
	 */
	.rail-tooltip {
		position: fixed;
		inset: unset;
		z-index: 120;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-width: min(280px, calc(100vw - 16px));
		margin: 0;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		font: 500 12px/1.35 var(--font);
		white-space: normal;
		text-align: left;
		pointer-events: auto;
		user-select: text;
	}

	.rail-tooltip-line {
		overflow-wrap: anywhere;
	}

	.rail-tooltip-line.is-meta {
		color: var(--muted);
		font-weight: 450;
	}
</style>
