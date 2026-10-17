<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import { focusMode } from '../chat/focus-mode.svelte.ts';

	/**
	 * Focus mode's switch (see chat/focus-mode.svelte.ts), beside the working filter: next to the
	 * mark, or next to the search on a phone. Settings › General has the same switch.
	 */
	type Props = { t: Copy };

	let { t }: Props = $props();
</script>

<button
	type="button"
	class="focus-toggle"
	class:is-active={focusMode.on}
	title={focusMode.on ? t.sidebar.focusModeOff : t.sidebar.focusMode}
	aria-label={t.settings.focusMode}
	aria-pressed={focusMode.on}
	onclick={() => focusMode.toggle()}
>
	<Icon name="target" />
</button>

<style>
	.focus-toggle {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
	}

	.focus-toggle:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.focus-toggle.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.focus-toggle:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	@media (max-width: 680px) {
		.focus-toggle {
			width: var(--tools-entry-size);
			height: var(--tools-entry-size);
			border-color: var(--line);
			border-radius: var(--radius-md);
			background: var(--pane);
			color: var(--ink-secondary);
		}

		.focus-toggle:active {
			background: var(--row-hover);
		}

		.focus-toggle.is-active {
			border-color: var(--accent-border);
			background: var(--accent-tint);
			color: var(--accent);
		}
	}
</style>
