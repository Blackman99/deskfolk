<script lang="ts">
	import type { Copy } from '../copy.ts';

	interface Props {
		t: Copy;
		saving: boolean;
		onCancel: () => void;
		onDiscard: () => void;
		onSave: () => void | Promise<void>;
	}

	let { t, saving, onCancel, onDiscard, onSave }: Props = $props();
</script>

<div class="modal-backdrop confirm-backdrop" role="presentation">
	<div class="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-dirty-title">
		<div class="modal-body">
			<h3 id="artifact-dirty-title">{t.stream.artifactDirtyTitle}</h3>
			<p class="confirm-copy">{t.stream.artifactDirtyBody}</p>
		</div>
		<div class="modal-foot artifact-dirty-foot">
			<button type="button" disabled={saving} onclick={onCancel}>{t.sidebar.cancel}</button>
			<button type="button" disabled={saving} onclick={onDiscard}>{t.stream.artifactDiscard}</button>
			<button type="button" class="artifact-dirty-save" disabled={saving} onclick={() => void onSave()}>{t.stream.artifactSave}</button>
		</div>
	</div>
</div>

<style>
	.artifact-dirty-foot button:first-child {
		background: var(--btn-secondary-bg);
		color: var(--ink);
		border-color: var(--line);
		box-shadow: var(--shadow-xs);
	}

	.artifact-dirty-foot button:first-child:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.artifact-dirty-save {
		background: var(--accent) !important;
		color: var(--on-accent) !important;
		border-color: transparent !important;
	}
</style>
