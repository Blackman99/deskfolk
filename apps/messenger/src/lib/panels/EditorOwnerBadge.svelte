<script lang="ts">
	import Icon from '../Icon.svelte';
	/** Which Bot an editor sheet's item belongs to: the skill, memory and routine sheets all show it. */
	interface Props {
		name: string;
		/** The hover text. */
		title: string;
	}

	let { name, title }: Props = $props();
</script>

<span class="editor-owner-badge" {title}>
	<Icon name="user" size={12} />
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
