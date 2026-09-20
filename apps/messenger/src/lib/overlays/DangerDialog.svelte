<script lang="ts">
	import { untrack } from 'svelte';
	import type { Copy } from '../copy.ts';

	type Props = {
		copy: { title: string; body: string; confirm: string; cancel: string };
		t: Copy;
		onDismiss: () => void;
		onConfirm: () => void;
		busy?: boolean;
	};

	let { copy, t, onDismiss, onConfirm, busy = false }: Props = $props();
	let dialogEl = $state<HTMLDialogElement>();
	const dismiss = () => { if (!busy) onDismiss(); };

	$effect(() => {
		const dialog = dialogEl;
		if (!dialog) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// showModal isolates the entire background, even when mounted inside another overlay.
		dialog.showModal();
		dialog.focus();
		return () => {
			dialog.close();
			if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
		};
	});

	$effect(() => {
		if (busy) untrack(() => dialogEl?.focus());
	});

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			dismiss();
		} else if (event.key === 'Tab' && dialogEl) {
			const buttons = [...dialogEl.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			event.preventDefault();
			event.stopPropagation();
			const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
			(buttons[next] ?? dialogEl).focus();
		}
	}
</script>

<dialog
	bind:this={dialogEl}
	class="modal-backdrop confirm-backdrop"
	aria-labelledby="danger-confirm-title"
	aria-describedby="danger-confirm-body"
	aria-busy={busy}
	tabindex="-1"
	oncancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
	onclick={(event) => {
		event.stopPropagation();
		if (event.target === event.currentTarget) dismiss();
	}}
	onpointerdown={(event) => event.stopPropagation()}
	onkeydown={onKey}
>
	<div class="modal-dialog confirm-dialog">
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
</dialog>

<style>
	dialog.confirm-backdrop { margin: 0; border: 0; outline: none; width: 100vw; max-width: none; height: 100dvh; max-height: none; box-sizing: border-box; }
	dialog.confirm-backdrop::backdrop { background: transparent; }
	.confirm-dialog button { min-width: 44px; min-height: 44px; }
	.confirm-dialog .modal-close { width: 44px; height: 44px; }
</style>
