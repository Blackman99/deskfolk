<script lang="ts">
	import type { Copy } from '../copy.ts';

	type Props = {
		copy: { title: string; body: string; confirm: string; cancel: string };
		t: Copy;
		onDismiss: () => void;
		onConfirm: () => void;
	};

	let { copy, t, onDismiss, onConfirm }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="modal-backdrop confirm-backdrop"
	role="dialog"
	aria-modal="true"
	aria-labelledby="danger-confirm-title"
	aria-describedby="danger-confirm-body"
	tabindex="-1"
	onclick={(e) => {
		e.stopPropagation();
		if (e.target === e.currentTarget) onDismiss();
	}}
	onpointerdown={(e) => e.stopPropagation()}
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onDismiss();
		}
	}}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal-dialog confirm-dialog"
		onclick={(e) => e.stopPropagation()}
		onpointerdown={(e) => e.stopPropagation()}
	>
		<div class="modal-head">
			<h2 id="danger-confirm-title">{copy.title}</h2>
			<button type="button" class="modal-close" title={t.common.close} onclick={onDismiss}>✕</button>
		</div>
		<div class="modal-body">
			<p id="danger-confirm-body" class="confirm-copy">{copy.body}</p>
		</div>
		<div class="modal-foot actions">
			<button type="button" onclick={onDismiss}>{copy.cancel}</button>
			<button type="button" class="deny" onclick={onConfirm}>{copy.confirm}</button>
		</div>
	</div>
</div>
