<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { Memory, Skill } from '@real-bot/protocol';

	type Tab = 'basics' | 'skills' | 'routines' | 'memory' | 'actions';

	type Props = {
		t: Copy;
		activeTab: Tab;
		basicsHasError: boolean;
		profileSkills: readonly Skill[];
		routineCount: number;
		profileMemories: readonly Memory[];
		switchTab: (tab: Tab) => void;
	};

	let { t, activeTab, basicsHasError, profileSkills, routineCount, profileMemories, switchTab }: Props = $props();
</script>

<div class="bot-tabs" role="tablist" aria-label={t.detail.titleBot}>
	<button
		type="button"
		role="tab"
		aria-selected={activeTab === 'basics'}
		class="bot-tab-btn"
		class:is-active={activeTab === 'basics'}
		onclick={() => switchTab('basics')}
	>
		<Icon name="user" filled={activeTab === 'basics'} class="tab-icon" />
		<span class="tab-name">{t.detail.botTabBasics}</span>
		{#if basicsHasError}
			<span class="tab-badge-error" aria-label="error">!</span>
		{/if}
		<span class="tab-chevron" aria-hidden="true"></span>
	</button>

	<button
		type="button"
		role="tab"
		aria-selected={activeTab === 'skills'}
		class="bot-tab-btn"
		class:is-active={activeTab === 'skills'}
		onclick={() => switchTab('skills')}
	>
		<Icon name="zap" filled={activeTab === 'skills'} class="tab-icon" />
		<span class="tab-name">{t.detail.botTabSkills}</span>
		{#if profileSkills.length > 0}
			<span class="tab-count">{profileSkills.length}</span>
		{/if}
		<span class="tab-chevron" aria-hidden="true"></span>
	</button>

	<button
		type="button"
		role="tab"
		aria-selected={activeTab === 'routines'}
		class="bot-tab-btn"
		class:is-active={activeTab === 'routines'}
		onclick={() => switchTab('routines')}
	>
		<Icon name="calendar" filled={activeTab === 'routines'} class="tab-icon" />
		<span class="tab-name">{t.detail.botTabRoutines}</span>
		{#if routineCount > 0}
			<span class="tab-count">{routineCount}</span>
		{/if}
		<span class="tab-chevron" aria-hidden="true"></span>
	</button>

	<button
		type="button"
		role="tab"
		aria-selected={activeTab === 'memory'}
		class="bot-tab-btn"
		class:is-active={activeTab === 'memory'}
		onclick={() => switchTab('memory')}
	>
		<Icon name="book" filled={activeTab === 'memory'} class="tab-icon" />
		<span class="tab-name">{t.detail.botTabMemory}</span>
		{#if profileMemories.length > 0}
			<span class="tab-count">{profileMemories.length}</span>
		{/if}
		<span class="tab-chevron" aria-hidden="true"></span>
	</button>

	<button
		type="button"
		role="tab"
		aria-selected={activeTab === 'actions'}
		class="bot-tab-btn"
		class:is-active={activeTab === 'actions'}
		onclick={() => switchTab('actions')}
	>
		<Icon name="settings" filled={activeTab === 'actions'} class="tab-icon" />
		<span class="tab-name">{t.detail.botTabActions}</span>
		<span class="tab-chevron" aria-hidden="true"></span>
	</button>
</div>

<style>
	.bot-tabs {
		display: flex;
		align-items: stretch;
		width: 100%;
		gap: 0;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
		box-sizing: border-box;
	}

	.bot-tab-btn {
		flex: 1 1 0;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-height: 40px;
		padding: 10px 4px 8px;
		border-radius: 0;
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		cursor: pointer;
		white-space: nowrap;
		transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
		line-height: 1.2;
		box-sizing: border-box;
	}

	.bot-tab-btn:hover {
		color: var(--ink);
		background: var(--row-hover);
	}

	.bot-tab-btn.is-active {
		color: var(--accent);
		font-weight: 600;
		background: transparent;
		border-bottom-color: var(--accent);
		box-shadow: none;
	}

	.bot-tab-btn :global(.tab-icon) {
		color: var(--muted);
		flex-shrink: 0;
		transition: color 0.15s ease;
	}

	.bot-tab-btn.is-active :global(.tab-icon) {
		color: var(--accent);
	}

	.bot-tab-btn .tab-badge-error {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: var(--radius-full);
		background: var(--danger);
		color: var(--on-danger);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		margin-left: 2px;
	}

	/* Phone rows draw this; the wider tab strip does not. */
	.tab-chevron {
		display: none;
	}

	.bot-tab-btn .tab-count {
		font-size: 11px;
		font-weight: 600;
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		line-height: 15px;
	}

	.bot-tab-btn.is-active .tab-count {
		background: var(--line-subtle);
		color: var(--ink);
	}

	@media (max-width: 680px) {
		.bot-tabs {
			flex-direction: column;
			align-items: stretch;
			gap: 0;
			padding: 0;
			background: transparent;
			border: 0;
			border-radius: var(--radius-lg);
			overflow: hidden;
		}

		.bot-tab-btn {
			position: relative;
			flex: none;
			justify-content: flex-start;
			gap: 10px;
			min-height: 54px;
			padding: 0 14px;
			margin-bottom: 0;
			border-radius: 0;
			border-bottom: 0;
			background: var(--pane);
			font-size: 15px;
			font-weight: 500;
			color: var(--ink);
		}

		.bot-tab-btn + .bot-tab-btn::before {
			content: '';
			position: absolute;
			left: 44px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line);
		}

		/* The chevron says the row opens a screen; the active tint belongs to the wider layout. */
		.bot-tab-btn .tab-chevron {
			display: block;
			width: 8px;
			height: 8px;
			border-top: 1.8px solid var(--muted);
			border-right: 1.8px solid var(--muted);
			transform: rotate(45deg);
			margin-left: 8px;
			flex-shrink: 0;
		}

		.bot-tab-btn.is-active,
		.bot-tab-btn:hover {
			background: var(--pane);
			box-shadow: none;
			font-weight: 500;
			color: var(--ink);
		}

		.bot-tab-btn:active {
			background: var(--row-hover);
		}

		.bot-tab-btn :global(.tab-icon),
		.bot-tab-btn.is-active :global(.tab-icon) {
			width: 20px;
			height: 20px;
			color: var(--muted);
		}

		/*
		 * The name takes the leftover room, so a count or an error mark lands against the chevron.
		 * Two auto margins (the badge and a ::after chevron) used to split that room and park the
		 * number in the middle of the row.
		 */
		.bot-tab-btn .tab-name {
			flex: 1;
			min-width: 0;
			text-align: left;
		}

		.bot-tab-btn .tab-count,
		.bot-tab-btn .tab-badge-error {
			margin-left: 8px;
			flex-shrink: 0;
		}
	}
</style>
