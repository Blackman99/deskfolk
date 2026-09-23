<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import ArtifactPreview from './ArtifactPreview.svelte';

	/**
	 * The workspace itself, with no chrome around it: it fills whatever it is put in. Two hosts
	 * use it — a pane on the desktop, a slide-over page on a narrow window — and neither may add
	 * a prop that changes what this draws, or the two will quietly stop agreeing.
	 */
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

	let pane = $state<{
		requestCloseFromParent: (afterClose?: () => void) => void;
		closeFind: () => boolean;
		blocksClose: () => boolean;
	} | null>(null);

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

<style>
	.workspace-unset {
		margin: auto;
		padding: 24px;
		text-align: center;
	}
	.workspace-unset h2 {
		font-size: 18px;
	}
	.workspace-unset p {
		color: var(--muted);
	}
	.workspace-unset button {
		min-height: 44px;
		margin: 8px;
		padding: 8px 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--accent);
		cursor: pointer;
	}
</style>
