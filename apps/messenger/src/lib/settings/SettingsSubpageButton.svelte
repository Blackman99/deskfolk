<script lang="ts">
	import Icon from '../Icon.svelte';
	/**
	 * The two buttons of a settings subpage's head that only a phone shows: Back, and ✕ (which on a
	 * wide window is the editor's own dismiss button, so this one stays hidden there). What each
	 * does, and whether it is busy, is the caller's.
	 */
	interface Props {
		kind: 'back' | 'close';
		/** The `aria-label`; the hover text too, unless `title` says otherwise. */
		label?: string;
		/** The hover text, when it differs from `label`. Either one stands in for the other. */
		title?: string;
		disabled?: boolean;
		onclick: () => void;
	}

	let { kind, label, title, disabled, onclick }: Props = $props();
</script>

{#if kind === 'back'}
	<button type="button" class="settings-subpage-back" aria-label={label ?? title} title={title ?? label} {disabled} {onclick}>
		<Icon name="chevron-left" size={20} />
	</button>
{:else}
	<button type="button" class="modal-close settings-subpage-close" aria-label={label ?? title} title={title ?? label} {disabled} {onclick}>✕</button>
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
