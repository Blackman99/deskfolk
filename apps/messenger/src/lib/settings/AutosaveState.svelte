<script lang="ts">
	import type { Copy } from '../copy.ts';

	/**
	 * What a settings page that saves as you type says about it: saving, failed, saved, or the hint
	 * before the first change. The page's own state, passed in.
	 */
	interface Props {
		t: Copy;
		saving: boolean;
		failed: boolean;
		/** At least one save has landed since the page opened. */
		saved: boolean;
	}

	let { t, saving, failed, saved }: Props = $props();
</script>

<span class="settings-save-state text-12 text-muted whitespace-nowrap" class:is-error={failed} aria-live="polite">
	{#if saving}
		{t.sidebar.autoSaving}
	{:else if failed}
		{t.settings.saveFailed}
	{:else if saved}
		{t.sidebar.autoSaved}
	{:else}
		{t.sidebar.autoSaveHint}
	{/if}
</span>

<style>
	.settings-save-state {
		font-weight: 500;
	}

	.settings-save-state.is-error {
		color: var(--danger);
	}
</style>
