<script lang="ts">
	/**
	 * The two buttons of a settings subpage's head that only a phone shows: Back, and ✕ (which on a
	 * wide window is the editor's own dismiss button, so this one stays hidden there). What each
	 * does, and whether it is busy, is the caller's.
	 */
	interface Props {
		kind: 'back' | 'close';
		/** The `aria-label`. */
		label?: string;
		/** The hover text. */
		title?: string;
		disabled?: boolean;
		onclick: () => void;
	}

	let { kind, label, title, disabled, onclick }: Props = $props();
</script>

{#if kind === 'back'}
	<button type="button" class="settings-subpage-back" aria-label={label} {disabled} {onclick}>
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
	</button>
{:else}
	<button type="button" class="modal-close settings-subpage-close" aria-label={label} {title} {disabled} {onclick}>✕</button>
{/if}

<style>
	.settings-subpage-back,
	.settings-subpage-close {
		display: none;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	@media (max-width: 720px) {
		.settings-subpage-back,
		.settings-subpage-close {
			display: inline-flex;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}

		.settings-subpage-close {
			font-size: 16px;
			color: var(--muted);
		}

		.settings-subpage-back:active,
		.settings-subpage-close:active {
			background: var(--row-hover);
		}
	}
</style>
