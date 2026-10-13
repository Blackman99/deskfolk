<script lang="ts">
	/** Where `showToast` puts its confirmation: one pill, bottom centre, above the composer. */
	import Icon from './Icon.svelte';
	import { toasts } from './toast.svelte.ts';

	const toast = $derived(toasts.current);
</script>

{#if toast}
	{#key toast.id}
		<div
			class="toast-host"
			class:is-leaving={toast.leaving}
			class:is-error={toast.tone === 'error'}
			role="status"
			aria-live="polite"
			onpointerenter={() => toasts.hold()}
			onpointerleave={() => toasts.release()}
		>
			<Icon name={toast.tone === 'error' ? 'alert-circle' : 'check'} size={14} class="toast-icon" />
			<span class="toast-text">{toast.text}</span>
			{#if toast.action}
				<button
					type="button"
					class="toast-act"
					onclick={() => {
						toast.action?.run();
						toasts.dismiss();
					}}>{toast.action.label}</button
				>
			{/if}
		</div>
	{/key}
{/if}

<style>
	.toast-host {
		position: fixed;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
		z-index: 1200;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: min(92vw, 480px);
		min-height: 36px;
		padding: 6px 14px;
		border-radius: var(--radius-full);
		background: var(--ink);
		color: var(--pane);
		font-size: var(--text-small);
		font-weight: 600;
		box-shadow: var(--shadow-lg);
		transform: translateX(-50%);
		animation: toast-in var(--dur-slow) var(--ease-out) both;
	}

	.toast-host:has(.toast-act) {
		padding-right: 6px;
	}

	.toast-host.is-leaving {
		animation: toast-out var(--dur-base) ease-in both;
	}

	.toast-host :global(.toast-icon) {
		opacity: 0.85;
	}

	.toast-host.is-error :global(.toast-icon) {
		color: var(--danger-line);
	}

	.toast-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.toast-act {
		flex: none;
		height: 26px;
		padding: 0 10px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--pane) 18%, transparent);
		color: inherit;
		font-size: var(--text-caption);
		font-weight: 650;
	}

	.toast-act:hover {
		background: color-mix(in srgb, var(--pane) 28%, transparent);
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translate(-50%, 12px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}

	@keyframes toast-out {
		from {
			opacity: 1;
			transform: translate(-50%, 0);
		}
		to {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
	}
</style>
