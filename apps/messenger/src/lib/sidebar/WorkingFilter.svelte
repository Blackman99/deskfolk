<script lang="ts">
	import type { Copy } from '../copy.ts';

	/** The list's "only what is working or unread" switch. Beside the mark, or beside the search on a phone. */
	type Props = {
		t: Copy;
		workingOnly: boolean;
		toggleWorkingOnly: () => void;
	};

	let { t, workingOnly, toggleWorkingOnly }: Props = $props();
</script>

<button
	type="button"
	class="working-filter"
	class:is-active={workingOnly}
	title={workingOnly ? t.sidebar.workingOnlyOff : t.sidebar.workingOnly}
	aria-label={t.sidebar.workingOnly}
	aria-pressed={workingOnly}
	onclick={toggleWorkingOnly}
>
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
	</svg>
</button>

<style>
	.working-filter {
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

	.working-filter:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.working-filter.is-active {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.working-filter:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	@media (max-width: 680px) {
		.working-filter {
			width: var(--tools-entry-size);
			height: var(--tools-entry-size);
			border-color: var(--line);
			border-radius: var(--radius-md);
			background: var(--pane);
			color: var(--ink-secondary);
		}

		.working-filter:active {
			background: var(--row-hover);
		}

		.working-filter.is-active {
			border-color: var(--accent-border);
			background: var(--accent-tint);
			color: var(--accent);
		}
	}
</style>
