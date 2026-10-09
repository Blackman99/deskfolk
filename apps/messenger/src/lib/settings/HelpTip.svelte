<script lang="ts">
	/**
	 * A "?" beside a heading whose explanation would otherwise sit under it as a paragraph. Hover or
	 * focus shows it; a click (a tap on the phone) pins it until a click elsewhere, Escape or a scroll.
	 * The tip is a manual popover so the settings body's overflow cannot clip it.
	 */
	interface Props {
		/** What the tip says. */
		text: string;
		/** The button's accessible name, e.g. "About Claude Agent". */
		label: string;
	}

	let { text, label }: Props = $props();

	const id = `help-tip-${Math.random().toString(36).slice(2, 10)}`;
	const MARGIN = 8;
	const GAP = 6;

	let buttonEl = $state<HTMLButtonElement | null>(null);
	let tipEl = $state<HTMLDivElement | null>(null);
	let hovering = $state(false);
	let focusing = $state(false);
	let pinned = $state(false);
	const open = $derived(pinned || hovering || focusing);

	function place(): void {
		if (!buttonEl || !tipEl) return;
		const anchor = buttonEl.getBoundingClientRect();
		const tip = tipEl.getBoundingClientRect();
		const below = anchor.bottom + GAP;
		const top = below + tip.height <= window.innerHeight - MARGIN ? below : anchor.top - tip.height - GAP;
		const left = anchor.left + anchor.width / 2 - tip.width / 2;
		tipEl.style.left = `${Math.max(MARGIN, Math.min(left, window.innerWidth - tip.width - MARGIN))}px`;
		tipEl.style.top = `${Math.max(MARGIN, top)}px`;
	}

	function close(): void {
		pinned = false;
		hovering = false;
		focusing = false;
	}

	$effect(() => {
		const el = tipEl;
		if (!open || !el) return;
		if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) {
			try {
				el.showPopover();
			} catch {
				// No top layer here: the fixed position still holds.
			}
		}
		place();
		const observer = new ResizeObserver(place);
		observer.observe(el);
		const outside = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && (buttonEl?.contains(target) || el.contains(target))) return;
			close();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		};
		const scroll = (event: Event) => {
			if (event.target instanceof Node && el.contains(event.target)) return;
			close();
		};
		document.addEventListener('pointerdown', outside, true);
		window.addEventListener('keydown', escape, true);
		document.addEventListener('scroll', scroll, true);
		window.addEventListener('resize', close);
		return () => {
			observer.disconnect();
			document.removeEventListener('pointerdown', outside, true);
			window.removeEventListener('keydown', escape, true);
			document.removeEventListener('scroll', scroll, true);
			window.removeEventListener('resize', close);
			if (typeof el.hidePopover === 'function') {
				try {
					el.hidePopover();
				} catch {
					// Already gone with the card.
				}
			}
		};
	});
</script>

<button
	bind:this={buttonEl}
	type="button"
	class="help-tip"
	aria-label={label}
	aria-expanded={open}
	aria-describedby={open ? id : undefined}
	data-help-tip
	onpointerenter={(event) => { if (event.pointerType !== 'touch') hovering = true; }}
	onpointerleave={(event) => { if (event.pointerType !== 'touch' && !(event.relatedTarget instanceof Node && tipEl?.contains(event.relatedTarget))) hovering = false; }}
	onfocus={() => (focusing = true)}
	onblur={() => (focusing = false)}
	onclick={() => { pinned = !pinned; if (!pinned) close(); }}
>?</button>

{#if open}
	<div
		bind:this={tipEl}
		{id}
		class="help-tip-text"
		role="tooltip"
		popover="manual"
		data-help-tip-text
		onpointerleave={(event) => { if (!(event.relatedTarget instanceof Node && buttonEl?.contains(event.relatedTarget))) hovering = false; }}
	>{text}</div>
{/if}

<style>
	.help-tip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		font: 600 10px/1 var(--font);
		cursor: help;
	}

	.help-tip:hover,
	.help-tip[aria-expanded='true'] {
		color: var(--ink);
		border-color: var(--muted);
	}

	/* The UA popover is `inset: 0` and centred; the placement above sets left and top. */
	.help-tip-text {
		position: fixed;
		inset: unset;
		left: 8px;
		top: 8px;
		z-index: 120;
		max-width: min(320px, calc(100vw - 16px));
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-md);
		font: 450 12px/1.5 var(--font);
		white-space: normal;
		text-align: left;
		user-select: text;
	}
</style>
