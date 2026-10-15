<script lang="ts">
	/**
	 * A small chip above the composer while something here waits on you — an approval, a question —
	 * and its card is scrolled out of sight. One click brings the card back into view.
	 *
	 * Only while the card cannot be seen: with the card on screen the card itself says it waits.
	 */
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { Waiting } from './waiting.ts';

	type Props = {
		/** The transcript's scrolling box, which the cards are measured against. */
		root: HTMLElement | null;
		waiting: Waiting[];
		t: Copy;
		onJump: (id: string) => void;
	};

	let { root, waiting, t, onJump }: Props = $props();

	/** The waiting cards out of sight, and on which side of the view the first of them is. */
	let hidden = $state<{ items: Waiting[]; above: boolean }>({ items: [], above: false });

	function measure(): void {
		if (!root || waiting.length === 0) {
			hidden = { items: [], above: false };
			return;
		}
		const view = root.getBoundingClientRect();
		const out: Waiting[] = [];
		let above = false;
		for (const item of waiting) {
			const el = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`);
			const box = el?.getBoundingClientRect();
			// A card the history window has not drawn yet counts as above the view.
			const isAbove = !box || box.bottom < view.top + 24;
			const isBelow = box ? box.top > view.bottom - 24 : false;
			if (isAbove || isBelow) {
				if (out.length === 0) above = isAbove;
				out.push(item);
			}
		}
		hidden = { items: out, above };
	}

	$effect(() => {
		void waiting;
		const el = root;
		if (!el) return;
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		};
		schedule();
		el.addEventListener('scroll', schedule, { passive: true });
		const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
		resize?.observe(el);
		return () => {
			el.removeEventListener('scroll', schedule);
			resize?.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	});

	const approvals = $derived(hidden.items.filter((item) => item.kind === 'approval').length);
	const asks = $derived(hidden.items.filter((item) => item.kind === 'ask').length);
	const label = $derived(
		approvals && asks
			? t.stream.waitingJump.both(approvals + asks)
			: approvals
				? t.stream.waitingJump.approvals(approvals)
				: t.stream.waitingJump.asks(asks)
	);
</script>

{#if hidden.items.length > 0}
	<button
		type="button"
		class="waiting-jump"
		class:is-ask={approvals === 0}
		onclick={() => onJump(hidden.items[0].id)}
	>
		<Icon name={approvals ? 'shield-check' : 'help-circle'} size={12} />
		<span>{label}</span>
		<Icon name={hidden.above ? 'arrow-up' : 'arrow-down'} size={12} />
	</button>
{/if}

<style>
	.waiting-jump {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px 0 10px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--warn-bg) 70%, var(--pane));
		color: var(--warn-text);
		box-shadow: inset 0 0 0 1px var(--warn-line), var(--shadow-md);
		font-size: var(--text-caption);
		font-weight: 650;
		white-space: nowrap;
		pointer-events: auto;
		animation: waiting-jump-in var(--dur-slow) var(--ease-out);
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.waiting-jump.is-ask {
		background: color-mix(in srgb, var(--purple-bg) 70%, var(--pane));
		color: var(--purple-text);
		box-shadow: inset 0 0 0 1px var(--purple-line), var(--shadow-md);
	}

	.waiting-jump:hover {
		box-shadow: inset 0 0 0 1px var(--warn), var(--shadow-lg);
	}

	.waiting-jump.is-ask:hover {
		box-shadow: inset 0 0 0 1px var(--purple), var(--shadow-lg);
	}

	.waiting-jump:active {
		transform: scale(0.97);
	}

	.waiting-jump:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	@keyframes waiting-jump-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
