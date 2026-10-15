<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The app's one on/off switch, in the panels' lists and editors (skills, memories, routines)
	 * and in Settings: a track with a thumb around a checkbox. The checkbox is the caller's
	 * `children` — its `checked`, `disabled`, handlers and bindings stay where the data is.
	 */
	interface Props {
		/** `span` when the whole row is the `<label>`, so there is one label per checkbox. */
		tag?: 'label' | 'span';
		/** Classes after `switch-toggle`. */
		class?: string;
		/** Dims the switch (`is-disabled`); the checkbox's own `disabled` is the caller's. */
		disabled?: boolean;
		title?: string;
		for?: string;
		labelledby?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	}

	let { tag = 'label', class: className, disabled = false, title, for: htmlFor, labelledby, onclick, children }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
	this={tag}
	class={['switch-toggle', className]}
	class:is-disabled={disabled}
	for={tag === 'label' ? htmlFor : undefined}
	aria-labelledby={labelledby}
	{title}
	{onclick}
>
	{@render children()}
	<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
</svelte:element>

<style>
	.switch-toggle {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin: 0;
		cursor: pointer;
	}

	.switch-toggle :global(input) {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		margin: 0;
		pointer-events: none;
	}

	/* One size: 40 by 22, the track sunk a little, the thumb a lit disc that slides. */
	.switch-track {
		display: block;
		position: relative;
		width: 40px;
		height: 22px;
		border-radius: var(--radius-full);
		background: var(--chip-line, var(--line));
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
		transition: background-color var(--dur-base) var(--ease-out);
	}

	.switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--switch-thumb);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
		transition: transform var(--dur-base) var(--ease-out);
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
		cursor: default;
	}
</style>
