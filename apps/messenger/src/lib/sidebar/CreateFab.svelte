<script lang="ts">
	import Icon from '../Icon.svelte';
	import BottomSheet from '../BottomSheet.svelte';
	import type { Copy } from '../copy.ts';

	/**
	 * Creating on a phone: one button that floats over the list rather than a + in each group header.
	 * The headers' buttons are 22px targets at the top of a screen you hold from the bottom, and
	 * there are two of them saying the same kind of thing; this asks which once, where your thumb is,
	 * in a sheet from the bottom.
	 */
	type Props = {
		t: Copy;
		/** What the + opens. A menu, so Back and Escape close it first. */
		createMenuOpen?: boolean;
		/** The wrapper, for the sidebar's outside-click check. */
		wrapEl?: HTMLElement | null;
		/** A Bot and a group; left out (a phone's projects page), the menu has neither. */
		onCreateBot?: () => void;
		onCreateGroup?: () => void;
		/** A project session (ADR 0095): a new one in a folder, or a terminal session carried on; left out, the menu has neither. */
		onNewProject?: () => void;
		onImportProject?: () => void;
	};

	let { t, createMenuOpen = $bindable(false), wrapEl = $bindable(null), onCreateBot, onCreateGroup, onNewProject, onImportProject }: Props = $props();
</script>

<div class="fab-wrap" bind:this={wrapEl}>
	{#if createMenuOpen}
		<BottomSheet title={t.sidebar.createMenu} closeLabel={t.common.close} onClose={() => (createMenuOpen = false)}>
			<div class="fab-menu" role="menu" aria-label={t.sidebar.createMenu}>
				{#if onCreateBot}
				<button
					type="button"
					class="fab-menu-item sheet-item"
					role="menuitem"
					onclick={() => {
						createMenuOpen = false;
						onCreateBot();
					}}
				>
					<Icon name="bot" />
					<span class="sheet-item-label">{t.sidebar.addBot}</span>
				</button>
				{/if}
				{#if onCreateGroup}
				<button
					type="button"
					class="fab-menu-item sheet-item"
					role="menuitem"
					onclick={() => {
						createMenuOpen = false;
						onCreateGroup();
					}}
				>
					<Icon name="users" />
					<span class="sheet-item-label">{t.sidebar.addGroup}</span>
				</button>
				{/if}
				{#if onNewProject}
					<button
						type="button"
						class="fab-menu-item sheet-item"
						role="menuitem"
						data-project-add="new"
						onclick={() => {
							createMenuOpen = false;
							onNewProject();
						}}
					>
						<Icon name="folder" />
						<span class="sheet-item-label">{t.project.newInFolder}</span>
					</button>
				{/if}
				{#if onImportProject}
					<button
						type="button"
						class="fab-menu-item sheet-item"
						role="menuitem"
						data-project-add="import"
						onclick={() => {
							createMenuOpen = false;
							onImportProject();
						}}
					>
						<Icon name="file-down" />
						<span class="sheet-item-label">{t.project.importSession}</span>
					</button>
				{/if}
			</div>
		</BottomSheet>
	{/if}
	<button
		type="button"
		class="fab"
		class:is-open={createMenuOpen}
		aria-haspopup="menu"
		aria-expanded={createMenuOpen}
		aria-label={t.sidebar.createMenu}
		title={t.sidebar.createMenu}
		onclick={() => (createMenuOpen = !createMenuOpen)}
	>
		<Icon name="plus" size={24} />
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
		bottom: calc(60px + env(safe-area-inset-bottom) + 16px);
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

	.fab-menu-item :global(.icon) {
		color: var(--muted);
	}
</style>
