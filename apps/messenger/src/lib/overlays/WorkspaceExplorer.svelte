<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { LocalApi } from '../api.ts';
	import ArtifactPreview from './ArtifactPreview.svelte';

	interface Props {
		api: LocalApi | null;
		workspacePath: string | null;
		selected: string;
		t: Copy;
		onClose: () => void;
		onSelect: (path: string) => void;
	}

	let { api, workspacePath, selected, t, onClose, onSelect }: Props = $props();

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
	onclick={(e) => {
		if (e.target === e.currentTarget) requestCloseFromParent();
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
