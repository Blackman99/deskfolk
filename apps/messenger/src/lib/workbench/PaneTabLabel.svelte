<script lang="ts">
	import type { PaneKind } from './pane-content.ts';

	/**
	 * Every tab that is not a live conversation: its kind's picture before the name. The pictures
	 * are the ones the app opens these from — the tools menu's terminal, calendar and ledger, the
	 * workspace button's folder, the header's flow board. Marked `wb-tab-icon` like a
	 * conversation's avatar, so the strip shows them on the same terms.
	 */
	type Props = {
		/** Null for a tab this build cannot read, which keeps its bare name. */
		kind: PaneKind | null;
		title: string;
	};

	let { kind, title }: Props = $props();
</script>

<span class="pane-tab" {title}>
	{#if kind}
		<span class="wb-tab-icon pane-tab-icon" data-kind={kind} aria-hidden="true">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				{#if kind === 'terminal'}
					<polyline points="4 17 10 11 4 5"></polyline>
					<line x1="12" y1="19" x2="20" y2="19"></line>
				{:else if kind === 'workspace'}
					<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
				{:else if kind === 'routines'}
					<rect x="3" y="4" width="18" height="17" rx="2"></rect>
					<line x1="3" y1="9" x2="21" y2="9"></line>
					<line x1="8" y1="2" x2="8" y2="6"></line>
					<line x1="16" y1="2" x2="16" y2="6"></line>
				{:else if kind === 'spend'}
					<line x1="12" y1="1" x2="12" y2="23"></line>
					<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
				{:else if kind === 'trace'}
					<rect x="8" y="2" width="8" height="6" rx="1.5"></rect>
					<path d="M12 8v3"></path>
					<path d="M5.5 14v-3h13v3"></path>
					<rect x="2" y="14" width="7" height="6" rx="1.5"></rect>
					<rect x="15" y="14" width="7" height="6" rx="1.5"></rect>
				{:else if kind === 'preview'}
					<!-- What a conversation turned out: a parcel, apart from the workspace's folder. -->
					<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
					<path d="m3.3 7 8.7 5 8.7-5"></path>
					<path d="M12 22V12"></path>
					<path d="m7.5 4.27 9 5.15"></path>
				{:else}
					<!-- A conversation that is gone: the tab stays until it is closed. -->
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
				{/if}
			</svg>
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
		width: 14px;
		height: 14px;
	}

	.pane-tab-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
