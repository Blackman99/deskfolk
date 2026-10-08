<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A card of the General, Remote access and About tabs. Its contents are the caller's `children`,
	 * so their classes stay with the caller's own style.
	 */
	interface Props {
		/** Classes after `settings-card`. */
		class?: string;
		children: Snippet;
	}

	let { class: className, children }: Props = $props();
</script>

<div class={['settings-card', className]}>
	{@render children()}
</div>

<style>
	.settings-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		box-shadow: var(--shadow-xs);
	}

	@media (max-width: 720px) {
		.settings-card {
			border-radius: var(--radius-lg);
			padding: 15px;
			box-shadow: none;
		}
	}
</style>
