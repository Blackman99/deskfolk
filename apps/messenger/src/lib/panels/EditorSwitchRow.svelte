<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The enabled row of the skill, memory and routine editors: what the switch does on the left, the
	 * switch (the caller's `children`) on the right. A caller that wants a taller row sets
	 * `min-height` on `.editor-switch-row` from its own style.
	 */
	interface Props {
		title: string;
		desc: string;
		children: Snippet;
	}

	let { title, desc, children }: Props = $props();
</script>

<div class="editor-switch-row">
	<div class="editor-switch-copy">
		<span class="editor-switch-title">{title}</span>
		<span class="editor-switch-desc">
			{desc}
		</span>
	</div>
	{@render children()}
</div>

<style>
	.editor-switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
	}

	.editor-switch-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.editor-switch-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.editor-switch-desc {
		font-size: 12px;
		color: var(--muted);
	}
</style>
