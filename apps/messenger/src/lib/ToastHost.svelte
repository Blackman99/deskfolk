<script lang="ts">
	/**
	 * Where `showToast` puts its notice: one card in the top-right corner, just under the pane
	 * tabs, so the tab strip and its ⋯ stay reachable. The ring around ✕ is the time left; a
	 * pointer on the card or focus in it stops the ring and the timer together.
	 */
	import Icon from './Icon.svelte';
	import type { Copy } from './copy.ts';
	import type { IconName } from './icons.ts';
	import { toasts, type ToastTone } from './toast.svelte.ts';

	let { t }: { t: Copy } = $props();

	const toast = $derived(toasts.current);
	const GLYPHS: Record<ToastTone, IconName> = { neutral: 'check-circle', info: 'info', error: 'alert-circle' };
	let card = $state<HTMLElement | null>(null);
</script>

{#if toast}
	{#key toast.id}
		<div
			bind:this={card}
			class="toast-host is-{toast.tone}"
			class:is-leaving={toast.leaving}
			class:is-paused={toast.paused}
			style:--toast-ms="{toast.ms}ms"
			role={toast.tone === 'error' ? 'alert' : 'status'}
			aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
			onpointerenter={() => toasts.hold('pointer')}
			onpointerleave={() => toasts.release('pointer')}
			onfocusin={() => toasts.hold('focus')}
			onfocusout={(event) => {
				if (!card?.contains(event.relatedTarget as Node | null)) toasts.release('focus');
			}}
		>
			<span class="toast-glyph" aria-hidden="true"><Icon name={GLYPHS[toast.tone]} size={16} /></span>
			<p class="toast-text">{toast.text}</p>
			{#if toast.action}
				<button
					type="button"
					class="toast-act"
					onclick={() => {
						toast.action?.run();
						toasts.dismiss();
					}}>{toast.action.label}</button
				>
			{/if}
			<button type="button" class="toast-close" aria-label={t.common.close} title={t.common.close} onclick={() => toasts.dismiss()}>
				<svg class="toast-ring" viewBox="0 0 28 28" aria-hidden="true">
					<circle class="toast-ring-track" cx="14" cy="14" r="12.5" />
					<circle class="toast-ring-left" cx="14" cy="14" r="12.5" pathLength="100" />
				</svg>
				<Icon name="x" size={12} />
			</button>
		</div>
	{/key}
{/if}

<style>
	.toast-host {
		position: fixed;
		/* Under the pane tab strip (it ends near 36px), level with the top of the pane's own bar. */
		top: calc(env(safe-area-inset-top, 0px) + 48px);
		right: 16px;
		z-index: 1200;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: min(360px, calc(100vw - 32px));
		padding: 8px 8px 8px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-menu);
		animation: toast-in var(--dur-slow) var(--ease-out) both;
	}

	.toast-host.is-leaving {
		animation: toast-out var(--dur-base) ease-in both;
	}

	.toast-host.is-error {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
	}

	/* One text line is 28px tall, the height of ✕: glyph, text and button share a centre line,
	   and with more lines the glyph and ✕ stay by the first. */
	.toast-glyph {
		flex: none;
		display: grid;
		place-items: center;
		height: 28px;
		color: var(--ok);
	}

	.toast-host.is-info .toast-glyph {
		color: var(--muted);
	}

	.toast-host.is-error .toast-glyph {
		color: var(--danger);
	}

	.toast-text {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding-block: 4px;
		font-size: var(--text-small);
		font-weight: 500;
		line-height: 20px;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
	}

	.toast-act {
		flex: none;
		height: 28px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font-size: var(--text-small);
		font-weight: 600;
	}

	.toast-act:hover {
		background: var(--accent-tint);
	}

	.toast-close {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
	}

	.toast-close:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.toast-ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		/* The arc starts at twelve o'clock and gives way clockwise. */
		transform: rotate(-90deg);
		fill: none;
		stroke-width: 1.5;
		pointer-events: none;
	}

	.toast-ring-track {
		stroke: var(--line);
	}

	.toast-ring-left {
		stroke: var(--accent);
		stroke-linecap: round;
		stroke-dasharray: 100;
		stroke-dashoffset: 0;
		animation: toast-countdown var(--toast-ms) linear both;
	}

	.toast-host.is-paused .toast-ring-left {
		animation-play-state: paused;
	}

	@keyframes toast-countdown {
		to {
			stroke-dashoffset: -100;
		}
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
	}

	@keyframes toast-out {
		to {
			opacity: 0;
			transform: translateX(8px);
		}
	}

	/* The ring is a clock, not a flourish: reduced motion still lets it run for the toast's
	   whole span (base.css would otherwise end every animation at once, emptying it on arrival). */
	@media (prefers-reduced-motion: reduce) {
		.toast-ring-left {
			animation-duration: var(--toast-ms) !important;
		}
	}

	@media (max-width: 680px) {
		.toast-host {
			top: calc(env(safe-area-inset-top, 0px) + 8px);
			right: 12px;
			left: 12px;
			width: auto;
			padding: 6px 6px 6px 12px;
			animation-name: toast-drop;
		}

		.toast-host.is-leaving {
			animation-name: toast-lift;
		}

		.toast-glyph {
			height: 40px;
		}

		.toast-text {
			padding-block: 10px;
		}

		/* Thumb targets: 40px like the rest of the phone layout's icon buttons. */
		.toast-act,
		.toast-close {
			height: 40px;
		}

		.toast-close {
			width: 40px;
		}

		/* The ring keeps its desktop size inside the bigger target, so its line stays as thin. */
		.toast-ring {
			inset: 6px;
			width: 28px;
			height: 28px;
		}
	}

	@keyframes toast-drop {
		from {
			opacity: 0;
			transform: translateY(-12px);
		}
	}

	@keyframes toast-lift {
		to {
			opacity: 0;
			transform: translateY(-8px);
		}
	}
</style>
