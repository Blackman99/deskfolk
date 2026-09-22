<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { backdropClick } from '../click-outside.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import ArtifactPreview from './ArtifactPreview.svelte';
	import { pageSlide } from '../mobile-page-slide.ts';

	interface Props {
		api: MessengerApi | null;
		workspacePath: string | null;
		selected: string;
		t: Copy;
		onClose: () => void;
		onSelect: (path: string) => void;
		onOpenSettings?: () => void;
	}

	let { api, workspacePath, selected, t, onClose, onSelect, onOpenSettings }: Props = $props();
	/** A click outside closes the explorer; a text-selection drag that starts inside never does. */
	const workspaceBackdrop = backdropClick();

	let pane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null>(null);

	export function requestCloseFromParent(afterClose?: () => void): void {
		if (!afterClose && pane?.closeFind()) return;
		if (pane) pane.requestCloseFromParent(afterClose);
		else {
			onClose();
			afterClose?.();
		}
	}

	export function closeFind(): boolean {
		return pane?.closeFind() ?? false;
	}

	export function blocksClose(): boolean {
		return pane?.blocksClose() ?? false;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="workspace-overlay"
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	aria-label={t.stream.workspaceExplorer}
	in:pageSlide={{ instant: true }}
	out:pageSlide={{ instant: true }}
	onmousedowncapture={workspaceBackdrop.press}
	onclick={(e) => {
		if (workspaceBackdrop.isOutside(e)) requestCloseFromParent();
	}}
>
	<div class="workspace-overlay-pane">
		{#if !workspacePath}
			<section class="workspace-unset">
				<h2>{t.sidebar.workspace}</h2>
				<p>{t.sidebar.workspaceUnset}</p>
				<button type="button" onclick={onOpenSettings}>{t.settings.title}</button>
				<button type="button" onclick={onClose}>{t.common.close}</button>
			</section>
		{:else}
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
		{/if}
	</div>
</div>

<style>
	.workspace-unset { margin: auto; padding: 24px; text-align: center; }
	.workspace-unset h2 { font-size: 18px; }
	.workspace-unset p { color: var(--muted); }
	.workspace-unset button { min-height: 44px; margin: 8px; padding: 8px 16px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--pane); color: var(--accent); cursor: pointer; }

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
	/* The page itself covers the screen here, so nothing dims behind it — and while it slides,
	   what shows beside it is the page it is sliding over, not a backdrop. */
	background: transparent;
	backdrop-filter: none;
	-webkit-backdrop-filter: none;
	animation: none;
	}
	}

	@media (max-width: 680px) {
	.workspace-overlay-pane {
	width: 100%;
	animation: none;
	border-left: 0;
	box-shadow: none;
	}
	}

	@media (max-width: 680px) {
	.workspace-overlay :global(.artifact-pane) {
	display: flex;
	}
	}
	@media (max-width: 680px) {
		.workspace-overlay { bottom: calc(60px + env(safe-area-inset-bottom)); }
	}
</style>
