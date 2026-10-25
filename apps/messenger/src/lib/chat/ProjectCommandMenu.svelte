<script lang="ts">
	import type { ClaudeCodeCommand } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { ProjectCommandsState } from './project-commands.svelte.ts';

	/**
	 * What typing `/` in a project session's composer offers (ADR 0098): the agent's commands and
	 * skills whose names fit what you typed — Claude Code's as its own `/` lists them, Codex's the
	 * ones the app carries out for it and its skills (ADR 0099) — above the composer the way the
	 * @ list sits above a Bot's. The composer keeps the keys: ↑↓ move, Tab fills the command in, Enter
	 * runs it, Esc closes; a click fills it in.
	 */
	type Props = {
		t: Copy;
		/** Whose commands they are, as the session names its agent. */
		agentName: string;
		id: string;
		status: ProjectCommandsState | null;
		matches: ClaudeCodeCommand[];
		active: number;
		onHover: (index: number) => void;
		onPick: (command: ClaudeCodeCommand) => void;
	};

	let { t, agentName, id, status, matches, active, onHover, onPick }: Props = $props();

	let list = $state<HTMLElement | null>(null);

	// The row the keys are on stays in view.
	$effect(() => {
		void active;
		void matches;
		list?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
	});
</script>

<div class="command-menu" data-project-commands role="presentation" onmousedown={(event) => event.preventDefault()}>
	{#if status === 'loading' || status === null}
		<p class="command-note" role="status">{t.project.commandsLoading}</p>
	{:else if status === 'failed'}
		<p class="command-note" role="status">{t.project.commandsFailed(agentName)}</p>
	{:else if matches.length === 0}
		<p class="command-note" role="status">{t.project.commandsNone(agentName)}</p>
	{:else}
		<div class="command-list" bind:this={list} {id} role="listbox" aria-label={t.project.commandsLabel(agentName)}>
			{#each matches as command, index (command.name)}
				<button
					type="button"
					id={`${id}-${index}`}
					role="option"
					aria-selected={index === active}
					class="command-row"
					class:is-active={index === active}
					title={command.description}
					onmouseenter={() => onHover(index)}
					onclick={() => onPick(command)}
				>
					<span class="command-name mono">/{command.name}</span>
					{#if command.argument_hint}<span class="command-hint mono">{command.argument_hint}</span>{/if}
					<span class="command-desc">{command.description}</span>
				</button>
			{/each}
		</div>
		<div class="command-keys" aria-hidden="true">
			<span class="key">↑↓</span>{t.project.commandKeys.move}<span class="key">Tab</span>{t.project.commandKeys.fill}<span class="key">Enter</span>{t.project.commandKeys.run}<span class="key">Esc</span>{t.project.commandKeys.close}
		</div>
	{/if}
</div>

<style>
	/* Above the composer, as the @ list sits above a Bot's: the same card, the same rows. */
	.command-menu {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 0;
		width: min(520px, 100%);
		display: flex;
		flex-direction: column;
		padding: 6px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-menu);
		transform-origin: bottom left;
		animation: command-menu-in var(--dur-base) var(--ease-out);
		z-index: 100;
		box-sizing: border-box;
	}

	.command-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 260px;
		overflow-y: auto;
	}

	.command-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 7px 10px;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		transition: background-color 0.12s ease;
	}

	.command-row:hover,
	.command-row.is-active {
		background: var(--accent-tint);
	}

	.command-name {
		flex-shrink: 0;
		font-size: 13px;
		font-weight: 600;
	}

	.command-row.is-active .command-name {
		color: var(--accent);
	}

	.command-hint {
		flex-shrink: 0;
		max-width: 30%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	/* One line of what it does; the whole of it is the row's title. */
	.command-desc {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.command-note {
		margin: 0;
		padding: 8px 10px;
		font-size: 12px;
		color: var(--muted);
	}

	.command-keys {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		padding: 6px 10px 4px;
		border-top: 1px solid var(--line-subtle);
		font-size: var(--text-micro);
		color: var(--muted);
	}

	.command-keys .key {
		padding: 0 5px;
		border-radius: var(--radius-xs);
		background: var(--pane);
		box-shadow: inset 0 0 0 1px var(--line), 0 1px 0 var(--line);
		font-family: var(--mono);
		line-height: 17px;
	}

	.command-keys .key:not(:first-child) {
		margin-left: 6px;
	}

	@keyframes command-menu-in {
		from {
			opacity: 0;
			transform: translateY(4px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.command-menu {
			animation: none;
		}
	}

	/* A touch screen has no keys to point at, and a description to read beats one cut short. */
	@media (pointer: coarse) {
		.command-keys {
			display: none;
		}

		.command-row {
			flex-wrap: wrap;
			padding: 9px 10px;
		}

		.command-desc {
			flex-basis: 100%;
			white-space: normal;
			display: -webkit-box;
			line-clamp: 2;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
		}
	}
</style>
