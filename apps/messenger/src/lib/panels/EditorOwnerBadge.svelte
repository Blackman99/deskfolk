<script lang="ts">
	/** Which Bot an editor sheet's item belongs to: the skill, memory and routine sheets all show it. */
	interface Props {
		name: string;
		/** The hover text. */
		title: string;
	}

	let { name, title }: Props = $props();
</script>

<span class="editor-owner-badge" {title}>
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
		<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
		<circle cx="12" cy="7" r="4"></circle>
	</svg>
	<span>{name}</span>
</span>

<style>
	.editor-owner-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		padding: 2px 8px;
		border-radius: var(--radius-full);
	}
</style>
