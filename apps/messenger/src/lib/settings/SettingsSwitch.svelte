<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The settings dialog's on/off switch: a track with a thumb, a size down from the panels'
	 * `Switch`. The checkbox is the caller's `children` — its `checked`, `disabled` and handlers
	 * stay with the setting it changes.
	 */
	interface Props {
		/** `span` when the whole row is the `<label>`, so there is one label per checkbox. */
		tag?: 'label' | 'span';
		/** Classes after `switch-toggle`. */
		class?: string;
		/** Dims the switch (`is-disabled`); the checkbox's own `disabled` is the caller's. */
		disabled?: boolean;
		for?: string;
		labelledby?: string;
		children: Snippet;
	}

	let { tag = 'label', class: className, disabled = false, for: htmlFor, labelledby, children }: Props = $props();
</script>

<svelte:element
	this={tag}
	class={['switch-toggle', className]}
	class:is-disabled={disabled}
	for={htmlFor}
	aria-labelledby={labelledby}
>
	{@render children()}
	<span class="switch-track" aria-hidden="true">
		<span class="switch-thumb"></span>
	</span>
</svelte:element>

<style>
	.switch-toggle :global(input) {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		margin: 0;
		pointer-events: none;
	}

	.switch-track {
		display: block;
		width: 40px;
		height: 22px;
		border-radius: var(--radius-full);
		background: var(--chip-line);
		transition: background-color 0.2s ease, box-shadow 0.2s ease;
		position: relative;
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.switch-toggle :global(input:checked + .switch-track) {
		background: var(--accent);
	}

	.switch-toggle :global(input:checked + .switch-track .switch-thumb) {
		transform: translateX(18px);
	}

	.switch-toggle :global(input:focus-visible + .switch-track) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.switch-toggle.is-disabled {
		opacity: 0.55;
	}
</style>
