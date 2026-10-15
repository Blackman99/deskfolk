<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { IconName } from '../icons.ts';
	import type { PaneKind } from './pane-content.ts';

	/**
	 * Every tab that is not a live conversation: its kind's picture before the name. The pictures
	 * are the ones the app opens these from — the tools menu's terminal, calendar, ledger and usage, the
	 * workspace button's folder, the header's flow board. Marked `wb-tab-icon` like a conversation's
	 * avatar, so the strip shows them on the same terms.
	 */
	type Props = {
		/** Null for a tab this build cannot read, which keeps its bare name. */
		kind: PaneKind | null;
		title: string;
	};

	/**
	 * A kind's picture. A preview is a parcel, apart from the workspace's folder. A conversation that is
	 * gone has none of these and gets a speech bubble: the tab stays until it is closed.
	 */
	const ICON_NAMES: Partial<Record<PaneKind, IconName>> = {
		terminal: 'terminal',
		workspace: 'folder',
		routines: 'calendar',
		spend: 'dollar',
		usage: 'gauge',
		roles: 'nodes',
		trace: 'hierarchy',
		preview: 'package'
	};

	let { kind, title }: Props = $props();
</script>

<span class="pane-tab" {title}>
	{#if kind}
		<span class="wb-tab-icon pane-tab-icon" data-kind={kind} aria-hidden="true">
			<Icon name={ICON_NAMES[kind] ?? 'message'} size={16} />
		</span>
	{/if}
	<span class="pane-tab-name">{title}</span>
</span>

<style>
	.pane-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
	}

	.pane-tab-icon {
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
	}

	.pane-tab-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
