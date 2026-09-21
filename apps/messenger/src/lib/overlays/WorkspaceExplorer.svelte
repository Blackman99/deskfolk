<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { backdropClick } from '../click-outside.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import ArtifactPreview from './ArtifactPreview.svelte';

	interface Props {
		api: MessengerApi | null;
		workspacePath: string | null;
		selected: string;
		t: Copy;
		onClose: () => void;
		onSelect: (path: string) => void;
	}

	let { api, workspacePath, selected, t, onClose, onSelect }: Props = $props();
	/** A click outside closes the explorer; a text-selection drag that starts inside never does. */
	const workspaceBackdrop = backdropClick();

	let pane = $state<{ requestCloseFromParent: () => void; closeFind: () => boolean } | null>(null);

	export function requestCloseFromParent(): void {
		if (pane?.closeFind()) return;
		if (pane) pane.requestCloseFromParent();
		else onClose();
	}

	export function closeFind(): boolean {
		return pane?.closeFind() ?? false;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="workspace-overlay"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	aria-label={t.stream.workspaceExplorer}
	onmousedowncapture={workspaceBackdrop.press}
	onclick={(e) => {
		if (workspaceBackdrop.isOutside(e)) requestCloseFromParent();
	}}
>
	<div class="workspace-overlay-pane">
		<ArtifactPreview
			bind:this={pane}
			attachment={null}
			relpath={selected}
			siblings={[]}
			{api}
			{workspacePath}
			mode="workspace"
			{t}
			{onClose}
			onSelect={() => {}}
			onSelectWorkspacePath={onSelect}
		/>
	</div>
</div>

<style>
	.workspace-overlay {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		justify-content: flex-end;
		background: var(--modal-backdrop);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.workspace-overlay-pane {
		width: min(1400px, calc(100vw - 72px));
		height: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--pane);
		border-left: 1px solid var(--line);
		box-shadow: -16px 0 36px -6px rgba(15, 23, 42, 0.18);
		animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.workspace-overlay-pane :global(.artifact-pane) {
		flex: 1;
		min-height: 0;
		height: 100%;
	}

	@media (max-width: 680px) {
	.workspace-overlay {
	display: flex;
	}
	}

	@media (max-width: 680px) {
	.workspace-overlay-pane {
	width: 100%;
	}
	}

	@media (max-width: 680px) {
	.workspace-overlay :global(.artifact-pane) {
	display: flex;
	}
	}
</style>
