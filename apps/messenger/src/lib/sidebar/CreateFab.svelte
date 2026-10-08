<script lang="ts">
	import type { Copy } from '../copy.ts';

	/**
	 * Creating on a phone: one button that floats over the list rather than a + in each group header.
	 * The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	 * there are two of them saying the same kind of thing; this asks which once, where your thumb is.
	 */
	type Props = {
		t: Copy;
		/** What the + opens. A menu, so Back and Escape close it first. */
		createMenuOpen?: boolean;
		/** The wrapper, for the sidebar's outside-click check. */
		wrapEl?: HTMLElement | null;
		/** How far above its usual place it stands: the height of the usage strip above the bottom bar. */
		lift?: number;
		onCreateBot: () => void;
		onCreateGroup: () => void;
	};

	let { t, createMenuOpen = $bindable(false), wrapEl = $bindable(null), lift = 0, onCreateBot, onCreateGroup }: Props = $props();
</script>

<div class="fab-wrap" bind:this={wrapEl} style:--fab-lift="{lift}px">
	{#if createMenuOpen}
		<div class="fab-menu" role="menu">
			<button
				type="button"
				class="fab-menu-item"
				role="menuitem"
				onclick={() => {
					createMenuOpen = false;
					onCreateBot();
				}}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="4" y="8" width="16" height="12" rx="3"></rect>
					<path d="M12 8V4"></path>
					<circle cx="9" cy="14" r="1"></circle>
					<circle cx="15" cy="14" r="1"></circle>
				</svg>
				<span>{t.sidebar.addBot}</span>
			</button>
			<button
				type="button"
				class="fab-menu-item"
				role="menuitem"
				onclick={() => {
					createMenuOpen = false;
					onCreateGroup();
				}}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
					<circle cx="9" cy="7" r="4"></circle>
					<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
				</svg>
				<span>{t.sidebar.addGroup}</span>
			</button>
		</div>
	{/if}
	<button
		type="button"
		class="fab"
		class:is-open={createMenuOpen}
		aria-haspopup="menu"
		aria-expanded={createMenuOpen}
		aria-label={t.sidebar.createMenu}
		onclick={() => (createMenuOpen = !createMenuOpen)}
	>
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
			<path d="M12 5v14M5 12h14"></path>
		</svg>
	</button>
</div>


<style>
	/*
	 * Above the list, under everything that covers the list: a drawer, a sheet or the settings
	 * page all sit higher, so the button cannot poke through them.
	 */
	.fab-wrap {
		position: fixed;
		right: 16px;
		bottom: calc(60px + env(safe-area-inset-bottom) + 16px + var(--fab-lift, 0px));
		z-index: 12;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
	}

	.fab {
		width: 52px;
		height: 52px;
		border: 0;
		border-radius: 50%;
		background: var(--accent);
		color: var(--on-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--shadow-lg);
		cursor: pointer;
		transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/* The + turns into the × that closes what it opened. */
	.fab.is-open {
		transform: rotate(45deg);
	}

	.fab:active {
		transform: scale(0.94);
		background: var(--accent-hover);
	}

	.fab.is-open:active {
		transform: rotate(45deg) scale(0.94);
		background: var(--accent-hover);
	}

	/* The focus ring is the app's, and on a circle it has to follow the circle. */
	.fab:focus-visible {
		box-shadow: var(--shadow-lg), 0 0 0 3px var(--accent-glow);
	}

	.fab-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px;
		min-width: 152px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		animation: sidebarMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
		transform-origin: bottom right;
	}

	.fab-menu-item {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 42px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font-size: 14px;
		text-align: left;
		cursor: pointer;
	}

	.fab-menu-item:active {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.fab-menu-item svg {
		flex-shrink: 0;
		color: var(--muted);
	}

	@keyframes sidebarMenuIn {
		from {
		opacity: 0;
		transform: scale(0.96) translateY(4px);
		}
		to {
		opacity: 1;
		transform: scale(1) translateY(0);
		}
	}
</style>
