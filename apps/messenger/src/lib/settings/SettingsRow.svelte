<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One setting on a line, as the General tab and the remote session settings draw it: its name
	 * and what it does on the left, its control on the right. Below 540px the control goes under
	 * the text.
	 */
	interface Props {
		title: string;
		/** The title's id, for the control's `aria-labelledby`. */
		titleId?: string;
		desc: string;
		/** On the title's line, after it: a short mark that must not make the row taller. */
		titleAfter?: Snippet;
		/** More under the description, in the caller's own markup. */
		notes?: Snippet;
		/** The control. */
		children: Snippet;
	}

	let { title, titleId, desc, titleAfter, notes, children }: Props = $props();
</script>

<div class="settings-row">
	<div class="settings-row-info">
		{#if titleAfter}
			<span class="settings-row-title-line">
				<span class="settings-row-title" id={titleId}>{title}</span>{@render titleAfter()}
			</span>
		{:else}
			<span class="settings-row-title" id={titleId}>{title}</span>
		{/if}
		<span class="settings-row-desc">{desc}</span>{@render notes?.()}
	</div>
	<div class="settings-row-action">
		{@render children()}
	</div>
</div>

<style>
	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 2px;
		border-bottom: 1px solid var(--line-subtle);
		transition: background 0.15s ease;
	}

	.settings-row:last-child {
		border-bottom: none;
		padding-bottom: 2px;
	}

	.settings-row-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.settings-row-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		line-height: 1.3;
	}

	/* The title's own height: what follows it on the line is never taller than the text. */
	.settings-row-title-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.settings-row-desc {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-row-action {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	@media (max-width: 540px) {
		.settings-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 8px;
		}
	}

	@media (max-width: 540px) {
		.settings-row-action {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
