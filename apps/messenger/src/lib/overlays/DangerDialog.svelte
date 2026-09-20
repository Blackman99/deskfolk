<script lang="ts">
	import type { Copy } from '../copy.ts';

	type Props = {
		copy: { title: string; body: string; confirm: string; cancel: string };
		t: Copy;
		onDismiss: () => void;
		onConfirm: () => void;
		busy?: boolean;
	};

	let { copy, t, onDismiss, onConfirm, busy = false }: Props = $props();
	const dismiss = () => { if (!busy) onDismiss(); };
	let backdropEl = $state<HTMLElement | null>(null);

	$effect(() => {
		backdropEl?.focus();
		function onKey(e: KeyboardEvent) {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopImmediatePropagation();
			dismiss();
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={backdropEl}
	class="modal-backdrop confirm-backdrop"
	role="dialog"
	aria-modal="true"
	aria-labelledby="danger-confirm-title"
	aria-describedby="danger-confirm-body"
	tabindex="-1"
	onclick={(e) => {
		e.stopPropagation();
		if (e.target === e.currentTarget) dismiss();
	}}
	onpointerdown={(e) => e.stopPropagation()}
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			dismiss();
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
			<button type="button" class="modal-close" title={t.common.close} disabled={busy} onclick={dismiss}>✕</button>
		</div>
		<div class="modal-body">
			<p id="danger-confirm-body" class="confirm-copy">{copy.body}</p>
		</div>
		<div class="modal-foot actions">
			<button type="button" disabled={busy} onclick={dismiss}>{copy.cancel}</button>
			<button type="button" class="deny" disabled={busy} onclick={() => { if (!busy) onConfirm(); }}>{copy.confirm}</button>
		</div>
	</div>
</div>
