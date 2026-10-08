<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The on/off switch of the panels' lists and editors (skills, memories, routines): a label
	 * around a checkbox, drawn as a track with a thumb. The checkbox is the caller's `children` —
	 * its `checked`, `disabled`, handlers and bindings stay where the data is.
	 */
	interface Props {
		/** Classes after `switch-toggle` on the label. */
		class?: string;
		/** Dims the switch (`is-disabled`); the checkbox's own `disabled` is the caller's. */
		disabled?: boolean;
		title?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	}

	let { class: className, disabled = false, title, onclick, children }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<label class={['switch-toggle', className]} class:is-disabled={disabled} {title} {onclick}>
	{@render children()}
	<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
</label>

<style>
	.switch-toggle { position: relative; display: inline-flex; align-items: center; margin: 0; cursor: pointer; }
	.switch-toggle :global(input) { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
	.switch-track { display: block; width: 44px; height: 24px; border-radius: var(--radius-full); background: var(--chip-line, var(--line)); position: relative; transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-toggle :global(input:checked + .switch-track) { background: var(--accent); }
	.switch-toggle :global(input:checked + .switch-track .switch-thumb) { transform: translateX(20px); }
	.switch-toggle :global(input:focus-visible + .switch-track) { outline: 2px solid var(--accent); outline-offset: 2px; }
	.switch-toggle.is-disabled { opacity: 0.55; cursor: default; }
</style>
