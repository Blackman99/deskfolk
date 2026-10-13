<script lang="ts">
	/**
	 * A text button in one of the app's few kinds: `primary` for the one thing a place asks you to
	 * do, `secondary` beside it, `ghost` for the quiet way out, `danger` to confirm a loss and
	 * `danger-soft` to offer one. Three heights: `sm` 28px inside cards, `md` 32px, `lg` 40px for
	 * first-run screens and phones.
	 *
	 * Which button is the primary one is said here, by `variant`, never by where it sits.
	 */
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons.ts';

	type Props = HTMLButtonAttributes & {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
		size?: 'sm' | 'md' | 'lg';
		/** An icon before the label. */
		icon?: IconName;
		/** An icon after the label (an arrow on "Next"). */
		trailingIcon?: IconName;
		children?: Snippet;
	};

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		trailingIcon,
		type = 'button',
		class: className = '',
		children,
		...rest
	}: Props = $props();

	const iconSize = $derived(size === 'lg' ? 16 : 14);
</script>

<button {type} class="ui-btn is-{variant} is-{size} {className}" {...rest}>
	{#if icon}<Icon name={icon} size={iconSize} />{/if}
	{@render children?.()}
	{#if trailingIcon}<Icon name={trailingIcon} size={iconSize} />{/if}
</button>

<style>
	.ui-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		flex: none;
		height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: 8px;
		font-size: var(--text-small);
		font-weight: 600;
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.ui-btn.is-sm {
		height: 28px;
		padding: 0 10px;
		border-radius: 7px;
		font-size: var(--text-caption);
	}

	.ui-btn.is-lg {
		height: 40px;
		padding: 0 16px;
		border-radius: var(--radius-md);
		font-size: var(--text-body);
	}

	.ui-btn:active:not(:disabled) {
		transform: scale(0.97);
		transition-duration: var(--dur-fast);
	}

	.ui-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.ui-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.is-primary {
		background: var(--accent);
		color: var(--on-accent);
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, #ffffff 14%, transparent),
			0 1px 2px color-mix(in srgb, var(--accent) 35%, transparent);
	}

	.is-primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.is-primary:active:not(:disabled) {
		background: var(--accent-active);
	}

	.is-secondary {
		background: var(--btn-secondary-bg);
		color: var(--ink);
		box-shadow: inset 0 0 0 1px var(--line), var(--shadow-xs);
	}

	.is-secondary:hover:not(:disabled) {
		background: var(--btn-secondary-hover);
		box-shadow: inset 0 0 0 1px var(--line-hover), var(--shadow-xs);
	}

	.is-secondary:focus-visible {
		box-shadow: inset 0 0 0 1px var(--accent), var(--focus-ring);
	}

	.is-ghost {
		background: transparent;
		color: var(--ink-secondary);
	}

	.is-ghost:hover:not(:disabled) {
		background: var(--row-hover);
		color: var(--ink);
	}

	.is-danger {
		background: var(--danger);
		color: var(--on-danger);
		box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 14%, transparent);
	}

	.is-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 86%, #000000);
	}

	.is-danger-soft {
		background: transparent;
		color: var(--danger-text);
	}

	.is-danger-soft:hover:not(:disabled) {
		background: var(--danger-bg);
	}
</style>
