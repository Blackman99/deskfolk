<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Copy } from './copy.ts';

	let { active, t, updateAvailable = false, onNavigate }: {
		active: 'sessions' | 'workspace' | 'settings';
		t: Copy;
		updateAvailable?: boolean;
		onNavigate: (destination: 'sessions' | 'workspace' | 'settings') => void;
	} = $props();
</script>

<nav class="mobile-navigation" aria-label={t.sidebar.mainNavigation}>
	<button type="button" class:is-active={active === 'sessions'} aria-current={active === 'sessions' ? 'page' : undefined} onclick={() => onNavigate('sessions')}>
		<Icon name="message" size={24} filled={active === 'sessions'} />
		<span>{t.sidebar.sessions}</span>
	</button>
	<button type="button" class:is-active={active === 'workspace'} aria-current={active === 'workspace' ? 'page' : undefined} onclick={() => onNavigate('workspace')}>
		<Icon name="folder" size={24} filled={active === 'workspace'} />
		<span>{t.sidebar.workspace}</span>
	</button>
	<button type="button" class:is-active={active === 'settings'} aria-current={active === 'settings' ? 'page' : undefined} onclick={() => onNavigate('settings')}>
		<span class="navigation-icon">
			<Icon name="settings" size={24} filled={active === 'settings'} />
			{#if updateAvailable}<span class="navigation-update" aria-label={t.sidebar.updateAvailable}></span>{/if}
		</span>
		<span>{t.settings.title}</span>
	</button>
</nav>

<style>
	.mobile-navigation { display: none; }
	@media (max-width: 680px) {
		.mobile-navigation {
			position: fixed;
			inset: auto 0 0;
			z-index: 105;
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			height: calc(60px + env(safe-area-inset-bottom));
			padding: 3px 12px calc(3px + env(safe-area-inset-bottom));
			border-top: 1px solid var(--line-subtle);
			/* Frosted, so the list scrolling under it stays faintly there instead of being cut off. */
			background: color-mix(in srgb, var(--pane) 82%, transparent);
			-webkit-backdrop-filter: blur(20px) saturate(1.6);
			backdrop-filter: blur(20px) saturate(1.6);
		}
		button {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 4px;
			min-width: 44px;
			min-height: 48px;
			padding: 3px 8px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--muted);
			font: 500 12px/1.2 var(--font);
			cursor: pointer;
		}
		button.is-active { color: var(--accent); font-weight: 650; }
		button { transition: color var(--dur-base) var(--ease-out), background-color var(--dur-base) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
		button:active { background: var(--row-hover); transform: scale(0.96); }
		button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
		.navigation-icon { position: relative; display: flex; }
		.navigation-update { position: absolute; top: -1px; right: -5px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
	}
</style>
