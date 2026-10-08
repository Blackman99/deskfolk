<script lang="ts">
	import type { Snippet } from 'svelte';

	/** The head of a General or Remote access card: an optional icon, the title over its subtitle, and what sits beside them. */
	interface Props {
		title: string;
		subtitle: string;
		/** Before the title: the caller's icon box. */
		icon?: Snippet;
		/** After the title, still in the left group. */
		after?: Snippet;
		/** The far end of the head. */
		end?: Snippet;
	}

	let { title, subtitle, icon, after, end }: Props = $props();
</script>

<div class="settings-card-header">
	<div class="settings-card-header-main">
		{@render icon?.()}
		<div>
			<h3 class="settings-card-title">{title}</h3>
			<p class="settings-card-subtitle">{subtitle}</p>
		</div>
		{@render after?.()}
	</div>
	{@render end?.()}
</div>

<style>
	.settings-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.settings-card-header-main {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}
</style>
