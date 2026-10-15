<script lang="ts">
	/**
	 * A button that is only an icon. `label` is required: it is what a reader announces and what
	 * the pointer's tooltip says, since there are no words on the button itself. Four sizes, 24 /
	 * 28 / 32 / 40px; on a touch screen none is smaller than 40.
	 */
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons.ts';

	type Props = Omit<HTMLButtonAttributes, 'children'> & {
		icon: IconName;
		label: string;
		size?: 'xs' | 'sm' | 'md' | 'lg';
		/** A toggle that is on (pinned, open): drawn in the accent tint and announced as pressed. */
		pressed?: boolean;
	};

	let {
		icon,
		label,
		size = 'md',
		pressed,
		type = 'button',
		class: className = '',
		...rest
	}: Props = $props();

	const iconSize = $derived(size === 'lg' ? 20 : 16);
</script>

<button
	{type}
	class="ui-icon-btn is-{size} {className}"
	class:is-on={pressed === true}
	aria-label={label}
	aria-pressed={pressed}
	title={label}
	{...rest}
>
	<Icon name={icon} size={iconSize} />
</button>

<style>
	.ui-icon-btn {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.ui-icon-btn.is-xs {
		width: 24px;
		height: 24px;
		border-radius: 6px;
	}

	.ui-icon-btn.is-sm {
		width: 28px;
		height: 28px;
		border-radius: 7px;
	}

	.ui-icon-btn.is-lg {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-md);
	}

	.ui-icon-btn:hover:not(:disabled) {
		background: var(--row-hover);
		color: var(--ink);
	}

	.ui-icon-btn:active:not(:disabled) {
		transform: scale(0.92);
		transition-duration: var(--dur-fast);
	}

	.ui-icon-btn:focus-visible {
		outline: none;
		color: var(--ink);
		box-shadow: var(--focus-ring);
	}

	.ui-icon-btn.is-on {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.ui-icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@media (pointer: coarse) {
		.ui-icon-btn {
			min-width: 40px;
			min-height: 40px;
		}
	}
</style>
