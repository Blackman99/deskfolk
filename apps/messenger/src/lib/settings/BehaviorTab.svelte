<script lang="ts">
	import type { Copy } from '../copy.ts';
	import OpenPlacementCard from './OpenPlacementCard.svelte';

	/**
	 * Settings › Behavior: how the app itself behaves on this machine, apart from what it talks to.
	 * For now, where each kind of window opens on the desktop workbench — so the tab is there only
	 * while the workbench is.
	 */
	type Props = { t: Copy };

	let { t }: Props = $props();
</script>

<div class="settings-tab-pane">
	<OpenPlacementCard {t} />
</div>

<style>
	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
</style>
