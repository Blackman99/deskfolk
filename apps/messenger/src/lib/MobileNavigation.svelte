<script lang="ts">
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
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/></svg>
		<span>{t.sidebar.sessions}</span>
	</button>
	<button type="button" class:is-active={active === 'workspace'} aria-current={active === 'workspace' ? 'page' : undefined} onclick={() => onNavigate('workspace')}>
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8 12h8M8 16h5"/></svg>
		<span>{t.sidebar.workspace}</span>
	</button>
	<button type="button" class:is-active={active === 'settings'} aria-current={active === 'settings' ? 'page' : undefined} onclick={() => onNavigate('settings')}>
		<span class="navigation-icon">
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.6 3h4.8l.7 2.5 2.2 1.3 2.5-.6 2.4 4.1-1.8 1.8v2.6l1.8 1.8-2.4 4.1-2.5-.6-2.2 1.3-.7 2.5H9.6l-.7-2.5-2.2-1.3-2.5.6-2.4-4.1 1.8-1.8v-2.6L1.8 10l2.4-4.1 2.5.6 2.2-1.3Z" transform="translate(1 0) scale(.91)"/><circle cx="12" cy="12" r="3"/></svg>
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
			border-top: 1px solid var(--line);
			background: var(--pane);
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
		button.is-active svg { fill: var(--accent-tint); }
		button:active { background: var(--row-hover); }
		button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
		.navigation-icon { position: relative; display: flex; }
		.navigation-update { position: absolute; top: -1px; right: -5px; width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
	}
</style>
