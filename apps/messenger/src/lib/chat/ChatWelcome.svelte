<script lang="ts">
	/** What an empty conversation shows: the file drop, the Bot of a direct with its starters, or the conversation's name. */
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { SessionGroup } from '../sidebar/session-groups.ts';
	import { getStarterOptions, handOffStarter } from './starter-prompts.ts';
	import BrandMark from '../BrandMark.svelte';

	type Props = {
		t: Copy;
		selected: SessionSummary;
		selectedKind: SessionGroup | null;
		selectedPeerBot: Bot | null;
		locale: 'en' | 'zh';
		fileDrop: boolean;
		lockedComposer: boolean;
		onOpenProfile: (botId: string) => void;
		pickStarterPrompt: (prompt: string) => void;
		titleOf: (session: SessionSummary) => string;
	};

	let {
		t,
		selected,
		selectedKind,
		selectedPeerBot,
		locale,
		fileDrop,
		lockedComposer,
		onOpenProfile,
		pickStarterPrompt,
		titleOf
	}: Props = $props();

	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);

	// The hand-off comes first: the first thing to try is handing work off, not asking a question.
	const starterOptions = $derived(
		selectedPeerBot
			? [
					handOffStarter(locale),
					...getStarterOptions({
						name: selectedPeerBot.name,
						duties: selectedPeerBot.duties,
						boundaries: selectedPeerBot.boundaries,
						locale
					})
				]
			: []
	);
</script>

<div class="empty-chat-welcome m-auto flex flex-col items-center text-center py-16 px-10 max-w-[460px]">
	{#if fileDrop}
		<div class="empty-icon" aria-hidden="true">
			<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
				<polyline points="14 2 14 8 20 8"></polyline>
			</svg>
		</div>
		<h2>{t.sidebar.fileDrop}</h2>
		<p class="muted">{t.sidebar.fileDropEmpty}</p>
	{:else if selectedKind === 'you-bot' && selectedPeerBot}
		{@const pal = botAvatarColor(selectedPeerBot.id)}
		<button
			type="button"
			class="welcome-identity-btn"
			onclick={() => onOpenProfile(selectedPeerBot.id)}
			title={sessionSettingsLabel}
		>
			<span
				class="welcome-avatar"
				style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
			>
				{#if avatarSrc(selectedPeerBot.avatar)}
					<img src={avatarSrc(selectedPeerBot.avatar)} alt={selectedPeerBot.name} class="avatar-img" />
				{:else}
					{rosterLetter(selectedPeerBot.name)}
				{/if}
			</span>
			<span class="welcome-title">{selectedPeerBot.name}</span>
		</button>
		<div class="welcome-badges flex items-center gap-3 mb-6">
			<span class="bot-badge">{t.chat.botBadge}</span>
			{#if selectedPeerBot.model}
				<span class="model-badge mono">{selectedPeerBot.model}</span>
			{/if}
		</div>
		{#if selectedPeerBot.duties}
			<div class="welcome-duties">
				<p class="duties-text m-0 text-13 text-ink-secondary leading-normal text-left">{selectedPeerBot.duties}</p>
			</div>
		{/if}
		{#if starterOptions.length > 0}
			<div class="welcome-starters flex flex-col gap-4 w-full mb-6">
				{#each starterOptions as starter (starter.id)}
					<button
						type="button"
						class="starter-chip"
						class:is-hand-off={starter.id === 'hand-off'}
						disabled={lockedComposer}
						onclick={() => pickStarterPrompt(starter.prompt)}
					>
						<span class="starter-icon" aria-hidden="true">{starter.icon}</span>
						<span class="starter-label">{starter.label}</span>
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="welcome-mark" aria-hidden="true"><BrandMark variant="art" size={64} /></div>
		<h2>{titleOf(selected)}</h2>
	{/if}
	<p class="muted">{t.stream.empty}</p>
</div>

<style>
	/* The file drop's own mark: a file in the accent tint, as on its row in the sidebar. */
	.empty-icon {
		width: 60px;
		height: 60px;
		border-radius: var(--radius-lg);
		background: var(--accent-tint);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		margin-bottom: 14px;
	}

	.welcome-mark {
		margin-bottom: 10px;
	}

	/* A quiet tag beside the name: the accent is kept for what you can act on. */
	.bot-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.2;
	}

	.model-badge {
		font-size: 11px;
		padding: 1px 6px;
		border-radius: var(--radius-xs);
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
	}

	.welcome-identity-btn {
		background: transparent;
		border: none;
		padding: 8px 16px;
		margin: -8px 0 0;
		border-radius: var(--radius-lg);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		transition: background 0.15s ease;
		color: inherit;
		font: inherit;
	}

	.welcome-identity-btn:hover {
		background: var(--line-subtle);
	}

	.welcome-identity-btn:hover .welcome-avatar {
		transform: scale(1.04);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
	}

	.welcome-identity-btn:hover .welcome-title {
		color: var(--accent);
	}

	.welcome-identity-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.welcome-avatar {
		width: 58px;
		height: 58px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		font-size: 24px;
		font-weight: 700;
		border: 2px solid;
		margin-bottom: 10px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}

	.welcome-title {
		margin: 0 0 6px;
		font-size: 18px;
		font-weight: 700;
		color: var(--ink);
		transition: color 0.15s ease;
	}

	.welcome-duties {
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 10px 16px;
		margin-bottom: 14px;
		width: 100%;
	}

	/*
	 * A starter is a card: its icon in a tile, then what it asks. Under the pointer it lifts a
	 * little, the way something you can pick up does; the hand-off, first, is ringed in the accent.
	 */
	.starter-chip {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px 10px 10px;
		border-radius: var(--radius-lg);
		background: var(--pane);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		box-shadow: var(--shadow-xs);
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.starter-icon {
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		display: grid;
		place-items: center;
		background: var(--line-subtle);
		font-size: 16px;
		line-height: 1;
	}

	.starter-label {
		min-width: 0;
		line-height: 1.4;
	}

	.starter-chip.is-hand-off {
		border-color: var(--accent-border);
		box-shadow: 0 0 0 3px var(--accent-glow), var(--shadow-xs);
		font-weight: 600;
	}

	.starter-chip.is-hand-off .starter-icon {
		background: var(--accent-tint);
	}

	.starter-chip:hover:not(:disabled) {
		border-color: var(--accent-border);
		box-shadow: var(--shadow-md);
		transform: translateY(-2px);
	}

	.starter-chip:active:not(:disabled) {
		transform: translateY(0) scale(0.99);
		transition-duration: var(--dur-fast);
	}

	.starter-chip:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.starter-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		transform: none;
		box-shadow: none;
		border-color: var(--line);
		background: var(--pane);
		color: var(--ink-secondary);
	}
</style>
