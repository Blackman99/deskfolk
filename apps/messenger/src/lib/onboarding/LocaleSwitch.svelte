<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	/**
	 * The wizard's language. A new install starts in the system's (the daemon reads it when it makes
	 * the database); this is the way out when that is not the one you read, before Settings is in
	 * reach. It writes the same setting as Settings › General, so the whole app follows.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		locale: 'zh' | 'en';
	}

	let { runtime, t, locale }: Props = $props();
	let busy = $state(false);

	async function pick(next: 'zh' | 'en'): Promise<void> {
		if (next === locale || busy) return;
		busy = true;
		try {
			await runtime.patchSettings({ locale: next });
		} finally {
			busy = false;
		}
	}
</script>

<div class="locale-switch" role="group" aria-label={t.settings.language} data-onboarding-locale>
	{#each [['zh', t.settings.localeZh], ['en', t.settings.localeEn]] as const as [value, label] (value)}
		<button
			type="button"
			class="locale-btn"
			class:is-active={locale === value}
			aria-pressed={locale === value}
			data-locale={value}
			disabled={busy}
			onclick={() => void pick(value)}
		>{label}</button>
	{/each}
</div>

<style>
	/* The look of Settings › General's language row, smaller, in the card's corner. */
	.locale-switch {
		position: absolute;
		top: 14px;
		right: 14px;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
	}

	.locale-btn {
		padding: 3px 9px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.locale-btn:hover:not(.is-active) {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.locale-btn.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	@media (max-width: 680px) {
		.locale-switch {
			top: calc(10px + env(safe-area-inset-top));
			right: 12px;
		}
	}
</style>
